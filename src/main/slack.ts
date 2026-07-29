// ═══════════════════════════════════════════
//  Slack API Integration
//  Connects to Slack via Bot/User token for
//  conversations, messages, threads, search
// ═══════════════════════════════════════════

import {
  getStoredUserToken,
  setStoredUserToken,
  clearStoredUserToken,
  getOAuthCredentials,
  setOAuthCredentials,
  hasOAuthCredentials,
} from './slack-config'
import { runSlackOAuth } from './slack-oauth'

const SLACK_API = 'https://slack.com/api'
const USER_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const SYSTEM_SUBTYPES = new Set(['channel_join','channel_leave','channel_purpose','channel_topic','channel_name','pinned_item','tombstone','message_replied','message_changed','message_deleted'])

// ── Token resolution ──
// Priority: stored user token (from in-app Connect flow) → env var user token → env var bot token.
// Stored first so the user can override a stale env-var bot token without touching ~/.zshrc.

export function getToken(): string {
  const stored = getStoredUserToken()
  if (stored) return stored
  const token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN || ''
  if (!token) console.warn('[slack] No stored token, SLACK_USER_TOKEN, or SLACK_BOT_TOKEN set')
  return token
}

function isUserToken(): boolean {
  const token = getToken()
  return token.startsWith('xoxp-') || token.startsWith('xoxe-') || token.startsWith('xoxe.')
}

// ── Types ──

export interface SlackChannel {
  id: string
  name: string
  isIm: boolean
  isMpim: boolean
  isChannel: boolean
  isPrivate: boolean
  userId?: string
  topic?: string
  purpose?: string
  unreadCount?: number
  lastMessage?: SlackMessage
  displayName?: string
  avatarUrl?: string
}

export interface SlackMessage {
  ts: string
  threadTs?: string
  channelId: string
  userId: string
  text: string
  userName?: string
  userAvatar?: string
  date: string
  isUnread: boolean
  replyCount?: number
  reactions?: { name: string; count: number; users: string[] }[]
  attachments?: SlackAttachment[]
  files?: SlackFile[]
  edited?: boolean
  channelName?: string
  channelIsIm?: boolean
  channelIsMpim?: boolean
}

export interface SlackAttachment {
  title?: string
  text?: string
  imageUrl?: string
  thumbUrl?: string
}

export interface SlackFile {
  id: string
  name: string
  title: string
  mimeType: string
  size: number
  url: string
  thumbUrl?: string
}

export interface SlackUser {
  id: string
  name: string
  realName: string
  displayName: string
  avatar: string
  isBot: boolean
}

// ── User cache ──

interface CachedUser {
  user: SlackUser
  expiresAt: number
}

const userCache = new Map<string, CachedUser>()

// ── MPIM member name cache ──

interface CachedMpimNames {
  displayName: string
  expiresAt: number
}
const mpimCache = new Map<string, CachedMpimNames>()

// ── DM channel-to-user-ID cache (module-level, populated by slackListConversations) ──
// Maps channel ID (D…) → user ID (U…) so slackSearchMessages can resolve DM names
// without a cold conversations.members call for channels already loaded in the session.
const dmChannelUserIdCache = new Map<string, string>()

// ── DM channel-to-display-name cache ──
// Maps channel ID (D…) → resolved display name, survives across search calls where
// the users Map is rebuilt fresh and dmChannelUserMap is local to slackSearchMessages.
const dmChannelDisplayNameCache = new Map<string, string>()

// ── Bot name cache ──

const botNameCache = new Map<string, string>()

// ── Thread root reply-count cache ──
// Avoids a redundant conversations.replies fetch on every incremental thread poll
const rootReplyCountCache = new Map<string, number>()
function setRootReplyCount(key: string, count: number) {
  rootReplyCountCache.set(key, count)
  if (rootReplyCountCache.size > 500) rootReplyCountCache.delete(rootReplyCountCache.keys().next().value!)
}

async function resolveBotName(botId: string): Promise<string> {
  const cached = botNameCache.get(botId)
  if (cached) return cached
  // A-prefix IDs are app/integration user IDs, not bot IDs — bots.info rejects them
  if (botId.startsWith('A')) {
    botNameCache.set(botId, 'App')
    return 'App'
  }
  try {
    const data = await slackApiGet('bots.info', { bot: botId })
    const name: string = data.bot?.name || 'Bot'
    botNameCache.set(botId, name)
    return name
  } catch {
    return 'Bot'
  }
}

async function resolveBotNames(messages: SlackMessage[]): Promise<void> {
  const botIds = Array.from(new Set<string>(
    messages
      .filter(m => m.userId.startsWith('B') && (!m.userName || m.userName === 'Bot'))
      .map(m => m.userId)
      .filter(Boolean)
  ))
  if (botIds.length === 0) return
  const resolved = await Promise.all(botIds.map(id => resolveBotName(id).then(name => ({ id, name }))))
  const nameMap = new Map(resolved.map(r => [r.id, r.name]))
  for (const msg of messages) {
    if (msg.userId.startsWith('B') && (!msg.userName || msg.userName === 'Bot')) {
      const name = nameMap.get(msg.userId)
      if (name) msg.userName = name
    }
  }
}

// ── Current-user cache ──

let cachedCurrentUserId: string | null = null

async function getCurrentUserId(): Promise<string | null> {
  if (cachedCurrentUserId) return cachedCurrentUserId
  try {
    const data = await slackApiGet('auth.test')
    cachedCurrentUserId = data.user_id ?? null
    return cachedCurrentUserId
  } catch {
    return null
  }
}

function getCachedUser(userId: string): SlackUser | null {
  const entry = userCache.get(userId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    userCache.delete(userId)
    return null
  }
  return entry.user
}

function setCachedUser(user: SlackUser): void {
  userCache.set(user.id, {
    user,
    expiresAt: Date.now() + USER_CACHE_TTL,
  })
}

// ── Timestamp helpers ──

function tsToIso(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString()
}

// ── Core API caller ──

async function slackApi(method: string, params: Record<string, any> = {}): Promise<any> {
  const token = getToken()
  if (!token) throw new Error('[slack] No token configured')

  const url = `${SLACK_API}/${method}`
  const body = JSON.stringify(params)

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body,
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) {
    throw new Error(`[slack] HTTP ${resp.status} from ${method}`)
  }

  const data = await resp.json()
  const NON_FATAL = new Set(['already_reacted', 'not_reacted'])
  if (!data.ok && !NON_FATAL.has(data.error)) {
    throw new Error(`[slack] API error from ${method}: ${data.error}`)
  }
  return data
}

// GET-style API caller (for methods that use query params like conversations.list)
async function slackApiGet(method: string, params: Record<string, string> = {}): Promise<any> {
  const token = getToken()
  if (!token) throw new Error('[slack] No token configured')

  const query = new URLSearchParams(params).toString()
  const url = `${SLACK_API}/${method}${query ? `?${query}` : ''}`

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) {
    throw new Error(`[slack] HTTP ${resp.status} from ${method}`)
  }

  const data = await resp.json()
  if (!data.ok) {
    throw new Error(`[slack] API error from ${method}: ${data.error}`)
  }

  return data
}

// ── Parsing helpers ──

function parseMessage(raw: any, channelId: string): SlackMessage {
  return {
    ts: raw.ts,
    threadTs: raw.thread_ts || undefined,
    channelId,
    userId: raw.user || raw.bot_id || raw.app_id || (raw.username ? `webhook-${raw.username}` : 'system'),
    // For bot messages, prefer raw.username, then bot_profile.name, then leave undefined
    userName: raw.username || raw.bot_profile?.name || (raw.bot_id ? 'Bot' : undefined) || (raw.app_id ? 'App' : undefined) || (!raw.user ? 'Slack' : undefined),
    text: raw.text || '',
    date: tsToIso(raw.ts),
    isUnread: false, // per-message unread not tracked; channel-level badges use unread_count_display
    replyCount: raw.reply_count ?? undefined,
    reactions: raw.reactions?.map((r: any) => ({
      name: r.name,
      count: r.count,
      users: r.users || [],
    })),
    attachments: raw.attachments?.map((a: any) => ({
      title: a.title,
      text: a.text,
      imageUrl: a.image_url,
      thumbUrl: a.thumb_url,
    })),
    files: raw.files?.map((f: any) => ({
      id: f.id,
      name: f.name,
      title: f.title,
      mimeType: f.mimetype || '',
      size: f.size || 0,
      url: f.url_private_download || f.url_private || '',
      thumbUrl: f.thumb_360 || f.thumb_80 || undefined,
    })),
    edited: !!raw.edited,
  }
}

function parseChannel(raw: any): SlackChannel {
  return {
    id: raw.id,
    name: raw.name || raw.name_normalized || '',
    isIm: !!raw.is_im,
    isMpim: !!raw.is_mpim,
    isChannel: !!raw.is_channel || !!raw.is_group,
    isPrivate: !!raw.is_private || !!raw.is_group,
    userId: raw.user || undefined,
    topic: raw.topic?.value || undefined,
    purpose: raw.purpose?.value || undefined,
    unreadCount: raw.unread_count_display ?? raw.unread_count ?? undefined,
    lastMessage: raw.latest ? {
      ts: raw.latest.ts,
      channelId: raw.id,
      userId: raw.latest.user || raw.latest.bot_id || '',
      text: raw.latest.text || '',
      date: tsToIso(raw.latest.ts),
      isUnread: false,
    } : undefined,
  }
}

// ── Exported functions ──

export async function slackListConversations(opts?: {
  types?: string
  limit?: number
  cursor?: string
  pollMode?: boolean
}): Promise<{ channels: SlackChannel[]; nextCursor?: string; userMap: Record<string, string> }> {
  const types = opts?.types || 'im,mpim,public_channel,private_channel'
  const limit = String(opts?.limit || 200)

  const params: Record<string, string> = { types, limit, exclude_archived: 'true' }
  if (opts?.cursor) params.cursor = opts.cursor
  const data = await slackApiGet('conversations.list', params)
  const nextCursor: string | undefined = data.response_metadata?.next_cursor || undefined

  const rawChannels: SlackChannel[] = ((data.channels || []) as any[]).map((raw: any) => parseChannel(raw))

  // Resolve DM display names in parallel
  const dmChannels = rawChannels.filter(ch => ch.isIm && ch.userId)
  const dmUserIds = dmChannels.map(ch => ch.userId!)
  const resolvedUserMap: Record<string, string> = {}
  if (dmUserIds.length > 0) {
    const dmUsers = await slackGetUsers(dmUserIds)
    for (const ch of dmChannels) {
      const user = dmUsers.get(ch.userId!)
      if (user) {
        const name = user.displayName || user.realName || user.name
        ch.displayName = name
        ch.name = ch.displayName
        ch.avatarUrl = user.avatar
        resolvedUserMap[ch.userId!] = name
      } else {
        ch.displayName = 'Direct Message'
        ch.name = ch.displayName
      }
      // Persist channel-id → user-id so slackSearchMessages can skip cold API calls
      dmChannelUserIdCache.set(ch.id, ch.userId!)
    }
  }

  // Resolve MPIM display names by fetching member lists (cached to avoid per-poll API calls)
  const pollMode = opts?.pollMode ?? false
  const mpimChannels = rawChannels.filter(ch => ch.isMpim)
  if (mpimChannels.length > 0) {
    await Promise.all(mpimChannels.map(async (ch) => {
      const cached = mpimCache.get(ch.id)
      if (cached && (Date.now() <= cached.expiresAt || pollMode)) {
        ch.displayName = cached.displayName
        ch.name = ch.displayName
        return
      }
      if (pollMode) {
        // Parse mpdm slug via warm userCache — zero additional API calls
        if (ch.name && ch.name.startsWith('mpdm-')) {
          const slug = ch.name.replace(/^mpdm-/, '').replace(/-\d+$/, '')
          const slugUsernames = slug.split('--')
          const resolvedNames: string[] = []
          for (const [, entry] of userCache) {
            if (Date.now() <= entry.expiresAt && slugUsernames.includes(entry.user.name)) {
              resolvedNames.push(entry.user.displayName || entry.user.realName || entry.user.name)
            }
          }
          if (resolvedNames.length > 0) {
            ch.displayName = resolvedNames.join(', ')
            ch.name = ch.displayName
            return
          }
          // Slug resolution failed — fall through to conversations.members API call
        } else {
          return
        }
      }
      try {
        const membersData = await slackApiGet('conversations.members', { channel: ch.id, limit: '20' })
        const allMemberIds = (membersData.members || []) as string[]
        const selfId = await getCurrentUserId()
        const memberIds = selfId ? allMemberIds.filter(id => id !== selfId) : allMemberIds
        if (memberIds.length > 0) {
          const memberUsers = await slackGetUsers(memberIds)
          const names = memberIds
            .map(id => memberUsers.get(id))
            .filter((u): u is SlackUser => !!u)
            .map(u => u.displayName || u.realName || u.name)
            .filter(Boolean)
          for (const id of memberIds) {
            const user = memberUsers.get(id)
            if (user) resolvedUserMap[id] = user.displayName || user.realName || user.name
          }
          if (names.length > 0) {
            ch.displayName = names.join(', ')
            ch.name = ch.displayName
            mpimCache.set(ch.id, { displayName: ch.displayName, expiresAt: Date.now() + USER_CACHE_TTL })
          } else {
            ch.displayName = 'Group DM'
            ch.name = ch.displayName
            mpimCache.set(ch.id, { displayName: 'Group DM', expiresAt: Date.now() + USER_CACHE_TTL })
          }
        }
      } catch (e) {
        console.warn(`[slack] Failed to resolve MPIM members for ${ch.id}:`, e)
        ch.displayName = 'Group DM'
        ch.name = ch.displayName
        mpimCache.set(ch.id, { displayName: 'Group DM', expiresAt: Date.now() + USER_CACHE_TTL })
      }
    }))
  }

  return { channels: rawChannels, nextCursor, userMap: resolvedUserMap }
}

export async function slackListMessages(channelId: string, opts?: {
  limit?: number
  cursor?: string
  oldest?: string
  latest?: string
}): Promise<{ messages: SlackMessage[]; nextCursor?: string; hasMore: boolean; userMap: Record<string, string> }> {
  const params: Record<string, string> = {
    channel: channelId,
    limit: String(opts?.limit || 50),
    include_all_metadata: 'true',
  }
  if (opts?.cursor) params.cursor = opts.cursor
  if (opts?.oldest) params.oldest = opts.oldest
  if (opts?.latest) params.latest = opts.latest

  const data = await slackApiGet('conversations.history', params)

  const messages = (data.messages || [])
    .map((raw: any) => raw.subtype === 'message_changed' && raw.message ? { ...raw.message, subtype: undefined } : raw)
    .filter((raw: any) => !raw.subtype || !SYSTEM_SUBTYPES.has(raw.subtype))
    .map((raw: any) => parseMessage(raw, channelId))

  // Bulk-resolve user names — only real user IDs (starting with 'U'); skip bots, apps, and webhook-synthesized IDs
  const authorIds = Array.from(new Set<string>(
    messages.map((m: SlackMessage) => m.userId).filter((id: string) => id && (id.startsWith('U') || id.startsWith('W')))
  ))
  // Also collect user IDs mentioned in message text and attachment text
  const mentionedIds = new Set<string>()
  const mentionedBotIds = new Set<string>() // B-prefixed bot IDs only
  const appLabelMap = new Map<string, string>() // A-prefixed app IDs: id -> inline label
  for (const msg of messages) {
    let m
    const re = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
    while ((m = re.exec(msg.text)) !== null) {
      const [, id, label] = m
      if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
      else if (id.startsWith('B')) mentionedBotIds.add(id)
      else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
    }
    for (const att of msg.attachments || []) {
      if (att.text) {
        const re2 = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
        while ((m = re2.exec(att.text)) !== null) {
          const [, id, label] = m
          if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
          else if (id.startsWith('B')) mentionedBotIds.add(id)
          else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
        }
      }
      if (att.title) {
        const reTtl = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
        while ((m = reTtl.exec(att.title)) !== null) {
          const [, id, label] = m
          if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
          else if (id.startsWith('B')) mentionedBotIds.add(id)
          else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
        }
      }
    }
  }
  const allIds = Array.from(new Set([...authorIds, ...Array.from(mentionedIds)]))
  const users = allIds.length > 0 ? await slackGetUsers(allIds) : new Map<string, SlackUser>()

  for (const msg of messages) {
    const user = users.get(msg.userId)
    if (user) {
      msg.userName = user.displayName || user.realName
      msg.userAvatar = user.avatar
    } else if (!msg.userName) {
      msg.userName = msg.userId.startsWith('A') ? 'App' : 'Unknown User'
    }
  }

  await resolveBotNames(messages)

  // Resolve A-prefix app author IDs still showing as 'App' via bots.info or inline label
  const unnamedAppIds = Array.from(new Set<string>(
    messages
      .filter((m: SlackMessage) => m.userId.startsWith('A') && (!m.userName || m.userName === 'App'))
      .map((m: SlackMessage) => m.userId)
  ))
  if (unnamedAppIds.length > 0) {
    const resolved = await Promise.all(
      unnamedAppIds.map((id: string) =>
        appLabelMap.has(id)
          ? Promise.resolve({ id, name: appLabelMap.get(id)! })
          : resolveBotName(id).then(name => ({ id, name }))
      )
    )
    const appNameMap = new Map(resolved.map(r => [r.id, r.name]))
    for (const msg of messages) {
      if (msg.userId.startsWith('A') && (!msg.userName || msg.userName === 'App')) {
        const name = appNameMap.get(msg.userId)
        if (name) msg.userName = name
      }
    }
  }

  const nextCursor = data.response_metadata?.next_cursor || undefined
  const userMap: Record<string, string> = {}
  for (const [id, user] of users) {
    userMap[id] = user.displayName || user.realName || id
  }
  if (mentionedBotIds.size > 0) {
    const botNames = await Promise.all(Array.from(mentionedBotIds).map(id => resolveBotName(id).then(name => ({ id, name }))))
    for (const { id, name } of botNames) userMap[id] = name
  }
  for (const [id, label] of appLabelMap) userMap[id] = label
  for (const id of allIds) { if (!userMap[id]) userMap[id] = 'Unknown User' }
  return {
    messages,
    nextCursor: nextCursor || undefined,
    hasMore: data.has_more || false,
    userMap,
  }
}

export async function slackGetThread(channelId: string, threadTs: string, opts?: { silent?: boolean; oldest?: string }): Promise<{ messages: SlackMessage[]; userMap: Record<string, string>; truncated: boolean; rootReplyCount?: number }> {
  const allRaw: any[] = []
  let cursor: string | undefined
  // Incremental fetch (oldest set) only needs 1 page; silent full-fetch caps at 3; normal fetch at 5
  const MAX_PAGES = opts?.oldest ? 1 : (opts?.silent ? 3 : 5)
  let page = 0

  do {
    const params: Record<string, string> = {
      channel: channelId,
      ts: threadTs,
      limit: '200',
      include_all_metadata: 'true',
    }
    if (cursor) params.cursor = cursor
    if (opts?.oldest) params.oldest = opts.oldest
    const data = await slackApiGet('conversations.replies', params)
    allRaw.push(...(data.messages || []))
    cursor = data.has_more ? (data.response_metadata?.next_cursor || undefined) : undefined
    page++
  } while (cursor && page < MAX_PAGES)

  const truncated = !!cursor
  // If an incremental fetch was truncated (>200 new replies), fall back to a full thread load
  if (opts?.oldest && truncated) {
    return await slackGetThread(channelId, threadTs, { silent: opts.silent })
  }
  // Capture the root's reply count before filtering — only the root message has reply_count set by Slack
  // For incremental fetches (opts.oldest), the root is excluded from allRaw; use cache or fetch once with limit=1
  const threadCacheKey = `${channelId}:${threadTs}`
  let rootReplyCount: number | undefined = allRaw[0]?.ts === threadTs ? (allRaw[0]?.reply_count ?? undefined) : undefined
  if (rootReplyCount !== undefined) {
    setRootReplyCount(threadCacheKey, rootReplyCount)
  } else if (opts?.oldest) {
    const cached = rootReplyCountCache.get(threadCacheKey)
    if (cached !== undefined) {
      rootReplyCount = cached
    } else {
      try {
        const rootData = await slackApiGet('conversations.replies', { channel: channelId, ts: threadTs, limit: '1' })
        rootReplyCount = rootData.messages?.[0]?.reply_count ?? undefined
        if (rootReplyCount !== undefined) setRootReplyCount(threadCacheKey, rootReplyCount)
      } catch {
        // ignore — rootReplyCount stays undefined
      }
    }
  }
  // Slack always returns the thread root as the first item; skip it for incremental fetches
  const rawToProcess = opts?.oldest ? allRaw.filter((raw: any) => raw.ts !== threadTs && !!raw.thread_ts) : allRaw
  // Tombstone root (deleted message) becomes a placeholder so thread position stays correct
  const rawWithPlaceholders = rawToProcess.map((raw: any) => {
    if (raw.subtype === 'tombstone') return { ...raw, subtype: undefined, text: '(message deleted)', user: raw.user || '' }
    if (raw.subtype === 'message_changed' && raw.message) return { ...raw.message, subtype: undefined }
    return raw
  })
  const messages = rawWithPlaceholders.filter((raw: any) => !raw.subtype || !SYSTEM_SUBTYPES.has(raw.subtype)).map((raw: any) => parseMessage(raw, channelId))
  // For full fetches where Slack omitted reply_count, derive from the messages we have (root + replies)
  if (rootReplyCount === undefined && !opts?.oldest) {
    rootReplyCount = Math.max(0, messages.length - 1)
  }

  // Bulk-resolve user names — only real user IDs (starting with 'U'); skip bots, apps, and webhook-synthesized IDs
  const authorIdSet = new Set<string>(
    messages.map((m: SlackMessage) => m.userId).filter((id: string) => id && (id.startsWith('U') || id.startsWith('W')))
  )
  // For incremental fetches the root is excluded from rawToProcess; include its author so they resolve on first render
  if (opts?.oldest && allRaw[0]?.ts === threadTs && typeof allRaw[0]?.user === 'string' && allRaw[0].user.startsWith('U')) {
    authorIdSet.add(allRaw[0].user)
  }
  const authorIds = Array.from(authorIdSet)
  // Also collect user IDs mentioned in message text and attachment text
  const mentionedIds = new Set<string>()
  const mentionedBotIds = new Set<string>() // B-prefixed bot IDs only
  const appLabelMap = new Map<string, string>() // A-prefixed app IDs: id -> inline label
  for (const msg of messages) {
    let m
    const re = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
    while ((m = re.exec(msg.text)) !== null) {
      const [, id, label] = m
      if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
      else if (id.startsWith('B')) mentionedBotIds.add(id)
      else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
    }
    for (const att of msg.attachments || []) {
      if (att.text) {
        const re2 = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
        while ((m = re2.exec(att.text)) !== null) {
          const [, id, label] = m
          if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
          else if (id.startsWith('B')) mentionedBotIds.add(id)
          else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
        }
      }
      if (att.title) {
        const reTtl = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
        while ((m = reTtl.exec(att.title)) !== null) {
          const [, id, label] = m
          if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
          else if (id.startsWith('B')) mentionedBotIds.add(id)
          else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
        }
      }
    }
  }
  const allIds = Array.from(new Set([...authorIds, ...Array.from(mentionedIds)]))
  const users = allIds.length > 0 ? await slackGetUsers(allIds) : new Map<string, SlackUser>()

  for (const msg of messages) {
    const user = users.get(msg.userId)
    if (user) {
      msg.userName = user.displayName || user.realName
      msg.userAvatar = user.avatar
    } else if (!msg.userName) {
      msg.userName = msg.userId.startsWith('A') ? 'App' : 'Unknown User'
    }
  }

  await resolveBotNames(messages)

  // Resolve A-prefix app author IDs still showing as 'App' via bots.info or inline label
  const unnamedAppIds = Array.from(new Set<string>(
    messages
      .filter((m: SlackMessage) => m.userId.startsWith('A') && (!m.userName || m.userName === 'App'))
      .map((m: SlackMessage) => m.userId)
  ))
  if (unnamedAppIds.length > 0) {
    const resolved = await Promise.all(
      unnamedAppIds.map((id: string) =>
        appLabelMap.has(id)
          ? Promise.resolve({ id, name: appLabelMap.get(id)! })
          : resolveBotName(id).then(name => ({ id, name }))
      )
    )
    const appNameMap = new Map(resolved.map(r => [r.id, r.name]))
    for (const msg of messages) {
      if (msg.userId.startsWith('A') && (!msg.userName || msg.userName === 'App')) {
        const name = appNameMap.get(msg.userId)
        if (name) msg.userName = name
      }
    }
  }

  const userMap: Record<string, string> = {}
  for (const [id, user] of users) {
    userMap[id] = user.displayName || user.realName || id
  }
  if (mentionedBotIds.size > 0) {
    const botNames = await Promise.all(Array.from(mentionedBotIds).map(id => resolveBotName(id).then(name => ({ id, name }))))
    for (const { id, name } of botNames) userMap[id] = name
  }
  for (const [id, label] of appLabelMap) userMap[id] = label
  for (const id of allIds) { if (!userMap[id]) userMap[id] = 'Unknown User' }
  return { messages, userMap, truncated, rootReplyCount }
}

export async function slackSendMessage(channelId: string, text: string, opts?: {
  threadTs?: string
  blocks?: any[]
}): Promise<{ ok: boolean; ts: string; channel: string }> {
  const params: Record<string, any> = {
    channel: channelId,
    text,
  }
  if (opts?.threadTs) params.thread_ts = opts.threadTs
  if (opts?.blocks) params.blocks = opts.blocks

  const data = await slackApi('chat.postMessage', params)

  console.log(`[slack] Sent message to ${channelId}${opts?.threadTs ? ` (thread ${opts.threadTs})` : ''}`)
  return {
    ok: data.ok,
    ts: data.ts,
    channel: data.channel,
  }
}

export async function slackGetUser(userId: string): Promise<SlackUser> {
  // Check cache first
  const cached = getCachedUser(userId)
  if (cached) return cached

  const data = await slackApiGet('users.info', { user: userId })
  const raw = data.user

  const user: SlackUser = {
    id: raw.id,
    name: raw.name || '',
    realName: raw.real_name || raw.profile?.real_name || '',
    displayName: raw.profile?.display_name || raw.real_name || raw.name || '',
    avatar: raw.profile?.image_48 || raw.profile?.image_32 || '',
    isBot: !!raw.is_bot,
  }

  setCachedUser(user)
  return user
}

export async function slackGetUsers(userIds: string[]): Promise<Map<string, SlackUser>> {
  const result = new Map<string, SlackUser>()
  const uncached: string[] = []

  // Gather cached users and identify uncached ones
  for (const id of userIds) {
    const cached = getCachedUser(id)
    if (cached) {
      result.set(id, cached)
    } else {
      uncached.push(id)
    }
  }

  // Fetch uncached users in batches of 30 to stay within Slack Tier 3 rate limits
  if (uncached.length > 0) {
    for (let i = 0; i < uncached.length; i += 30) {
      const batch = uncached.slice(i, i + 30)
      await Promise.all(batch.map(async (id) => {
        try {
          const user = await slackGetUser(id)
          result.set(id, user)
        } catch (e) {
          console.warn(`[slack] Failed to fetch user ${id}:`, e)
        }
      }))
      if (i + 30 < uncached.length) await new Promise(resolve => setTimeout(resolve, 150))
    }
  }

  return result
}

export async function slackAddReaction(channelId: string, timestamp: string, emoji: string): Promise<void> {
  await slackApi('reactions.add', {
    channel: channelId,
    timestamp,
    name: emoji,
  })
  console.log(`[slack] Added :${emoji}: to ${channelId}/${timestamp}`)
}

export async function slackRemoveReaction(channelId: string, timestamp: string, emoji: string): Promise<void> {
  await slackApi('reactions.remove', {
    channel: channelId,
    timestamp,
    name: emoji,
  })
  console.log(`[slack] Removed :${emoji}: from ${channelId}/${timestamp}`)
}

export async function slackGetSelf(): Promise<{ id: string; displayName: string; avatar?: string } | null> {
  const userId = await getCurrentUserId()
  if (!userId) return null
  try {
    const user = await slackGetUser(userId)
    return { id: userId, displayName: user.displayName || user.realName || user.name, avatar: user.avatar || undefined }
  } catch {
    return { id: userId, displayName: userId }
  }
}

export async function slackDownloadFile(url: string): Promise<Buffer> {
  const token = getToken()
  if (!token) throw new Error('[slack] No token configured')
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) throw new Error(`[slack] Failed to download file: HTTP ${resp.status}`)
  const arrayBuffer = await resp.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export async function slackGetThumbnail(url: string): Promise<string> {
  const token = getToken()
  if (!token) throw new Error('[slack] No token configured')
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) throw new Error(`[slack] Failed to fetch thumbnail: HTTP ${resp.status}`)
  let mimeType = (resp.headers.get('content-type') || '').split(';')[0].trim()
  if (!mimeType.startsWith('image/')) {
    const host = new URL(url).hostname
    const isKnownSlackHost = host === 'files.slack.com' || host === 'files-pri.slack.com'
    if (!isKnownSlackHost) throw new Error(`[slack] Thumbnail response is not an image: ${mimeType}`)
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase().replace(/_\d+$/, '')
    if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg'
    else if (ext === 'gif') mimeType = 'image/gif'
    else if (ext === 'webp') mimeType = 'image/webp'
    else if (ext === 'png') mimeType = 'image/png'
    else if (ext === 'svg') mimeType = 'image/svg+xml'
    else if (ext === 'bmp') mimeType = 'image/bmp'
    else if (ext === 'ico') mimeType = 'image/x-icon'
    else if (ext === 'tiff' || ext === 'tif') mimeType = 'image/tiff'
    else throw new Error(`[slack] Thumbnail is not a recognized image type: ${mimeType} (ext: ${ext})`)
  }
  const arrayBuffer = await resp.arrayBuffer()
  const base64 = Buffer.from(arrayBuffer).toString('base64')
  return `data:${mimeType};base64,${base64}`
}

export async function slackMarkRead(channelId: string, timestamp: string): Promise<void> {
  if (!isUserToken()) {
    throw new Error('mark-read unavailable with bot token')
  }
  await slackApi('conversations.mark', {
    channel: channelId,
    ts: timestamp,
  })
}

export async function slackSearchMessages(query: string, opts?: {
  count?: number
  page?: number
}): Promise<{ messages: SlackMessage[]; total: number; userMap: Record<string, string> }> {
  if (!isUserToken()) {
    throw new Error('Slack search requires a user token. Connect a user account via the Connect button to enable search.')
  }

  const params: Record<string, string> = {
    query,
    count: String(opts?.count || 20),
    page: String(opts?.page || 1),
  }

  const data = await slackApiGet('search.messages', params)

  const matches = data.messages?.matches || []
  const total = data.messages?.total || 0

  const messages: SlackMessage[] = matches.filter((raw: any) => !raw.subtype || !SYSTEM_SUBTYPES.has(raw.subtype)).map((raw: any) => ({
    ts: raw.ts,
    threadTs: raw.thread_ts || undefined,
    channelId: raw.channel?.id || '',
    channelName: raw.channel?.name || undefined,
    channelIsIm: !!(raw.channel?.is_im && !raw.channel?.is_mpim),
    channelIsMpim: !!(raw.channel?.is_mpim),
    userId: raw.user || raw.bot_id || raw.app_id || '',
    text: raw.text || '',
    userName: raw.username || raw.bot_profile?.name || (raw.bot_id ? 'Bot' : undefined) || (raw.app_id ? 'App' : undefined),
    date: tsToIso(raw.ts),
    isUnread: false,
    replyCount: raw.reply_count ?? undefined,
    reactions: raw.reactions?.map((r: any) => ({ name: r.name, count: r.count, users: r.users || [] })),
    attachments: raw.attachments?.map((a: any) => ({
      title: a.title,
      text: a.text,
      imageUrl: a.image_url,
      thumbUrl: a.thumb_url,
    })),
    files: raw.files?.map((f: any) => ({
      id: f.id,
      name: f.name,
      title: f.title,
      mimeType: f.mimetype || '',
      size: f.size || 0,
      url: f.url_private_download || f.url_private || '',
      thumbUrl: f.thumb_360 || f.thumb_80 || undefined,
    })),
    edited: !!raw.edited,
  }))

  // Build DM channel → user ID map so we can resolve raw user ID channel names
  const dmChannelUserMap = new Map<string, string>()
  for (const raw of matches) {
    if (raw.channel?.is_im && raw.channel?.user) {
      dmChannelUserMap.set(raw.channel.id as string, raw.channel.user as string)
    }
  }

  // Bulk-resolve user names and avatars — only real user IDs (starting with 'U'); skip bots, apps, and webhook-synthesized IDs
  const authorIds = Array.from(new Set<string>(
    messages.map((m: SlackMessage) => m.userId).filter((id: string) => id && id.startsWith('U'))
  ))
  const mentionedIds = new Set<string>()
  const mentionedBotIds = new Set<string>()
  const appLabelMap = new Map<string, string>() // A-prefixed app IDs: id -> inline label
  for (const msg of messages) {
    let m
    const re = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
    while ((m = re.exec(msg.text)) !== null) {
      const [, id, label] = m
      if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
      else if (id.startsWith('B')) mentionedBotIds.add(id)
      else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
    }
    for (const att of msg.attachments || []) {
      if (att.text) {
        const re2 = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
        while ((m = re2.exec(att.text)) !== null) {
          const [, id, label] = m
          if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
          else if (id.startsWith('B')) mentionedBotIds.add(id)
          else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
        }
      }
      if (att.title) {
        const reTtl = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g
        while ((m = reTtl.exec(att.title)) !== null) {
          const [, id, label] = m
          if (!id.startsWith('B') && !id.startsWith('A')) mentionedIds.add(id)
          else if (id.startsWith('B')) mentionedBotIds.add(id)
          else if (id.startsWith('A') && !appLabelMap.has(id)) appLabelMap.set(id, label || 'App')
        }
      }
    }
  }
  const dmUserIds = Array.from(dmChannelUserMap.values()).filter(id => !id.startsWith('B'))
  // Include MPIM member IDs so slackGetUsers warms userCache for slug-based name resolution
  const mpimMemberIds = Array.from(new Set<string>(
    matches
      .filter((raw: any) => raw.channel?.is_mpim && Array.isArray(raw.channel?.members))
      .flatMap((raw: any) => raw.channel.members as string[])
      .filter((id: string) => id && id.startsWith('U'))
  ))
  const allIds = Array.from(new Set([...authorIds, ...Array.from(mentionedIds), ...dmUserIds, ...mpimMemberIds]))
  const users = allIds.length > 0 ? await slackGetUsers(allIds) : new Map<string, SlackUser>()

  // Pre-warm mpimCache for MPIM channels with cold/expired entries so search results show member names
  const coldMpimIds = Array.from(new Set<string>(
    messages
      .filter((m: SlackMessage) => m.channelIsMpim)
      .map((m: SlackMessage) => m.channelId)
      .filter((id: string) => { const c = mpimCache.get(id); return !c || Date.now() > c.expiresAt })
  ))
  if (coldMpimIds.length > 0) {
    const selfId = await getCurrentUserId()
    await Promise.all(coldMpimIds.map(async (channelId: string) => {
      try {
        const membersData = await slackApiGet('conversations.members', { channel: channelId, limit: '20' })
        const allMemberIds = (membersData.members || []) as string[]
        const memberIds = selfId ? allMemberIds.filter((id: string) => id !== selfId) : allMemberIds
        if (memberIds.length > 0) {
          const memberUsers = await slackGetUsers(memberIds)
          const names = memberIds.map((id: string) => memberUsers.get(id)).filter(Boolean).map(u => u!.displayName || u!.realName || '').filter(Boolean)
          const displayName = names.length > 0 ? names.join(', ') : 'Group DM'
          mpimCache.set(channelId, { displayName, expiresAt: Date.now() + USER_CACHE_TTL })
        } else {
          mpimCache.set(channelId, { displayName: 'Group DM', expiresAt: Date.now() + USER_CACHE_TTL })
        }
      } catch (e) {
        console.warn(`[slack] Failed to resolve MPIM members for ${channelId}:`, e)
        mpimCache.set(channelId, { displayName: 'Group DM', expiresAt: Date.now() + USER_CACHE_TTL })
      }
    }))
  }

  // Pre-warm dmChannelUserMap for IM channels where API omitted channel.user (channelName is a raw channel ID)
  // First pass: use session cache populated by slackListConversations (avoids cold API calls for visited channels)
  const allColdDmChannelIds = Array.from(new Set<string>(
    messages
      .filter((m: SlackMessage) => m.channelIsIm && !dmChannelUserMap.has(m.channelId) && m.channelName && /^D[A-Z0-9]+$/.test(m.channelName))
      .map((m: SlackMessage) => m.channelId)
  ))
  for (const channelId of allColdDmChannelIds) {
    const cachedUserId = dmChannelUserIdCache.get(channelId)
    if (cachedUserId) dmChannelUserMap.set(channelId, cachedUserId)
  }
  const coldDmChannelIds = allColdDmChannelIds.filter(id => !dmChannelUserMap.has(id))
  if (coldDmChannelIds.length > 0) {
    const selfIdForDm = await getCurrentUserId()
    await Promise.all(coldDmChannelIds.map(async (channelId: string) => {
      try {
        const membersData = await slackApiGet('conversations.members', { channel: channelId, limit: '10' })
        const allMemberIds = (membersData.members || []) as string[]
        const memberIds = selfIdForDm ? allMemberIds.filter((id: string) => id !== selfIdForDm) : allMemberIds
        if (memberIds.length > 0) {
          dmChannelUserMap.set(channelId, memberIds[0])
          dmChannelUserIdCache.set(channelId, memberIds[0])
          const memberUsers = await slackGetUsers(memberIds.slice(0, 1))
          memberUsers.forEach((user, id) => users.set(id, user))
          const resolvedUser = users.get(memberIds[0])
          if (resolvedUser) dmChannelDisplayNameCache.set(channelId, resolvedUser.displayName || resolvedUser.realName)
        }
      } catch (e) {
        console.warn(`[slack] Failed to resolve DM members for ${channelId}:`, e)
      }
    }))
  }

  for (const msg of messages) {
    const user = users.get(msg.userId)
    if (user) {
      msg.userName = user.displayName || user.realName
      msg.userAvatar = user.avatar
    } else if (!msg.userName) {
      msg.userName = msg.userId.startsWith('A') ? 'App' : 'Unknown User'
    }
    // Patch DM channel names: replace raw user ID with display name
    const cachedDmName = dmChannelDisplayNameCache.get(msg.channelId)
    if (cachedDmName) {
      msg.channelName = cachedDmName
    } else {
      const dmUserId = dmChannelUserMap.get(msg.channelId)
      if (dmUserId) {
        const dmUser = users.get(dmUserId)
        if (dmUser) {
          msg.channelName = dmUser.displayName || dmUser.realName
          dmChannelDisplayNameCache.set(msg.channelId, msg.channelName)
        }
      } else if (msg.channelIsIm && msg.channelName) {
        // Secondary fallback: channel.user absent — resolve via username slug in userCache
        for (const [, entry] of userCache) {
          if (Date.now() <= entry.expiresAt && entry.user.name === msg.channelName) {
            msg.channelName = entry.user.displayName || entry.user.realName
            dmChannelDisplayNameCache.set(msg.channelId, msg.channelName)
            break
          }
        }
      }
    }
    // Fallback: if DM channel name is still a raw Slack ID, show 'Direct Message'
    if (msg.channelIsIm && msg.channelName && /^[A-Z0-9]{6,}$/.test(msg.channelName)) {
      msg.channelName = 'Direct Message'
    }
    // Resolve MPIM channel names — check dedicated cache first, then parse mpdm slug via userCache
    if (msg.channelIsMpim) {
      const cached = mpimCache.get(msg.channelId)
      if (cached && Date.now() <= cached.expiresAt) {
        msg.channelName = cached.displayName
      } else if (msg.channelName && msg.channelName.startsWith('mpdm-')) {
        const slug = msg.channelName.replace(/^mpdm-/, '').replace(/-\d+$/, '')
        const slugUsernames = slug.split('--')
        const resolvedNames: string[] = []
        for (const [, entry] of userCache) {
          if (Date.now() <= entry.expiresAt && slugUsernames.includes(entry.user.name)) {
            resolvedNames.push(entry.user.displayName || entry.user.realName || entry.user.name)
          }
        }
        msg.channelName = resolvedNames.length > 0 ? resolvedNames.join(', ') : 'Group DM'
      } else {
        msg.channelName = 'Group DM'
      }
    }
  }

  await resolveBotNames(messages)

  // Resolve A-prefix app author IDs still showing as 'App' via bots.info or inline label
  const unnamedAppIds = Array.from(new Set<string>(
    messages
      .filter((m: SlackMessage) => m.userId.startsWith('A') && (!m.userName || m.userName === 'App'))
      .map((m: SlackMessage) => m.userId)
  ))
  const appNameMap = new Map<string, string>()
  if (unnamedAppIds.length > 0) {
    const resolved = await Promise.all(
      unnamedAppIds.map((id: string) =>
        appLabelMap.has(id)
          ? Promise.resolve({ id, name: appLabelMap.get(id)! })
          : resolveBotName(id).then(name => ({ id, name }))
      )
    )
    for (const { id, name } of resolved) appNameMap.set(id, name)
    for (const msg of messages) {
      if (msg.userId.startsWith('A') && (!msg.userName || msg.userName === 'App')) {
        const name = appNameMap.get(msg.userId)
        if (name) msg.userName = name
      }
    }
  }

  const userMap: Record<string, string> = {}
  for (const [id, user] of users) {
    userMap[id] = user.displayName || user.realName || id
  }
  if (mentionedBotIds.size > 0) {
    const botNames = await Promise.all(Array.from(mentionedBotIds).map(id => resolveBotName(id).then(name => ({ id, name }))))
    for (const { id, name } of botNames) userMap[id] = name
  }
  for (const [id, label] of appLabelMap) userMap[id] = label
  for (const [id, name] of appNameMap) {
    if (!userMap[id]) userMap[id] = name
  }
  return { messages, total, userMap }
}

// ── Connection management ──

export interface SlackConnectionStatus {
  connected: boolean
  tokenKind: 'user' | 'bot' | 'none'
  source: 'stored' | 'env' | 'none'
  userId?: string
  displayName?: string
  team?: string
  warning?: string
}

function clearAuthCaches(): void {
  userCache.clear()
  botNameCache.clear()
  mpimCache.clear()
  rootReplyCountCache.clear()
  dmChannelUserIdCache.clear()
  dmChannelDisplayNameCache.clear()
  cachedCurrentUserId = null
}

export async function slackGetConnectionStatus(): Promise<SlackConnectionStatus> {
  const stored = getStoredUserToken()
  const envUser = process.env.SLACK_USER_TOKEN || ''
  const envBot = process.env.SLACK_BOT_TOKEN || ''
  const active = stored || envUser || envBot
  if (!active) return { connected: false, tokenKind: 'none', source: 'none' }

  const tokenKind = (active.startsWith('xoxp-') || active.startsWith('xoxe-') || active.startsWith('xoxe.')) ? 'user' : active.startsWith('xoxb-') ? 'bot' : 'none'
  const source = stored ? 'stored' : 'env'
  const warning = tokenKind === 'bot'
    ? 'Using a bot token — only channels/DMs the bot is a member of are visible. Connect a user token (xoxp- or xoxe-) to see your full Slack.'
    : undefined

  try {
    const data = await slackApiGet('auth.test')
    return {
      connected: !!data.ok,
      tokenKind,
      source,
      userId: data.user_id,
      displayName: data.user,
      team: data.team,
      warning,
    }
  } catch (e) {
    return {
      connected: false,
      tokenKind,
      source,
      warning: e instanceof Error ? e.message : 'Failed to verify token',
    }
  }
}

export async function slackSetUserToken(token: string): Promise<SlackConnectionStatus> {
  const trimmed = token.trim()
  if (!trimmed.startsWith('xoxp-') && !trimmed.startsWith('xoxe-') && !trimmed.startsWith('xoxe.')) {
    throw new Error('Expected a user token starting with "xoxp-" or "xoxe-". Bot tokens (xoxb-) only see channels the bot is in.')
  }

  // Validate by calling auth.test with this specific token, without persisting first
  const resp = await fetch(`${SLACK_API}/auth.test`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${trimmed}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} validating token`)
  const data = await resp.json()
  if (!data.ok) throw new Error(`Slack rejected token: ${data.error}`)

  setStoredUserToken(trimmed)
  clearAuthCaches()
  return slackGetConnectionStatus()
}

export async function slackDisconnect(): Promise<SlackConnectionStatus> {
  clearStoredUserToken()
  clearAuthCaches()
  return slackGetConnectionStatus()
}

// ── OAuth ──

export function slackGetOAuthConfig(): { clientId?: string; hasSecret: boolean } {
  const { clientId, clientSecret } = getOAuthCredentials()
  return { clientId, hasSecret: !!clientSecret }
}

export function slackSaveOAuthConfig(clientId: string, clientSecret: string): void {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (!id || !secret) throw new Error('Client ID and Client Secret are required')
  setOAuthCredentials(id, secret)
}

export async function slackStartOAuth(): Promise<SlackConnectionStatus> {
  if (!hasOAuthCredentials()) {
    throw new Error('Slack Client ID and Secret not configured — set them first')
  }
  const userToken = await runSlackOAuth()
  if (!userToken.startsWith('xoxp-') && !userToken.startsWith('xoxe-')) {
    throw new Error('Slack returned an unexpected token type (not a user token)')
  }
  setStoredUserToken(userToken)
  clearAuthCaches()
  return slackGetConnectionStatus()
}
