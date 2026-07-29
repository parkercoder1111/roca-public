import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

interface SlackChannel {
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

interface SlackMessage {
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
  files?: { id: string; name: string; title: string; mimeType: string; size: number; url: string; thumbUrl?: string }[]
  attachments?: { title?: string; text?: string; imageUrl?: string; thumbUrl?: string }[]
  edited?: boolean
  channelName?: string
  channelIsIm?: boolean
  channelIsMpim?: boolean
  isOptimistic?: boolean
}

interface SlackUser {
  id: string
  name: string
  realName: string
  displayName: string
  avatar: string
  isBot: boolean
}

// Slack IPC methods are declared on window.electronAPI in App.tsx.

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_POLL_MS = 60_000
const MESSAGE_POLL_MS = 30_000
const COMMON_EMOJIS = ['thumbsup', 'heart', 'laughing', 'tada', 'eyes', 'fire', 'clap', 'muscle', 'rocket', 'white_check_mark']

// ── Helpers ──────────────────────────────────────────────────────────────────

import { avatarColor } from './utils/avatar-color'
import { avatarLetter } from './utils/avatar-letter'
import { formatTimestamp } from './utils/format-timestamp'
import { formatFileSize } from './utils/format-file-size'
import { dateSeparatorLabel } from './utils/date-separator-label'
import { parseSlackMrkdwn } from './utils/parse-slack-mrkdwn'
import { channelDisplayName } from './utils/channel-display-name'
import { channelPrefix } from './utils/channel-prefix'
import { slackEmojiChar } from './utils/slack-emoji-char'

// ── Sub-components ───────────────────────────────────────────────────────────

const Avatar = React.memo(function Avatar({ userId, userName, size = 32, src }: { userId: string; userName: string; size?: number; src?: string }) {
  const bg = avatarColor(userId)
  const letter = avatarLetter(userName)
  const fontSize = size <= 24 ? 10 : 12
  const [imgError, setImgError] = React.useState(false)
  React.useEffect(() => { setImgError(false) }, [src])
  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={userName}
        className="flex-shrink-0 rounded-full object-cover select-none"
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    )
  }
  return (
    <div
      className="flex-shrink-0 rounded-full flex items-center justify-center text-white font-semibold select-none"
      style={{ width: size, height: size, backgroundColor: bg, fontSize }}
    >
      {letter}
    </div>
  )
})

const ChannelRow = React.memo(function ChannelRow({
  channel,
  selected,
  onClick,
}: {
  channel: SlackChannel
  selected: boolean
  onClick: () => void
}) {
  const name = channelDisplayName(channel)
  const prefix = channelPrefix(channel)
  const hasUnread = (channel.unreadCount ?? 0) > 0

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2.5 transition-colors ${
        selected ? 'bg-purple-1/[0.07]' : 'hover:bg-black/[0.025]'
      }`}
    >
      {(channel.isIm || channel.isMpim) ? (
        <Avatar userId={channel.userId || channel.id} userName={name} size={22} src={channel.avatarUrl} />
      ) : (
        <span className="text-[11px] text-text-3 w-5 text-center flex-shrink-0">{prefix.trim() || '#'}</span>
      )}
      <span
        className={`text-[12px] truncate flex-1 ${
          hasUnread ? 'font-semibold text-text-1' : 'text-text-2'
        }`}
      >
        {name}
      </span>
      {hasUnread && (
        <span className="min-w-[18px] h-[18px] flex items-center justify-center text-[9px] font-bold bg-red-1 text-white rounded-full leading-none px-1">
          {channel.unreadCount! > 999 ? '999+' : channel.unreadCount}
        </span>
      )}
    </button>
  )
})

// Module-level thumbnail caches — survive channel navigation without refetching
const _thumbCache = new Map<string, string>()
const _attThumbCache = new Map<string, string>()
const THUMB_CACHE_MAX = 200
function _thumbCacheSet(map: Map<string, string>, key: string, value: string) {
  map.set(key, value)
  if (map.size > THUMB_CACHE_MAX) map.delete(map.keys().next().value!)
}

const MessageBubble = React.memo(function MessageBubble({
  message,
  onThreadClick,
  userMapRef,
  channelMap,
  currentThreadTs,
  selfId,
  containerRef,
}: {
  message: SlackMessage
  onThreadClick?: (threadTs: string) => void
  userMapRef?: React.RefObject<Map<string, string>>
  userMapVersion?: number
  channelMap?: Map<string, string>
  currentThreadTs?: string | null
  selfId?: string
  containerRef?: React.RefObject<HTMLDivElement>
}) {
  const [downloadErrors, setDownloadErrors] = useState<Map<string, string>>(new Map())
  const [thumbDataUris, setThumbDataUris] = useState<Map<string, string>>(new Map())
  const [attThumbDataUris, setAttThumbDataUris] = useState<Map<string, string>>(new Map())
  const [addedReactions, setAddedReactions] = useState<Map<string, number>>(new Map())
  const [removingReactions, setRemovingReactions] = useState<Map<string, number>>(new Map())
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [pickerOpensDown, setPickerOpensDown] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pendingReactionCallsRef = useRef<Set<string>>(new Set())
  const thumbIdsInFlightRef = useRef<Set<string>>(new Set())
  const attThumbIdsInFlightRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const selfIdRef = useRef(selfId)
  selfIdRef.current = selfId
  useEffect(() => () => { mountedRef.current = false }, [])
  useEffect(() => {
    if (!showEmojiPicker) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showEmojiPicker])
  useEffect(() => {
    if (addedReactions.size === 0 && removingReactions.size === 0) return
    setAddedReactions(prev => {
      if (prev.size === 0) return prev
      const currentSelfId = selfIdRef.current
      let changed = false
      const next = new Map(prev)
      for (const [name] of prev) {
        if (pendingReactionCallsRef.current.has(name)) continue
        if (currentSelfId && (message.reactions ?? []).find(r => r.name === name)?.users?.includes(currentSelfId)) {
          next.delete(name)
          changed = true
        }
      }
      return changed ? next : prev
    })
    const currentSelfId = selfIdRef.current
    if (currentSelfId) {
      setRemovingReactions(prev => {
        if (prev.size === 0) return prev
        let changed = false
        const next = new Map(prev)
        for (const [name] of prev) {
          const reaction = (message.reactions ?? []).find(r => r.name === name)
          if (!reaction || !reaction.users.includes(currentSelfId)) {
            next.delete(name)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
  }, [message.reactions, selfId])
  const resolvedName = (message.userName && message.userName !== 'Unknown User') ? message.userName : (userMapRef?.current?.get(message.userId ?? '') || undefined)
  const displayName = resolvedName || (message.userId === 'me' ? 'You' : message.userId?.startsWith('B') ? 'Bot' : message.userId?.startsWith('A') ? 'App' : message.userId?.startsWith('webhook-') ? (message.userId.slice(8) || 'Webhook') : ((message.userId && message.userId.length > 0) ? 'Unknown User' : 'Deleted User'))

  const fileIdKey = (message.files ?? []).map(f => f.id).sort().join(',')
  useEffect(() => {
    let cancelled = false
    const slackHostRe = /^https?:\/\/files(?:-pri)?\.slack\.com\//i
    const filesToLoad = (message.files ?? []).filter(f => f.thumbUrl && slackHostRe.test(f.thumbUrl) && !thumbDataUris.has(f.id) && !_thumbCache.has(f.id) && !thumbIdsInFlightRef.current.has(f.id))
    if (filesToLoad.length === 0) return () => {}
    Promise.all(filesToLoad.map(async f => {
      if (cancelled) return
      thumbIdsInFlightRef.current.add(f.id)
      try {
        const dataUri = await window.electronAPI.slackGetThumbnail(f.thumbUrl!)
        _thumbCacheSet(_thumbCache, f.id, dataUri)
        if (!cancelled && thumbIdsInFlightRef.current.has(f.id)) { setThumbDataUris(prev => new Map(prev).set(f.id, dataUri)) }
      } catch {
        // thumbnail unavailable — file link still shows
      } finally {
        thumbIdsInFlightRef.current.delete(f.id)
      }
    })).catch(() => {})
    return () => { cancelled = true; filesToLoad.forEach(f => thumbIdsInFlightRef.current.delete(f.id)) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdKey])

  const attIdKey = (message.attachments ?? []).map((att, i) => `${message.ts}:${i}:${att.imageUrl ?? att.thumbUrl ?? att.title?.slice(0, 30) ?? String(i)}`).sort().join(',')
  useEffect(() => {
    let cancelled = false
    const slackHostRe = /^https?:\/\/files(?:-pri)?\.slack\.com\//i
    const attsToLoad = (message.attachments ?? [])
      .map((att, i) => ({ i, key: `${message.ts}:${i}:${att.imageUrl ?? att.thumbUrl ?? att.title?.slice(0, 30) ?? String(i)}`, url: slackHostRe.test(att.imageUrl ?? '') ? att.imageUrl! : slackHostRe.test(att.thumbUrl ?? '') ? att.thumbUrl! : null }))
      .filter(({ key, url }) => url !== null && !attThumbDataUris.has(key) && !_attThumbCache.has(key) && !attThumbIdsInFlightRef.current.has(key)) as { i: number; key: string; url: string }[]
    if (attsToLoad.length === 0) return () => {}
    Promise.all(attsToLoad.map(async ({ i, key, url }) => {
      if (cancelled) return
      attThumbIdsInFlightRef.current.add(key)
      try {
        const dataUri = await window.electronAPI.slackGetThumbnail(url)
        _thumbCacheSet(_attThumbCache, key, dataUri)
        if (!cancelled && attThumbIdsInFlightRef.current.has(key)) { setAttThumbDataUris(prev => new Map(prev).set(key, dataUri)) }
      } catch {
        // attachment image unavailable
      } finally {
        attThumbIdsInFlightRef.current.delete(key)
      }
    })).catch(() => {})
    return () => { cancelled = true; attsToLoad.forEach(({ key }) => attThumbIdsInFlightRef.current.delete(key)) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attIdKey])
  const timestamp = formatTimestamp(message.date)
  const hasThread = (message.replyCount ?? 0) > 0
  const addedButMissing = [...addedReactions.keys()].filter(name => !(message.reactions ?? []).some(r => r.name === name))
  const allReactions = [
    ...(message.reactions ?? []),
    ...addedButMissing.map(name => ({ name, count: 0, users: [] as string[] })),
  ]
  const hasVisibleReactions = allReactions.some(r => {
    const count = r.count + (addedReactions.has(r.name) ? 1 : 0) - (removingReactions.has(r.name) ? 1 : 0)
    return count > 0
  })

  return (
    <div className="group flex gap-2.5 px-4 py-1.5 hover:bg-black/[0.02] transition-colors">
      <Avatar userId={message.userId} userName={displayName} size={32} src={message.userAvatar} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-text-1">{displayName}</span>
          <span className="text-[10px] text-text-3">{timestamp}</span>
          {message.edited && <span className="text-[10px] text-text-3 italic">(edited)</span>}
        </div>
        <div className="text-[12px] text-text-1 leading-[1.45] mt-0.5 break-words whitespace-pre-wrap">
          {parseSlackMrkdwn(message.text, userMapRef?.current ?? undefined, channelMap)}
        </div>
        {message.files && message.files.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1">
            {message.files.map(f => (
              <div key={f.id} className="flex flex-col">
                <div className="flex items-center gap-1">
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      setDownloadErrors(prev => { const m = new Map(prev); m.delete(f.id); return m })
                      try {
                        const result = await window.electronAPI.slackDownloadFile(f.url, f.name)
                        if (result && !result.ok && !result.canceled) {
                          if (mountedRef.current) setDownloadErrors(prev => new Map(prev).set(f.id, result.error || 'Download failed'))
                        }
                      } catch (err) {
                        if (mountedRef.current) setDownloadErrors(prev => new Map(prev).set(f.id, 'Download failed'))
                      }
                    }}
                    className="inline-flex items-center gap-1.5 text-[11px] text-blue-1 hover:underline cursor-pointer"
                  >
                    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    {f.name} · {formatFileSize(f.size)}
                  </button>
                  {downloadErrors.get(f.id) && (
                    <span className="text-[10px] text-red-1">{downloadErrors.get(f.id)}</span>
                  )}
                </div>
                {(thumbDataUris.has(f.id) || _thumbCache.has(f.id)) && (
                  <img src={thumbDataUris.get(f.id) ?? _thumbCache.get(f.id)} alt={f.name} className="mt-1 max-w-[240px] rounded" />
                )}
              </div>
            ))}
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {message.attachments.map((att, i) => {
              const slackHostRe = /^https?:\/\/files(?:-pri)?\.slack\.com\//i
              const attKey = `${message.ts}:${i}:${att.imageUrl ?? att.thumbUrl ?? att.title?.slice(0, 30) ?? String(i)}`
              const proxiedUri = attThumbDataUris.get(attKey) ?? _attThumbCache.get(attKey)
              const directUrl = (att.imageUrl && !slackHostRe.test(att.imageUrl)) ? att.imageUrl
                : (att.thumbUrl && !slackHostRe.test(att.thumbUrl)) ? att.thumbUrl
                : null
              const imgSrc = proxiedUri ?? directUrl
              return (
                <div key={i} className="border-l-[3px] border-black/20 pl-2 py-0.5">
                  {att.title && <div className="text-[12px] font-semibold text-text-1">{parseSlackMrkdwn(att.title, userMapRef?.current ?? undefined, channelMap)}</div>}
                  {att.text && <div className="text-[11px] text-text-2 mt-0.5 whitespace-pre-wrap">{parseSlackMrkdwn(att.text, userMapRef?.current ?? undefined, channelMap)}</div>}
                  {imgSrc && <img src={imgSrc} alt={att.title || att.text?.slice(0, 60) || ''} className="mt-1 max-w-[240px] rounded" />}
                </div>
              )
            })}
          </div>
        )}
        {/* Reaction row + emoji picker — SLK-001/SLK-002/SLK-003 */}
        <div className={hasVisibleReactions ? 'mt-1 flex flex-wrap gap-1 items-center' : 'flex'}>
          {allReactions.map(r => {
            const isRemoving = removingReactions.has(r.name)
            const alreadyReacted = selfId ? r.users.includes(selfId) : false
            const effectivelyReacted = (alreadyReacted && !isRemoving) || addedReactions.has(r.name)
            const alreadyOnServer = selfId ? r.users.includes(selfId) : false
            const count = r.count + (!alreadyOnServer && addedReactions.has(r.name) ? 1 : 0) - (isRemoving ? 1 : 0)
            if (count <= 0) return null
            return (
              <button
                key={r.name}
                className={`inline-flex items-center gap-1 text-[10px] rounded-full px-2 py-0.5 border cursor-pointer transition-colors ${
                  effectivelyReacted
                    ? 'bg-purple-1/[0.12] border-purple-1/30 text-purple-1 hover:bg-purple-1/[0.18]'
                    : 'text-text-2 bg-surface-1 border-black/[0.06] hover:bg-black/[0.06]'
                }`}
                onClick={async () => {
                  const effectiveSelfId = selfId ?? selfIdRef.current
                  if (!effectiveSelfId || pendingReactionCallsRef.current.has(r.name)) return
                  const shouldRemove = effectivelyReacted
                  if (shouldRemove && effectiveSelfId) {
                    setRemovingReactions(prev => new Map([...prev, [r.name, r.count]]))
                  }
                  pendingReactionCallsRef.current.add(r.name)
                  if (shouldRemove) {
                    try {
                      await window.electronAPI.slackRemoveReaction(message.channelId, message.ts, r.name)
                    } catch {
                      if (mountedRef.current && effectiveSelfId) setRemovingReactions(prev => { const m = new Map(prev); m.delete(r.name); return m })
                    } finally {
                      pendingReactionCallsRef.current.delete(r.name)
                    }
                  } else {
                    setAddedReactions(prev => new Map([...prev, [r.name, r.count]]))
                    try {
                      await window.electronAPI.slackAddReaction(message.channelId, message.ts, r.name)
                    } catch {
                      if (mountedRef.current) setAddedReactions(prev => { const m = new Map(prev); m.delete(r.name); return m })
                    } finally {
                      pendingReactionCallsRef.current.delete(r.name)
                    }
                  }
                }}
              >
                {(() => { const ch = slackEmojiChar(r.name); return /^\[.+\]$/.test(ch) ? <span style={{fontSize:'10px',opacity:0.7}}>{`:${r.name}:`}</span> : ch })()} {count}
              </button>
            )
          })}
          <div className="relative">
            <button
              ref={triggerRef}
              disabled={!selfId}
              className="hidden group-hover:inline-flex items-center justify-center w-5 h-5 rounded-full text-[12px] text-text-3 hover:bg-black/[0.06] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={(e) => {
                e.stopPropagation()
                if (triggerRef.current) {
                  const containerRect = containerRef?.current?.getBoundingClientRect()
                  const containerTop = containerRect?.top ?? (window.innerHeight / 2)
                  const containerBottom = containerRect?.bottom ?? window.innerHeight
                  const triggerRect = triggerRef.current.getBoundingClientRect()
                  const availableAbove = triggerRect.top - containerTop
                  const availableBelow = containerBottom - triggerRect.bottom
                  setPickerOpensDown(availableBelow >= availableAbove)
                }
                setShowEmojiPicker(p => !p)
              }}
              title={selfId ? "Add reaction" : "Sign in to react"}
            >
              🙂
            </button>
            {showEmojiPicker && (
              <div ref={pickerRef} className={`absolute ${pickerOpensDown ? 'top-full mt-1' : 'bottom-full mb-1'} left-0 bg-white rounded-xl border border-black/[0.08] shadow-lg p-1.5 flex flex-wrap gap-0.5 w-[152px] z-50`}>
                {COMMON_EMOJIS.map(name => (
                  <button
                    key={name}
                    className="w-8 h-8 flex items-center justify-center text-[15px] rounded-lg hover:bg-black/[0.06] cursor-pointer"
                    title={name}
                    onClick={async (e) => {
                      e.stopPropagation()
                      setShowEmojiPicker(false)
                      if (!selfId) return
                      if ((message.reactions ?? []).find(r => r.name === name)?.users.includes(selfId)) return
                      if (pendingReactionCallsRef.current.has(name) || addedReactions.has(name)) return
                      const existing = (message.reactions ?? []).find(r => r.name === name)
                      setAddedReactions(prev => new Map([...prev, [name, existing?.count ?? 0]]))
                      pendingReactionCallsRef.current.add(name)
                      try {
                        await window.electronAPI.slackAddReaction(message.channelId, message.ts, name)
                      } catch {
                        if (mountedRef.current) setAddedReactions(prev => { const m = new Map(prev); m.delete(name); return m })
                      } finally {
                        pendingReactionCallsRef.current.delete(name)
                      }
                    }}
                  >
                    {slackEmojiChar(name)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {hasThread && onThreadClick && (
          <button
            onClick={() => onThreadClick(message.threadTs || message.ts)}
            className="mt-1 text-[11px] text-purple-1 hover:underline font-medium"
          >
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
        {!hasThread && message.threadTs && message.threadTs !== message.ts && message.threadTs !== currentThreadTs && onThreadClick && (
          <button
            onClick={() => onThreadClick(message.threadTs!)}
            className="mt-1 text-[11px] text-purple-1 hover:underline font-medium"
          >
            View thread
          </button>
        )}
      </div>
    </div>
  )
})

const DateSeparator = React.memo(function DateSeparator({ dateStr }: { dateStr: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 my-1">
      <div className="flex-1 h-px bg-black/[0.06]" />
      <span className="text-[11px] font-semibold text-text-2">{dateSeparatorLabel(dateStr)}</span>
      <div className="flex-1 h-px bg-black/[0.06]" />
    </div>
  )
})

function reactionsChanged(a: SlackMessage['reactions'], b: SlackMessage['reactions']): boolean {
  if (!a && !b) return false
  if (!a || !b || a.length !== b.length) return true
  const aTotal = a.reduce((s, r) => s + r.count, 0)
  if (aTotal !== b.reduce((s, r) => s + r.count, 0)) return true
  const sortedA = [...a].sort((x, y) => x.name.localeCompare(y.name))
  const sortedB = [...b].sort((x, y) => x.name.localeCompare(y.name))
  return JSON.stringify(sortedA.map(r => ({ ...r, users: [...r.users].sort() }))) !== JSON.stringify(sortedB.map(r => ({ ...r, users: [...r.users].sort() })))
}

// ── Main Component ───────────────────────────────────────────────────────────

export function SlackView({ onUnreadCount }: { onUnreadCount?: (count: number) => void }) {
  // ── State ──
  const [channels, setChannels] = useState<SlackChannel[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SlackMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const loadingMessagesRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [submittedSlackQuery, setSubmittedSlackQuery] = useState('')
  const [channelFilterQuery, setChannelFilterQuery] = useState('')
  const [replyText, setReplyText] = useState('')
  const [threadMessages, setThreadMessages] = useState<SlackMessage[] | null>(null)
  const [threadTruncated, setThreadTruncated] = useState(false)
  const [loadMoreAttempted, setLoadMoreAttempted] = useState(false)
  const [viewingThreadTs, setViewingThreadTs] = useState<string | null>(null)
  const [threadReplyText, setThreadReplyText] = useState('')
  const [sendingMain, setSendingMain] = useState(false)
  const [sendingThread, setSendingThread] = useState(false)
  const sendingMainRef = useRef(false)
  const sendingThreadRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [mainSendError, setMainSendError] = useState<string | null>(null)
  const [threadSendError, setThreadSendError] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [msgNextCursor, setMsgNextCursor] = useState<string | null>(null)
  const msgNextCursorRef = useRef<string | null>(null)
  const [msgHasMore, setMsgHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [newChannelMessages, setNewChannelMessages] = useState(0)
  const [newThreadMessages, setNewThreadMessages] = useState(0)
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [searchResults, setSearchResults] = useState<SlackMessage[]>([])
  const [searchTotal, setSearchTotal] = useState<number>(0)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchLoadingMore, setSearchLoadingMore] = useState(false)
  const loadMoreSearchInFlightRef = useRef(false)
  const [searchPage, setSearchPage] = useState(1)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchLoadMoreError, setSearchLoadMoreError] = useState<string | null>(null)
  const [connection, setConnection] = useState<{ connected: boolean; tokenKind: 'user' | 'bot' | 'none'; source: 'stored' | 'env' | 'none'; displayName?: string; team?: string; warning?: string } | null>(null)
  const [showConnectModal, setShowConnectModal] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [oauthConfig, setOauthConfig] = useState<{ clientId?: string; hasSecret: boolean } | null>(null)
  const [clientIdInput, setClientIdInput] = useState('')
  const [clientSecretInput, setClientSecretInput] = useState('')
  const [showManualToken, setShowManualToken] = useState(false)
  const [selfId, setSelfId] = useState<string | undefined>(undefined)

  // ── Refs ──
  const loadingOlderRef = useRef<string | null>(null)
  const newestMsgTsForPillRef = useRef<string | undefined>(undefined)
  const newestThreadTsForPillRef = useRef<string | undefined>(undefined)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const connectModalRef = useRef<HTMLDivElement>(null)
  const threadContainerRef = useRef<HTMLDivElement>(null)
  const searchScrollRef = useRef<HTMLDivElement>(null)
  const selectedChannelRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const channelPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const channelPollTriggerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const userScrolledUpRef = useRef(false)
  const threadScrolledUpRef = useRef(false)
  const selfRef = useRef<{ id: string; displayName: string; avatar?: string } | null>(null)
  const lastMarkedTsRef = useRef<Map<string, string>>(new Map())
  const markReadFailCountRef = useRef<Map<string, number>>(new Map())
  const newestThreadReplyTsRef = useRef<Map<string, string>>(new Map())
  const persistentUserMapRef = useRef<Map<string, string>>(new Map())
  const [persistentUserMapVersion, setPersistentUserMapVersion] = useState(0)
  const visitedChannelIdsRef = useRef<Set<string>>(new Set())
  const lastFullChannelLoadRef = useRef(Date.now())
  const pollFailCountRef = useRef(0)
  const messagePollFailCountRef = useRef(0)
  const silentThreadPollFailCountRef = useRef(0)
  const silentMsgPollInFlightRef = useRef(new Map<string, boolean>())
  const gapReloadInProgressRef = useRef(new Set<string>())
  const pendingOptimisticRef = useRef(new Set<string>())
  const pendingOptimisticThreadsRef = useRef(new Set<string>())
  const newestChannelMsgTsRef = useRef(new Map<string, string>())
  const silentThreadPollInFlightRef = useRef<Map<string, boolean>>(new Map())
  const silentThreadPollCountRef = useRef<Map<string, number>>(new Map())
  const mainTextareaRef = useRef<HTMLTextAreaElement>(null)
  const threadTextareaRef = useRef<HTMLTextAreaElement>(null)
  const threadResizeDoneByOnChange = useRef(false)
  const retryPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visitedChannelWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEvictionRef = useRef(0)

  selectedChannelRef.current = selectedChannelId
  const channelsRef = useRef<SlackChannel[]>([])
  channelsRef.current = channels
  const viewingThreadTsRef = useRef<string | null>(null)
  const submittedSlackQueryRef = useRef('')
  const threadReplyTextRef = useRef('')
  const threadReplyDraftsRef = useRef<Map<string, string>>(new Map())
  const replyTextRef = useRef('')
  const mainDraftsRef = useRef<Map<string, string>>(new Map())
  const threadFallbackChannelNameRef = useRef<string | null>(null)
  const threadFallbackChannelIsDmRef = useRef(false)
  viewingThreadTsRef.current = viewingThreadTs
  threadReplyTextRef.current = threadReplyText
  replyTextRef.current = replyText
  const tokenKindRef = useRef<'user' | 'bot' | 'none'>('none')
  tokenKindRef.current = connection?.tokenKind ?? tokenKindRef.current
  const connectionCheckedRef = useRef(false)

  // ── Data Loading ──

  const loadChannels = useCallback(async (pollMode?: boolean) => {
    try {
      if (!pollMode) lastFullChannelLoadRef.current = Date.now()
      const allRawChannels: SlackChannel[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const result = await window.electronAPI.slackListConversations(cursor ? { cursor, pollMode } : (pollMode ? { pollMode } : undefined))
        if (!mountedRef.current) return
        allRawChannels.push(...result.channels)
        if (result.userMap) {
          for (const [id, name] of Object.entries(result.userMap as Record<string, string>)) {
            if (name && name !== 'Unknown User') persistentUserMapRef.current.set(id, name)
          }
          setPersistentUserMapVersion(v => v + 1)
        }
        // Poll mode: break after page 2 (first 400 channels). Full multi-page load runs every 90s.
        if (!result.nextCursor || (pollMode && page >= 2)) break
        cursor = result.nextCursor
      }
      // If poll returned a channel not yet in our cache, a channel moved into the top-400 since
      // the last full load — trigger an immediate full reload to surface it without waiting 90s.
      if (pollMode) {
        const knownIds = new Set(channelsRef.current.map(ch => ch.id))
        if (allRawChannels.some(ch => !knownIds.has(ch.id)) && Date.now() - lastFullChannelLoadRef.current > 5000) {
          if (!mountedRef.current) return
          if (channelPollTriggerRef.current) clearTimeout(channelPollTriggerRef.current)
          channelPollTriggerRef.current = setTimeout(loadChannels, 0)
        }
      }
      const freshChannels: SlackChannel[] = allRawChannels.map((ch: SlackChannel) => {
        // Resolve DM name from cache when main-process slackGetUsers failed
        if (ch.isIm && ch.userId && (!ch.displayName || ch.displayName === 'Direct Message')) {
          const cached = persistentUserMapRef.current.get(ch.userId)
          if (cached && cached !== 'Unknown User') ch = { ...ch, displayName: cached, name: cached }
        }
        // Preserve MPIM displayName from existing state when poll returns before cache is populated
        if (ch.isMpim && !ch.displayName) {
          const existing = channelsRef.current.find(c => c.id === ch.id)
          if (existing?.displayName) ch = { ...ch, displayName: existing.displayName, name: existing.displayName }
        }
        // Evict visited entry only if server reports unread messages newer than what we marked
        if ((ch.unreadCount ?? 0) > 0 && visitedChannelIdsRef.current.has(ch.id)) {
          const newestTs = ch.lastMessage?.ts
          const markedTs = lastMarkedTsRef.current.get(ch.id)
          if (!markedTs || (newestTs !== undefined && parseFloat(newestTs) - parseFloat(markedTs) > 0.000002)) {
            visitedChannelIdsRef.current.delete(ch.id)
            if (ch.id === selectedChannelRef.current && !userScrolledUpRef.current) {
              return { ...ch, unreadCount: 0 }
            }
            return ch
          }
        }
        if (ch.id === selectedChannelRef.current) {
          return !userScrolledUpRef.current ? { ...ch, unreadCount: 0 } : ch
        }
        return visitedChannelIdsRef.current.has(ch.id) ? { ...ch, unreadCount: 0 } : ch
      })
      setChannels(prev => {
        if (prev.length === 0 || !pollMode) return freshChannels
        const freshById = new Map(freshChannels.map(ch => [ch.id, ch]))
        const freshOrder = new Map(freshChannels.map((ch, i) => [ch.id, i]))
        const freshIds = new Set(freshChannels.map(ch => ch.id))
        const prevIds = new Set(prev.map(ch => ch.id))
        const prevOrder = new Map(prev.map((ch, i) => [ch.id, i]))
        const updated = prev
          .filter(ch => freshById.has(ch.id))
          .map(ch => freshById.get(ch.id)!)
        const added = freshChannels.filter(ch => !prevIds.has(ch.id))
        const preserved = prev.filter(ch => !freshIds.has(ch.id))
        return [...updated, ...added, ...preserved].sort((a, b) => {
          const ao = freshOrder.get(a.id) ?? Infinity
          const bo = freshOrder.get(b.id) ?? Infinity
          if (ao !== Infinity || bo !== Infinity) return ao - bo
          return (prevOrder.get(a.id) ?? Infinity) - (prevOrder.get(b.id) ?? Infinity)
        })
      })
      // Fallback: individually fetch any IM channels still missing a display name.
      // Only on full loads (not poll) to avoid hammering the API.
      if (!pollMode) {
        const unresolvedDms = freshChannels.filter(ch =>
          ch.isIm && ch.userId && /^[UW][A-Z0-9]{6,}$/.test(ch.userId) &&
          (!ch.displayName || ch.displayName === 'Direct Message') &&
          persistentUserMapRef.current.get(ch.userId) !== 'Unknown User'
        )
        if (unresolvedDms.length > 0) {
          ;(async () => {
            for (let i = 0; i < unresolvedDms.length; i += 5) {
              if (!mountedRef.current) return
              const batch = unresolvedDms.slice(i, i + 5)
              await Promise.allSettled(batch.map(async ch => {
                try {
                  const user = await window.electronAPI.slackGetUser(ch.userId!)
                  if (!mountedRef.current) return
                  const resolved = user.displayName || user.realName || user.name
                  if (!resolved) return
                  persistentUserMapRef.current.set(ch.userId!, resolved)
                  setPersistentUserMapVersion(v => v + 1)
                  setChannels(prev => prev.map(c =>
                    c.id === ch.id ? { ...c, displayName: resolved, name: resolved } : c
                  ))
                } catch {
                  if (mountedRef.current) setChannels(prev => prev.map(c =>
                    c.id === ch.id ? { ...c, displayName: 'Direct Message', name: 'Direct Message' } : c
                  ))
                }
              }))
            }
          })()
        }
      }
      pollFailCountRef.current = 0
      setError(null)
    } catch (err) {
      console.error('[SlackView] Load channels error:', err)
      const errMsg = err instanceof Error ? err.message : String(err)
      pollFailCountRef.current++
      if (mountedRef.current && !errMsg.includes('No token configured')) setError('Failed to load channels')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  const loadMessages = useCallback(async (channelId: string, opts?: { silent?: boolean; gapReload?: boolean; oldest?: string }) => {
    if (opts?.silent) {
      if (silentMsgPollInFlightRef.current.get(channelId)) return
      silentMsgPollInFlightRef.current.set(channelId, true)
    }
    if (!opts?.silent && !opts?.gapReload) { setLoadingMessages(true); loadingMessagesRef.current = true }
    try {
      const result = await window.electronAPI.slackListMessages(channelId, opts?.oldest ? { oldest: opts.oldest } : undefined)
      if (!mountedRef.current || selectedChannelRef.current !== channelId) return
      if (result.userMap) {
        let added = false
        for (const [id, name] of Object.entries(result.userMap)) {
          if (persistentUserMapRef.current.get(id) !== name && (name !== 'Unknown User' || !persistentUserMapRef.current.has(id))) { persistentUserMapRef.current.set(id, name); added = true }
        }
        if (added) {
          setPersistentUserMapVersion(v => v + 1)
          setChannels(prev => {
            if (!prev.some(ch => ch.isIm && ch.userId && (!ch.displayName || ch.displayName === 'Direct Message'))) return prev
            return prev.map(ch => {
              if (!(ch.isIm && ch.userId && (!ch.displayName || ch.displayName === 'Direct Message'))) return ch
              const resolved = persistentUserMapRef.current.get(ch.userId) !== 'Unknown User' ? persistentUserMapRef.current.get(ch.userId) : undefined
              return { ...ch, displayName: resolved ?? ch.displayName, name: resolved ?? ch.name }
            })
          })
        }
      }
      // Resolve @mentions for users not yet in the persistent map
      {
        const unknownUids = new Set<string>()
        for (const msg of result.messages) {
          if (!msg.text) continue
          const re = /<@([UW][A-Z0-9]{6,})/g
          let m: RegExpExecArray | null
          while ((m = re.exec(msg.text)) !== null) {
            if (!persistentUserMapRef.current.has(m[1])) unknownUids.add(m[1])
          }
        }
        if (unknownUids.size > 0) {
          Promise.allSettled([...unknownUids].map(async uid => {
            try {
              const user = await window.electronAPI.slackGetUser(uid)
              if (!mountedRef.current) return
              const name = user.displayName || user.realName || user.name
              if (!name) return
              persistentUserMapRef.current.set(uid, name)
              setPersistentUserMapVersion(v => v + 1)
            } catch {
              persistentUserMapRef.current.set(uid, 'Unknown User')
              if (mountedRef.current) setPersistentUserMapVersion(v => v + 1)
            }
          }))
        }
      }
      // Gap detection: if the oldest fresh message is newer than our newest known ts,
      // the 50-message window didn't reach back far enough — trigger a full reload.
      if (opts?.silent && result.messages.length > 0) {
        const oldestFreshTs = result.messages[result.messages.length - 1].ts
        const newestKnown = newestChannelMsgTsRef.current.get(channelId)
        if (newestKnown && parseFloat(oldestFreshTs) > parseFloat(newestKnown) && !pendingOptimisticRef.current.has(channelId)) {
          silentMsgPollInFlightRef.current.set(channelId, true)
          gapReloadInProgressRef.current.add(channelId)
          loadMessages(channelId, { gapReload: true, oldest: newestKnown })
          return
        }
      }
      if (opts?.silent) {
        // Merge: prepend new messages and update any edited existing ones
        setMessages(prev => {
          if (result.messages.length === 0) { if (pendingOptimisticRef.current.has(channelId)) return prev; pendingOptimisticRef.current.delete(channelId); return [] }
          if (prev.length === 0) return result.messages
          const existingTs = new Set(prev.map(m => m.ts))
          const newMsgs = result.messages.filter((m: SlackMessage) => !existingTs.has(m.ts))
          const freshByTs = new Map<string, SlackMessage>(result.messages.map((m: SlackMessage) => [m.ts, m]))
          const updated = prev.map(m => {
            const fresh = freshByTs.get(m.ts)
            if (fresh && (fresh.text !== m.text || !!fresh.edited !== !!m.edited || (fresh.replyCount ?? 0) !== (m.replyCount ?? 0) || (m.userId === '' && fresh.userId !== '') || (!m.userAvatar && !!fresh.userAvatar) || reactionsChanged(fresh.reactions, m.reactions) || (m.userName === 'Unknown User' && !!fresh.userName && fresh.userName !== 'Unknown User') || !!m.isOptimistic)) {
              const hasPendingOptimistic = pendingOptimisticThreadsRef.current.has(m.ts)
              const mergedCount = Math.max(m.replyCount ?? 0, fresh.replyCount ?? 0)
              if (hasPendingOptimistic && (fresh.replyCount ?? 0) >= (m.replyCount ?? 0)) pendingOptimisticThreadsRef.current.delete(m.ts)
              return { ...fresh, replyCount: mergedCount }
            }
            return m
          })
          const freshTs = new Set(result.messages.map((m: SlackMessage) => m.ts))
          const oldestFresh = result.messages[result.messages.length - 1]?.ts ?? '0'
          const merged = [...newMsgs, ...updated].sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))
          return merged.filter(m => freshTs.has(m.ts) || parseFloat(m.ts) < parseFloat(oldestFresh) || !!m.isOptimistic)
        })
        // S01: do NOT update cursor/hasMore on silent polls — preserves user's pagination position
      } else if (opts?.gapReload) {
        if (!result.messages || result.messages.length === 0) return
        // Paginate until we bridge the gap: fetch additional pages while all returned messages are
        // still newer than newestKnown (i.e., the gap is wider than one page).
        let gapMessages = result.messages as SlackMessage[]
        let gapCursor = result.nextCursor
        const newestKnown = opts.oldest
        let gapPages = 0
        let gapUserMapAdded = false
        while (gapCursor && newestKnown && gapMessages.length > 0 &&
               parseFloat(gapMessages[gapMessages.length - 1].ts) > parseFloat(newestKnown) &&
               ++gapPages < 10) {
          const more = await window.electronAPI.slackListMessages(channelId, { cursor: gapCursor })
          if (!mountedRef.current || selectedChannelRef.current !== channelId) return
          if (!more.messages || more.messages.length === 0) break
          if (more.userMap) {
            for (const [id, name] of Object.entries(more.userMap as Record<string, string>)) {
              if (persistentUserMapRef.current.get(id) !== name) { persistentUserMapRef.current.set(id, name); gapUserMapAdded = true }
            }
          }
          gapMessages = [...gapMessages, ...more.messages]
          gapCursor = more.nextCursor
        }
        if (gapUserMapAdded) setPersistentUserMapVersion(v => v + 1)
        // Gap too large to bridge (>10 pages): discard partial results and do a full reload
        if (gapPages >= 10 && !!gapCursor) {
          loadMessages(channelId)
          return
        }
        const oldestFreshTs = gapMessages[gapMessages.length - 1]?.ts ?? '0'
        // Reset pill baseline to the pre-gap newest ts so the pill effect only counts genuinely new messages
        if (!mountedRef.current || selectedChannelRef.current !== channelId) {
          if (gapMessages.length > 0) newestChannelMsgTsRef.current.set(channelId, gapMessages[0].ts)
          return
        }
        newestMsgTsForPillRef.current = newestChannelMsgTsRef.current.get(channelId)
        setMessages(prev => {
          const gapTsSet = new Set(gapMessages.map(m => m.ts))
          const history = prev.filter(m => (parseFloat(m.ts) < parseFloat(oldestFreshTs) || m.isOptimistic) && !gapTsSet.has(m.ts))
          return [...gapMessages, ...history]
        })
        msgNextCursorRef.current = gapCursor ?? null
        setMsgNextCursor(gapCursor ?? null)
        setMsgHasMore(!!gapCursor)
      } else {
        setMessages(result.messages)
        msgNextCursorRef.current = result.nextCursor ?? null
        setMsgNextCursor(result.nextCursor ?? null)
        setMsgHasMore(result.hasMore)
      }
      if (result.messages.length > 0) newestChannelMsgTsRef.current.set(channelId, result.messages[0].ts)
      pendingOptimisticRef.current.delete(channelId)
      setError(null)
      messagePollFailCountRef.current = 0
      // Mark as read — only when newestTs changes and user is at the bottom of the channel
      if (result.messages.length > 0 && !userScrolledUpRef.current && tokenKindRef.current === 'user') {
        const newestTs = result.messages[0].ts
        if (newestTs !== lastMarkedTsRef.current.get(channelId)) {
          const prevTs = lastMarkedTsRef.current.get(channelId)
          lastMarkedTsRef.current.delete(channelId)
          lastMarkedTsRef.current.set(channelId, newestTs)
          window.electronAPI.slackMarkRead(channelId, newestTs).then(() => {
              markReadFailCountRef.current.delete(channelId)
            }).catch(() => {
              const failures = (markReadFailCountRef.current.get(channelId) ?? 0) + 1
              markReadFailCountRef.current.set(channelId, failures)
              if (failures < 3) {
                lastMarkedTsRef.current.delete(channelId)
                if (prevTs !== undefined) lastMarkedTsRef.current.set(channelId, prevTs)
              } else {
                // Circuit breaker tripped — server still considers channel unread.
                // Remove from visited set so the server-reported badge shows correctly on next visit.
                visitedChannelIdsRef.current.delete(channelId)
                console.warn('[SlackView] mark-read circuit breaker tripped for channel', channelId)
              }
              // ≥3 consecutive failures: keep lastMarkedTsRef at newestTs so future
              // polls don't retry (circuit-breaker for revoked tokens / 403s)
            })
        }
      }
    } catch (err) {
      console.error('[SlackView] Load messages error:', err)
      if (opts?.silent) messagePollFailCountRef.current++
      if (mountedRef.current && !opts?.silent && !opts?.gapReload) {
        setError('Failed to load messages')
        // Undo the optimistic visited/badge-zero from handleSelectChannel so the next poll restores the server count
        visitedChannelIdsRef.current.delete(channelId)
      }
    } finally {
      if (opts?.silent && !gapReloadInProgressRef.current.has(channelId)) silentMsgPollInFlightRef.current.delete(channelId)
      if (!opts?.silent && !opts?.gapReload) { gapReloadInProgressRef.current.delete(channelId); silentMsgPollInFlightRef.current.delete(channelId) }
      if (opts?.gapReload) { gapReloadInProgressRef.current.delete(channelId); silentMsgPollInFlightRef.current.delete(channelId) }
      if (!gapReloadInProgressRef.current.has(channelId)) loadingMessagesRef.current = false
      if (mountedRef.current && !opts?.silent && !opts?.gapReload && selectedChannelRef.current === channelId) setLoadingMessages(false)
    }
  }, [])

  const loadOlderMessages = useCallback(async () => {
    if (!selectedChannelId || !msgNextCursorRef.current || loadingOlderRef.current === selectedChannelId) return
    loadingOlderRef.current = selectedChannelId
    setLoadingOlder(true)
    try {
      const result = await window.electronAPI.slackListMessages(selectedChannelId, { cursor: msgNextCursorRef.current })
      if (!mountedRef.current || selectedChannelRef.current !== selectedChannelId) return
      if (result.userMap) {
        let added = false
        for (const [id, name] of Object.entries(result.userMap)) {
          if (persistentUserMapRef.current.get(id) !== name) { persistentUserMapRef.current.set(id, name); added = true }
        }
        if (added) setPersistentUserMapVersion(v => v + 1)
      }
      const el = messageContainerRef.current
      const prevScrollHeight = el?.scrollHeight ?? 0
      setMessages(prev => {
        const existingTs = new Set(prev.map(m => m.ts))
        const deduped = result.messages.filter((m: SlackMessage) => !existingTs.has(m.ts))
        return [...prev, ...deduped]
      })
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop += el.scrollHeight - prevScrollHeight
          }
        })
      })
      msgNextCursorRef.current = result.nextCursor ?? null
      setMsgNextCursor(result.nextCursor ?? null)
      setMsgHasMore(result.hasMore)
    } catch (err) {
      console.error('[SlackView] Load older messages error:', err)
      if (mountedRef.current) {
        setError('Failed to load older messages. Try again.')
        setTimeout(() => { if (mountedRef.current) setError(null) }, 3000)
      }
    } finally {
      if (loadingOlderRef.current === selectedChannelId) loadingOlderRef.current = null
      if (mountedRef.current && selectedChannelRef.current === selectedChannelId) setLoadingOlder(false)
    }
  }, [selectedChannelId])

  const loadThread = useCallback(async (channelId: string, threadTs: string, opts?: { silent?: boolean }) => {
    if (opts?.silent) {
      const key = `${channelId}:${threadTs}`
      if (silentThreadPollInFlightRef.current.get(key)) return
      silentThreadPollInFlightRef.current.set(key, true)
    }
    // For silent polls, pass the newest known reply ts so the server only returns new replies.
    // Every 4th silent poll, omit oldest to do a full refresh — catches edits/deletions/reaction changes.
    let oldest: string | undefined
    let isFullSilentRefresh = false
    if (opts?.silent) {
      const threadKey = `${channelId}:${threadTs}`
      const count = (silentThreadPollCountRef.current.get(threadKey) ?? 0) + 1
      silentThreadPollCountRef.current.set(threadKey, count)
      isFullSilentRefresh = count % 4 === 0
      if (count % 4 !== 0) {
        const knownTs = newestThreadReplyTsRef.current.get(threadKey)
        if (knownTs) {
          const [sec, usec] = knownTs.split('.')
          const nextUsec = parseInt(usec || '0', 10) + 1
          oldest = nextUsec >= 1000000
            ? String(parseInt(sec, 10) + 1) + '.000000'
            : sec + '.' + String(nextUsec).padStart(6, '0')
        }
      }
    }
    const fetchOpts = oldest ? { ...opts, oldest } : opts
    try {
      const result = await window.electronAPI.slackGetThread(channelId, threadTs, fetchOpts)
      // Process userMap unconditionally so names persist even if this load is stale
      if (result.userMap) {
        let added = false
        for (const [id, name] of Object.entries(result.userMap)) {
          if (persistentUserMapRef.current.get(id) !== name) { persistentUserMapRef.current.set(id, name); added = true }
        }
        if (added && mountedRef.current) setPersistentUserMapVersion(v => v + 1)
      }
      if (!mountedRef.current || viewingThreadTsRef.current !== threadTs) return
      // Resolve @mentions for users not yet in the persistent map
      {
        const unknownUids = new Set<string>()
        for (const msg of result.messages) {
          if (!msg.text) continue
          const re = /<@([UW][A-Z0-9]{6,})/g
          let m: RegExpExecArray | null
          while ((m = re.exec(msg.text)) !== null) {
            if (!persistentUserMapRef.current.has(m[1])) unknownUids.add(m[1])
          }
        }
        if (unknownUids.size > 0) {
          Promise.allSettled([...unknownUids].map(async uid => {
            try {
              const user = await window.electronAPI.slackGetUser(uid)
              if (!mountedRef.current) return
              const name = user.displayName || user.realName || user.name
              if (!name) return
              persistentUserMapRef.current.set(uid, name)
              setPersistentUserMapVersion(v => v + 1)
            } catch {
              persistentUserMapRef.current.set(uid, 'Unknown User')
              if (mountedRef.current) setPersistentUserMapVersion(v => v + 1)
            }
          }))
        }
      }
      const msgs = result.messages
      setThreadError(null)
      if (!oldest) {
        setThreadTruncated(result.truncated ?? false)
        if (!opts?.silent && result.truncated) setLoadMoreAttempted(false)
      } else if (result.truncated) {
        setThreadTruncated(true)
        setLoadMoreAttempted(false)
      }
      const newestReplyTs = msgs[msgs.length - 1]?.ts
      if (newestReplyTs) {
        const threadKey = `${channelId}:${threadTs}`
        const existing = newestThreadReplyTsRef.current.get(threadKey)
        if (!existing || newestReplyTs > existing) {
          newestThreadReplyTsRef.current.set(threadKey, newestReplyTs)
        }
        // Anchor pill baseline to the actual loaded value so the first silent poll
        // doesn't count already-visible replies as new.
        if (!opts?.silent) newestThreadTsForPillRef.current = newestReplyTs
      }
      setThreadMessages(prev => {
        if (oldest) {
          // Incremental fetch: append new replies to existing thread
          if (msgs.length === 0) {
            if (result.rootReplyCount !== undefined && prev && prev.length > 0) {
              return [{ ...prev[0], replyCount: Math.max(prev[0].replyCount ?? 0, result.rootReplyCount) }, ...prev.slice(1)]
            }
            return prev ?? []
          }
          if (!prev) return msgs
          const newTsSet = new Set(msgs.map(m => m.ts))
          const serverLatest = msgs[msgs.length - 1].ts
          const rootWithCount = result.rootReplyCount !== undefined && prev.length > 0
            ? { ...prev[0], replyCount: Math.max(prev[0].replyCount ?? 0, result.rootReplyCount) }
            : prev[0]
          const dedupedPrev = [rootWithCount, ...prev.slice(1)].filter(m => !newTsSet.has(m.ts))
          const optimisticTail = dedupedPrev.filter(m => !!m.isOptimistic && m.ts > serverLatest)
          const nonOptimistic = dedupedPrev.filter(m => !m.isOptimistic || m.ts <= serverLatest)
          return optimisticTail.length > 0 ? [...nonOptimistic, ...msgs, ...optimisticTail] : [...nonOptimistic, ...msgs]
        }
        // Full fetch: replace existing messages, preserving optimistic tail and root replyCount
        if (msgs.length === 0) {
          const optimistic = prev ? prev.filter(m => !!m.isOptimistic) : []
          return optimistic.length > 0 ? optimistic : msgs
        }
        if (!prev) return msgs
        const serverLatest = msgs[msgs.length - 1]?.ts ?? '0'
        const optimisticTail = prev.filter(m => !!m.isOptimistic && m.ts > serverLatest)
        // Preserve the higher replyCount unless this is a full-refresh silent poll with no pending
        // optimistic replies — an in-flight optimistic +1 must not be overwritten by a stale server count.
        const merged = msgs.length > 0
          ? [{ ...msgs[0], replyCount: (isFullSilentRefresh && !pendingOptimisticThreadsRef.current.has(threadTs)) ? (msgs[0].replyCount ?? 0) : Math.max(msgs[0].replyCount ?? 0, prev[0]?.replyCount ?? 0) }, ...msgs.slice(1)]
          : msgs
        return optimisticTail.length > 0 ? [...merged, ...optimisticTail] : merged
      })
      // Incremental fetches add only new replies; they can't fix truncation of older messages.
      // Only a full-fetch (no oldest param) clears threadTruncated via the path above at line 904.
      // Keep the main channel list's replyCount in sync with the server's authoritative value.
      // On incremental fetches msgs[0] is a reply (not root) so replyCount is undefined there;
      // use rootReplyCount from the raw root message instead.
      setMessages(prev => prev.map(m => {
        if (m.ts !== threadTs) return m
        if (result.rootReplyCount === undefined) return m
        const hasPending = pendingOptimisticThreadsRef.current.has(threadTs)
        const resolvedCount = (hasPending || opts?.silent)
          ? Math.max(m.replyCount ?? 0, result.rootReplyCount)
          : result.rootReplyCount
        if (hasPending && result.rootReplyCount >= (m.replyCount ?? 0)) {
          pendingOptimisticThreadsRef.current.delete(threadTs)
        }
        return { ...m, replyCount: resolvedCount }
      }))
      if (opts?.silent) silentThreadPollFailCountRef.current = 0
    } catch (err) {
      console.error('[SlackView] Load thread error:', err)
      if (opts?.silent) silentThreadPollFailCountRef.current++
      if (mountedRef.current && !opts?.silent && viewingThreadTsRef.current === threadTs) {
        setThreadError(err instanceof Error ? err.message : 'Failed to load thread')
        setLoadMoreAttempted(false)
      }
    } finally {
      if (opts?.silent) silentThreadPollInFlightRef.current.delete(`${channelId}:${threadTs}`)
    }
  }, [])

  // ── Effects ──

  // Initial load
  useEffect(() => {
    mountedRef.current = true
    loadChannels()
    window.electronAPI.slackGetSelf().then(self => {
      if (self && mountedRef.current) {
        selfRef.current = self
        // If localStorage had a stale ID from a previous workspace, clear it before re-render
        const storedId = (() => { try { return localStorage.getItem('slack-self-id') } catch { return null } })()
        if (storedId && storedId !== self.id) { try { localStorage.removeItem('slack-self-id') } catch {} }
        setSelfId(self.id)
        try { localStorage.setItem('slack-self-id', self.id) } catch {}
        try {
          const _sv = localStorage.getItem(`slack-visited-${self.id}`)
          if (_sv) (JSON.parse(_sv) as string[]).forEach(id => visitedChannelIdsRef.current.add(id))
        } catch {}
      }
    }).catch(() => {})
    window.electronAPI.slackGetConnectionStatus().then(status => {
      if (!mountedRef.current) return
      try { if (status?.tokenKind && status.tokenKind !== 'none') localStorage.setItem('slack-token-kind', status.tokenKind) } catch {}
      if (status?.tokenKind) tokenKindRef.current = status.tokenKind
      connectionCheckedRef.current = true
      setConnection(status)
    }).catch(() => { if (mountedRef.current) connectionCheckedRef.current = true })
    window.electronAPI.slackGetOAuthConfig().then(cfg => {
      if (!mountedRef.current) return
      setOauthConfig(cfg)
      if (cfg.clientId) setClientIdInput(cfg.clientId)
    }).catch(() => {})
    return () => {
      mountedRef.current = false
      if (retryPollTimerRef.current) clearTimeout(retryPollTimerRef.current)
      if (visitedChannelWriteTimerRef.current) clearTimeout(visitedChannelWriteTimerRef.current)
    }
  }, [loadChannels])

  const refreshAfterConnect = useCallback(async (status: typeof connection) => {
    try { if (status?.tokenKind && status.tokenKind !== 'none') localStorage.setItem('slack-token-kind', status.tokenKind) } catch {}
    setConnection(status ?? null)
    selfRef.current = null
    setSelfId(undefined)
    try { localStorage.removeItem('slack-self-id') } catch {}
    window.electronAPI.slackGetSelf().then(self => {
      if (self && mountedRef.current) {
        selfRef.current = self
        setSelfId(self.id)
        try { localStorage.setItem('slack-self-id', self.id) } catch {}
        try {
          const _sv = localStorage.getItem(`slack-visited-${self.id}`)
          if (_sv) (JSON.parse(_sv) as string[]).forEach(id => visitedChannelIdsRef.current.add(id))
        } catch {}
      }
    }).catch(() => {})
    setChannels([])
    setSelectedChannelId(null)
    setMessages([])
    visitedChannelIdsRef.current.clear()
    lastMarkedTsRef.current.clear()
    markReadFailCountRef.current.clear()
    persistentUserMapRef.current.clear()
    setPersistentUserMapVersion(v => v + 1)
    newestChannelMsgTsRef.current.clear()
    newestThreadReplyTsRef.current.clear()
    silentThreadPollCountRef.current.clear()
    pendingOptimisticThreadsRef.current.clear()
    _thumbCache.clear()
    _attThumbCache.clear()
    pollFailCountRef.current = 0
    messagePollFailCountRef.current = 0
    setLoading(true)
    await loadChannels()
  }, [loadChannels])

  const handleOAuthConnect = useCallback(async () => {
    if (connecting) return
    setConnectError(null)

    // Save OAuth config if the user just entered it (or updated it)
    const clientId = clientIdInput.trim()
    const clientSecret = clientSecretInput.trim()
    if (!oauthConfig?.clientId || !oauthConfig?.hasSecret || clientSecret) {
      if (!clientId || !clientSecret) {
        setConnectError('Enter Client ID and Client Secret from api.slack.com/apps → Atlas → Basic Information.')
        return
      }
      const saved = await window.electronAPI.slackSaveOAuthConfig(clientId, clientSecret)
      if (!saved.ok) {
        setConnectError(saved.error || 'Failed to save credentials')
        return
      }
      setOauthConfig({ clientId, hasSecret: true })
      setClientSecretInput('')
    }

    setConnecting(true)
    try {
      const result = await window.electronAPI.slackStartOAuth()
      if (!result.ok) {
        setConnectError(result.error || 'OAuth failed')
        return
      }
      setShowConnectModal(false)
      await refreshAfterConnect(result.status ?? null)
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'OAuth failed')
    } finally {
      setConnecting(false)
    }
  }, [connecting, clientIdInput, clientSecretInput, oauthConfig, refreshAfterConnect])

  const handleConnectUserToken = useCallback(async () => {
    const token = tokenInput.trim()
    if (!token || connecting) return
    setConnecting(true)
    setConnectError(null)
    try {
      const result = await window.electronAPI.slackSetUserToken(token)
      if (!result.ok) {
        setConnectError(result.error || 'Failed to connect')
        return
      }
      setTokenInput('')
      setShowConnectModal(false)
      await refreshAfterConnect(result.status ?? null)
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setConnecting(false)
    }
  }, [tokenInput, connecting, refreshAfterConnect])

  // Channel polling — first-page poll every 60s; full multi-page load every 90s; immediate refresh on visibility restore
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadChannels(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    channelPollRef.current = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (!selfRef.current) {
        window.electronAPI.slackGetSelf().then(self => {
          if (self && mountedRef.current) {
            selfRef.current = self
            const storedId = (() => { try { return localStorage.getItem('slack-self-id') } catch { return null } })()
            if (storedId && storedId !== self.id) { try { localStorage.removeItem('slack-self-id') } catch {} }
            setSelfId(self.id)
            try { localStorage.setItem('slack-self-id', self.id) } catch {}
          }
        }).catch(() => {})
      }
      if (pollFailCountRef.current >= 3 && pollFailCountRef.current % 5 !== 0) return
      const now = Date.now()
      const fullLoadThreshold = 90_000
      if (now - lastFullChannelLoadRef.current >= fullLoadThreshold) {
        lastFullChannelLoadRef.current = now
        loadChannels()
      } else {
        loadChannels(true)
      }
    }, CHANNEL_POLL_MS)
    return () => {
      if (channelPollRef.current) clearInterval(channelPollRef.current)
      if (channelPollTriggerRef.current) clearTimeout(channelPollTriggerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadChannels])

  // Report unread count to parent
  useEffect(() => {
    if (onUnreadCount) {
      const count = channels.reduce((sum, ch) => sum + (ch.unreadCount ?? 0), 0)
      onUnreadCount(count)
    }
  }, [channels, onUnreadCount])

  // Message polling for selected channel; immediate refresh on visibility restore
  useEffect(() => {
    if (messagePollRef.current) {
      clearInterval(messagePollRef.current)
      messagePollRef.current = null
    }
    if (!selectedChannelId) return
    const onVisible = () => {
      if (document.visibilityState === 'visible' && selectedChannelRef.current) {
        loadMessages(selectedChannelRef.current, { silent: true })
        if (viewingThreadTsRef.current) loadThread(selectedChannelRef.current, viewingThreadTsRef.current, { silent: true })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    messagePollRef.current = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (messagePollFailCountRef.current >= 3 && messagePollFailCountRef.current % 5 !== 0) return
      if (selectedChannelRef.current) {
        loadMessages(selectedChannelRef.current, { silent: true })
        if (viewingThreadTsRef.current && !(silentThreadPollFailCountRef.current >= 3 && silentThreadPollFailCountRef.current % 5 !== 0)) {
          loadThread(selectedChannelRef.current, viewingThreadTsRef.current, { silent: true })
        }
      }
    }, MESSAGE_POLL_MS)
    return () => {
      if (messagePollRef.current) clearInterval(messagePollRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [selectedChannelId, loadMessages, loadThread])

  // Auto-scroll to bottom when messages change, unless user has scrolled up
  useEffect(() => {
    const newestTs = messages[0]?.ts
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
      setNewChannelMessages(0)
      newestMsgTsForPillRef.current = newestTs
    } else if (newestTs && newestMsgTsForPillRef.current && parseFloat(newestTs) > parseFloat(newestMsgTsForPillRef.current)) {
      const newMsgs = messages.filter(m => parseFloat(m.ts) > parseFloat(newestMsgTsForPillRef.current!))
      newestMsgTsForPillRef.current = newestTs
      setNewChannelMessages(prev => prev + newMsgs.length)
    } else {
      newestMsgTsForPillRef.current = newestTs
    }
  }, [messages])

  // Auto-scroll thread when thread messages change, unless user has scrolled up
  useEffect(() => {
    const newestTs = threadMessages?.[threadMessages.length - 1]?.ts
    if (!threadScrolledUpRef.current) {
      threadEndRef.current?.scrollIntoView({ behavior: 'instant' })
      setNewThreadMessages(0)
    } else if (newestTs && newestThreadTsForPillRef.current && parseFloat(newestTs) > parseFloat(newestThreadTsForPillRef.current)) {
      const newCount = (threadMessages ?? []).slice(1).filter(m => parseFloat(m.ts) > parseFloat(newestThreadTsForPillRef.current!)).length
      setNewThreadMessages(prev => prev + newCount)
    }
    if (newestTs !== undefined) newestThreadTsForPillRef.current = newestTs
  }, [threadMessages])

  // ── Handlers ──

  const handleSelectChannel = useCallback((channelId: string) => {
    if (channelId === selectedChannelRef.current) return
    if (selectedChannelRef.current) pendingOptimisticRef.current.delete(selectedChannelRef.current)
    if (viewingThreadTsRef.current && selectedChannelRef.current && threadReplyTextRef.current.trim() && !sendingThreadRef.current) {
      threadReplyDraftsRef.current.set(`${selectedChannelRef.current}:${viewingThreadTsRef.current}`, threadReplyTextRef.current)
    }
    if (retryPollTimerRef.current) { clearTimeout(retryPollTimerRef.current); retryPollTimerRef.current = null }
    if (selectedChannelRef.current) {
      silentMsgPollInFlightRef.current.delete(selectedChannelRef.current)
      gapReloadInProgressRef.current.delete(selectedChannelRef.current)
      markReadFailCountRef.current.delete(selectedChannelRef.current)
    }
    if (viewingThreadTsRef.current) {
      silentThreadPollCountRef.current.delete(`${selectedChannelRef.current}:${viewingThreadTsRef.current}`)
    }
    setIsSearchMode(false)
    setSearchResults([])
    setSearchTotal(0)
    setSearchQuery('')
    setSubmittedSlackQuery('')
    submittedSlackQueryRef.current = ''
    setChannelFilterQuery('')
    setSelectedChannelId(channelId)
    setMessages([])
    setError(null)
    msgNextCursorRef.current = null
    setMsgNextCursor(null)
    setMsgHasMore(false)
    setViewingThreadTs(null)
    threadFallbackChannelNameRef.current = null
    threadFallbackChannelIsDmRef.current = false
    setThreadMessages(null)
    setThreadTruncated(false)
    setLoadMoreAttempted(false)
    setThreadError(null)
    if (replyTextRef.current.trim() && selectedChannelRef.current) {
      mainDraftsRef.current.set(selectedChannelRef.current, replyTextRef.current)
    }
    const restoredMainDraft = mainDraftsRef.current.get(channelId) || ''
    if (restoredMainDraft) mainDraftsRef.current.delete(channelId)
    setReplyText(restoredMainDraft)
    if (restoredMainDraft && mainTextareaRef.current) {
      requestAnimationFrame(() => {
        const el = mainTextareaRef.current
        if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
      })
    } else if (mainTextareaRef.current) {
      mainTextareaRef.current.style.height = ''
    }
    setSendingMain(false)
    setSendingThread(false)
    sendingMainRef.current = false
    sendingThreadRef.current = false
    setMainSendError(null)
    setThreadSendError(null)
    setLoadingOlder(false)
    loadingOlderRef.current = null
    viewingThreadTsRef.current = null
    userScrolledUpRef.current = false
    setNewChannelMessages(0)
    messagePollFailCountRef.current = 0
    // Track visited channels so loadChannels polls keep the badge suppressed
    visitedChannelIdsRef.current.add(channelId)
    const _svid = selfRef.current?.id
    if (_svid) { if (visitedChannelWriteTimerRef.current) clearTimeout(visitedChannelWriteTimerRef.current); visitedChannelWriteTimerRef.current = setTimeout(() => { try { localStorage.setItem(`slack-visited-${_svid}`, JSON.stringify(Array.from(visitedChannelIdsRef.current))) } catch {} }, 400) }
    // Eagerly seed lastMarkedTsRef so the eviction check in loadChannels doesn't fire before loadMessages completes
    const knownTs = newestChannelMsgTsRef.current.get(channelId) || channelsRef.current.find(ch => ch.id === channelId)?.lastMessage?.ts
    lastMarkedTsRef.current.set(channelId, knownTs ? String((parseFloat(knownTs) - 0.000001).toFixed(6)) : '0')
    newestMsgTsForPillRef.current = newestChannelMsgTsRef.current.get(channelId)
    setChannels(prev => prev.map(ch => ch.id === channelId ? { ...ch, unreadCount: 0 } : ch))
    loadMessages(channelId)
  }, [loadMessages])

  const handleMessageScroll = useCallback(() => {
    const el = messageContainerRef.current
    if (!el) return
    const threshold = 80
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
    const wasScrolledUp = userScrolledUpRef.current
    userScrolledUpRef.current = !atBottom
    if (msgHasMore && el.scrollTop < 200 && !loadingMessagesRef.current && !loadingOlderRef.current && !gapReloadInProgressRef.current.has(selectedChannelRef.current ?? '')) {
      loadOlderMessages()
    }
    if (wasScrolledUp && atBottom && selectedChannelRef.current) {
      setNewChannelMessages(0)
      loadMessages(selectedChannelRef.current, { silent: true })
      setChannels(prev => prev.map(ch => ch.id === selectedChannelRef.current ? { ...ch, unreadCount: 0 } : ch))
    }
  }, [loadMessages, loadOlderMessages, msgHasMore])

  const handleThreadScroll = useCallback(() => {
    const el = threadContainerRef.current
    if (!el) return
    const threshold = 80
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold
    threadScrolledUpRef.current = !atBottom
    if (atBottom) setNewThreadMessages(0)
  }, [setNewThreadMessages])

  const handleSend = useCallback(async () => {
    if (!selectedChannelId || !replyText.trim() || sendingMainRef.current) return
    sendingMainRef.current = true
    setMainSendError(null)
    setSendingMain(true)
    const text = replyText.trim()
    try {
      const result = await window.electronAPI.slackSendMessage(selectedChannelId, text)
      setMainSendError(null)
      if (selectedChannelRef.current !== selectedChannelId) { if (mainDraftsRef.current.get(selectedChannelId) === text) mainDraftsRef.current.delete(selectedChannelId); return }
      userScrolledUpRef.current = false
      setReplyText(prev => (prev === text || prev.trim() === text) ? '' : prev)
      // Optimistic update: show sent message immediately before Slack API indexes it.
      // Skip when self-id is not yet known — the poll will bring in the real message.
      if (selectedChannelRef.current === selectedChannelId) {
        if (!result?.ts) {
          // Server ts unknown — dedup-by-ts would create a permanent duplicate; force-reload instead
          setTimeout(() => { if (mountedRef.current && selectedChannelRef.current === selectedChannelId) loadMessages(selectedChannelId, { silent: true }) }, 300)
        } else {
          const ts = result.ts
          const storedSelfId = (() => { try { return localStorage.getItem('slack-self-id') } catch { return null } })()
          const resolvedUserId = selfRef.current?.id || storedSelfId || null
          const optimistic: SlackMessage = {
            ts,
            channelId: selectedChannelId,
            userId: resolvedUserId ?? 'me',
            userName: resolvedUserId ? (selfRef.current?.displayName || persistentUserMapRef.current.get(resolvedUserId) || 'You') : 'You',
            userAvatar: selfRef.current?.avatar || undefined,
            text,
            date: new Date(parseFloat(ts) * 1000).toISOString(),
            isUnread: false,
            isOptimistic: true,
          }
          pendingOptimisticRef.current.add(selectedChannelId)
          setMessages(prev => prev.some(m => m.ts === ts) ? prev.map(m => m.ts === ts ? { ...m, isOptimistic: false } : m) : [optimistic, ...prev])
          setChannels(prev => prev.map(ch => ch.id === selectedChannelId ? { ...ch, lastMessage: { ts: optimistic.ts, channelId: selectedChannelId, userId: optimistic.userId, text: optimistic.text, date: optimistic.date, isUnread: false } } : ch))
        }
      }
    } catch (err) {
      console.error('[SlackView] Send error:', err)
      if (selectedChannelRef.current === selectedChannelId) setMainSendError('Failed to send message')
    } finally {
      sendingMainRef.current = false
      if (selectedChannelRef.current === selectedChannelId) setSendingMain(false)
    }
  }, [selectedChannelId, replyText, loadMessages])

  const handleSendThreadReply = useCallback(async () => {
    if (!selectedChannelId || !viewingThreadTs || !threadReplyText.trim() || sendingThreadRef.current || !threadMessages || threadMessages.length === 0) return
    sendingThreadRef.current = true
    setThreadSendError(null)
    const wasScrolledUp = threadScrolledUpRef.current
    threadScrolledUpRef.current = false
    setSendingThread(true)
    let lockReleased = false
    let optimisticTs: string | null = null
    let preReplyCount = 0
    const trimmedReply = threadReplyText.trim()
    try {
      const result = await window.electronAPI.slackSendMessage(selectedChannelId, trimmedReply, { threadTs: viewingThreadTs })
      if (selectedChannelRef.current !== selectedChannelId || viewingThreadTsRef.current !== viewingThreadTs) { return }
      // Clear input only when still in the same thread context
      setThreadReplyText(prev => prev === trimmedReply || prev.trim() === trimmedReply ? '' : prev)
      // Optimistic update: show reply immediately before Slack API indexes it.
      // Skip when self-id is not yet known — the poll will bring in the real message.
      if (selectedChannelRef.current === selectedChannelId && viewingThreadTsRef.current === viewingThreadTs) {
        if (!result?.ts) {
          // Server ts unknown — dedup-by-ts would create a duplicate; force-reload to get real state
          loadThread(selectedChannelId, viewingThreadTs).catch(() => {})
        } else {
        const storedSelfId = (() => { try { return localStorage.getItem('slack-self-id') } catch { return null } })()
        const resolvedUserId = selfRef.current?.id || selfId || storedSelfId || null
        const ts = result.ts
        optimisticTs = ts
        const optimistic: SlackMessage = {
          ts,
          threadTs: viewingThreadTs,
          channelId: selectedChannelId,
          userId: resolvedUserId ?? 'me',
          userName: resolvedUserId ? (selfRef.current?.displayName || persistentUserMapRef.current.get(resolvedUserId) || 'You') : 'You',
          userAvatar: selfRef.current?.avatar || undefined,
          text: trimmedReply,
          date: new Date(parseFloat(ts) * 1000).toISOString(),
          isUnread: false,
          isOptimistic: true,
        }
        preReplyCount = threadMessages[0]?.replyCount ?? 0
        setThreadMessages(prev => {
          if (!prev) return [optimistic]
          if (prev.some(m => m.ts === optimistic.ts)) return prev.map(m => m.ts === optimistic.ts ? { ...m, isOptimistic: false } : m)
          return [...prev.slice(0, 1).map(m => ({ ...m, replyCount: (m.replyCount ?? 0) + 1 })), ...prev.slice(1), optimistic]
        })
        setMessages(prev => prev.map(m => m.ts === viewingThreadTs ? { ...m, replyCount: (m.replyCount ?? 0) + 1 } : m))
        pendingOptimisticThreadsRef.current.add(viewingThreadTs)
        }
      }
      // Release send lock before post-send reloads — reloads are for freshness only
      setSendingThread(false)
      sendingThreadRef.current = false
      lockReleased = true
      const wasBlockedMsg = silentMsgPollInFlightRef.current.get(selectedChannelId)
      const wasBlockedThread = viewingThreadTs ? silentThreadPollInFlightRef.current.get(`${selectedChannelId}:${viewingThreadTs}`) : false
      try {
        // Refresh main messages to update reply count; refresh thread for any concurrent replies
        await loadMessages(selectedChannelId, { silent: true })
        if (viewingThreadTs) await loadThread(selectedChannelId, viewingThreadTs, { silent: true })
      } catch {
        // Reload failed; 30-second poll will refresh
      }
      // If either in-flight poll blocked the refresh above, retry after 2s
      if (wasBlockedMsg || wasBlockedThread) {
        if (retryPollTimerRef.current) clearTimeout(retryPollTimerRef.current)
        retryPollTimerRef.current = setTimeout(() => { if (mountedRef.current && selectedChannelRef.current === selectedChannelId) { silentMsgPollInFlightRef.current.delete(selectedChannelId); loadMessages(selectedChannelId, { silent: true }); if (viewingThreadTsRef.current) loadThread(selectedChannelId, viewingThreadTsRef.current, { silent: true }) } }, 2000)
      }
    } catch (err) {
      threadScrolledUpRef.current = wasScrolledUp
      console.error('[SlackView] Thread reply error:', err)
      if (optimisticTs !== null) {
        const ts = optimisticTs
        setThreadMessages(prev => prev
          ? prev.filter(m => m.ts !== ts).map((m, idx) =>
              idx === 0 ? { ...m, replyCount: preReplyCount } : m
            )
          : prev
        )
        pendingOptimisticThreadsRef.current.delete(viewingThreadTs)
        setMessages(prev => prev.map(m => m.ts === viewingThreadTs ? { ...m, replyCount: Math.max(0, (m.replyCount ?? 0) - 1) } : m))
        if (viewingThreadTs) loadThread(selectedChannelId, viewingThreadTs, { silent: true }).catch(() => {})
      }
      if (selectedChannelRef.current === selectedChannelId && viewingThreadTsRef.current === viewingThreadTs) {
        setThreadSendError('Failed to send reply')
      }
      if (viewingThreadTsRef.current !== viewingThreadTs) {
        threadReplyDraftsRef.current.set(`${selectedChannelId}:${viewingThreadTs}`, trimmedReply)
      }
    } finally {
      if (!lockReleased) {
        setSendingThread(false)
        sendingThreadRef.current = false
      }
    }
  }, [selectedChannelId, viewingThreadTs, threadReplyText, threadMessages, loadThread, loadMessages, selfId])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!sendingMain) handleSend()
    }
  }, [handleSend, sendingMain])

  const handleThreadKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!sendingThread) handleSendThreadReply()
    }
  }, [handleSendThreadReply, sendingThread])

  const handleOpenThread = useCallback((threadTs: string) => {
    if (!selectedChannelId) return
    if (threadTs === viewingThreadTsRef.current) return
    if (viewingThreadTsRef.current && selectedChannelRef.current && threadReplyTextRef.current.trim() && !sendingThreadRef.current) {
      threadReplyDraftsRef.current.set(`${selectedChannelRef.current}:${viewingThreadTsRef.current}`, threadReplyTextRef.current)
    }
    threadFallbackChannelNameRef.current = null
    threadScrolledUpRef.current = false
    setThreadTruncated(false)
    setLoadMoreAttempted(false)
    setNewThreadMessages(0)
    newestThreadTsForPillRef.current = newestThreadReplyTsRef.current.get(`${selectedChannelId}:${threadTs}`)
    if (!sendingThreadRef.current) setSendingThread(false)
    viewingThreadTsRef.current = threadTs
    setViewingThreadTs(threadTs)
    setThreadMessages(null)
    setMainSendError(null)
    setThreadError(null)
    setThreadSendError(null)
    const draftKey = `${selectedChannelId}:${threadTs}`
    const savedDraft = threadReplyDraftsRef.current.get(draftKey) || ''
    threadReplyDraftsRef.current.delete(draftKey)
    setThreadReplyText(savedDraft)
    if (savedDraft && threadTextareaRef.current) {
      requestAnimationFrame(() => {
        const el = threadTextareaRef.current
        if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
      })
    } else if (threadTextareaRef.current) {
      threadTextareaRef.current.style.height = ''
    }
    loadThread(selectedChannelId, threadTs)
  }, [selectedChannelId, loadThread])

  const handleCloseThread = useCallback(() => {
    setSendingThread(false)
    const closingKey = `${selectedChannelRef.current}:${viewingThreadTsRef.current}`
    if (threadReplyTextRef.current && selectedChannelRef.current && viewingThreadTsRef.current) {
      threadReplyDraftsRef.current.set(`${selectedChannelRef.current}:${viewingThreadTsRef.current}`, threadReplyTextRef.current)
    }
    silentThreadPollCountRef.current.delete(closingKey)
    silentThreadPollInFlightRef.current.delete(closingKey)
    threadFallbackChannelNameRef.current = null
    viewingThreadTsRef.current = null
    setViewingThreadTs(null)
    setThreadMessages(null)
    setThreadError(null)
    setThreadSendError(null)
    setThreadReplyText('')
    setThreadTruncated(false)
    setLoadMoreAttempted(false)
  }, [])

  const handleSearchKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      setSubmittedSlackQuery(searchQuery.trim())
      setChannelFilterQuery('')
      setIsSearchMode(true)
      setSearchLoading(true)
      setSearchResults([])
      setSearchTotal(0)
      setSearchPage(1)
      setSearchError(null)
      setSearchLoadMoreError(null)
      if (searchScrollRef.current) searchScrollRef.current.scrollTop = 0
      if (viewingThreadTsRef.current) silentThreadPollCountRef.current.delete(`${selectedChannelRef.current}:${viewingThreadTsRef.current}`)
      if (viewingThreadTsRef.current && selectedChannelRef.current && threadReplyTextRef.current.trim()) {
        threadReplyDraftsRef.current.set(`${selectedChannelRef.current}:${viewingThreadTsRef.current}`, threadReplyTextRef.current)
      }
      viewingThreadTsRef.current = null
      setViewingThreadTs(null)
      setThreadMessages(null)
      setThreadError(null)
      setThreadReplyText('')
      const query = searchQuery.trim()
      submittedSlackQueryRef.current = query
      try {
        const result = await window.electronAPI.slackSearchMessages(query)
        if (!mountedRef.current) return
        if (submittedSlackQueryRef.current !== query) return
        if (result.userMap) {
          for (const [id, name] of Object.entries(result.userMap)) {
            persistentUserMapRef.current.set(id, name)
          }
          setPersistentUserMapVersion(v => v + 1)
        }
        setSearchResults(result.messages)
        const imUserIdToChannelId = new Map(
          (result.messages as SlackMessage[])
            .filter(m => m.channelIsIm && m.channelName && /^[UW][0-9A-Z]{6,}$/.test(m.channelName))
            .map(m => [m.channelName as string, m.channelId])
        )
        const unresolvedImIds = [...new Set(
          (result.messages as SlackMessage[])
            .filter(m => m.channelIsIm && m.channelName && /^[UW][0-9A-Z]{6,}$/.test(m.channelName) && !persistentUserMapRef.current.has(m.channelName))
            .map(m => m.channelName as string)
        )]
        if (unresolvedImIds.length > 0) {
          Promise.allSettled(unresolvedImIds.map(async (userId) => {
            try {
              const user = await window.electronAPI.slackGetUser(userId)
              if (!mountedRef.current) return
              const resolved = user.displayName || user.realName || user.name
              if (!resolved) return
              persistentUserMapRef.current.set(userId, resolved)
              const chId = imUserIdToChannelId.get(userId)
              if (chId) persistentUserMapRef.current.set(chId, resolved)
              setPersistentUserMapVersion(v => v + 1)
            } catch {
              persistentUserMapRef.current.set(userId, 'Unknown User')
              if (mountedRef.current) setPersistentUserMapVersion(v => v + 1)
            }
          }))
        }
        setSearchTotal(result.total)
      } catch (err) {
        console.error('[slack] search failed', err)
        setSearchError(err instanceof Error ? err.message : 'Search failed')
      } finally {
        setSearchLoading(false)
      }
    } else if (e.key === 'Escape') {
      setSearchQuery('')
      setChannelFilterQuery('')
      setIsSearchMode(false)
      setSearchResults([])
      setSearchTotal(0)
      setSearchError(null)
      setSearchLoadMoreError(null)
      setMainSendError(null)
      setThreadSendError(null)
      submittedSlackQueryRef.current = ''
      setSubmittedSlackQuery('')
      if (isSearchMode) {
        if (selectedChannelRef.current) loadMessages(selectedChannelRef.current, { silent: true })
        if (viewingThreadTsRef.current && selectedChannelRef.current) loadThread(selectedChannelRef.current, viewingThreadTsRef.current, { silent: true })
      }
    }
  }, [searchQuery, isSearchMode, loadMessages, loadThread])

  const loadMoreSearch = useCallback(async () => {
    const query = submittedSlackQueryRef.current
    if (!query || loadMoreSearchInFlightRef.current) return
    loadMoreSearchInFlightRef.current = true
    const nextPage = searchPage + 1
    setSearchLoadingMore(true)
    try {
      const result = await window.electronAPI.slackSearchMessages(query, { page: nextPage })
      if (submittedSlackQueryRef.current !== query) return
      if (!mountedRef.current) return
      if (result.userMap) {
        for (const [id, name] of Object.entries(result.userMap)) {
          persistentUserMapRef.current.set(id, name)
        }
        setPersistentUserMapVersion(v => v + 1)
      }
      setSearchResults(prev => {
        const seen = new Set(prev.map(m => m.ts + ':' + m.channelId))
        return [...prev, ...result.messages.filter(m => !seen.has(m.ts + ':' + m.channelId))]
      })
      setSearchTotal(result.total)
      setSearchPage(nextPage)
    } catch (err) {
      console.error('[slack] load more search failed', err)
      setSearchLoadMoreError(err instanceof Error ? err.message : 'Failed to load more results')
    } finally {
      loadMoreSearchInFlightRef.current = false
      setSearchLoadingMore(false)
    }
  }, [searchPage])

  // ── Derived Data ──

  const filteredChannels = useMemo(() => {
    if (!channelFilterQuery.trim()) return channels
    const q = channelFilterQuery.toLowerCase()
    return channels.filter(ch => channelDisplayName(ch).toLowerCase().includes(q))
  }, [channels, channelFilterQuery])

  const channelGroups = useMemo(() => {
    const chans = filteredChannels.filter(ch => (ch.isChannel || ch.isPrivate) && !ch.isIm && !ch.isMpim)
    const dms = filteredChannels.filter(ch => ch.isIm || ch.isMpim)
    return { channels: chans, directMessages: dms }
  }, [filteredChannels])

  const selectedChannel = useMemo(
    () => channels.find(ch => ch.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  )

  // Accumulate resolved users across channel navigations so @mentions can be resolved
  // even for users who only appear in previous channel pages
  useEffect(() => {
    // Re-populate active users first so they land at the tail of the Map
    // and are not among the oldest-inserted entries chosen for eviction
    let added = false
    for (const msg of messages) {
      if (msg.userId && msg.userName && msg.userName !== 'Unknown User') {
        if (!persistentUserMapRef.current.has(msg.userId)) added = true
        persistentUserMapRef.current.delete(msg.userId)
        persistentUserMapRef.current.set(msg.userId, msg.userName)
      }
    }
    for (const msg of threadMessages || []) {
      if (msg.userId && msg.userName && msg.userName !== 'Unknown User') {
        if (!persistentUserMapRef.current.has(msg.userId)) added = true
        persistentUserMapRef.current.delete(msg.userId)
        persistentUserMapRef.current.set(msg.userId, msg.userName)
      }
    }
    for (const msg of searchResults) {
      if (msg.userId && msg.userName && msg.userName !== 'Unknown User') {
        if (!persistentUserMapRef.current.has(msg.userId)) added = true
        persistentUserMapRef.current.delete(msg.userId)
        persistentUserMapRef.current.set(msg.userId, msg.userName)
      }
    }
    let evicted = false
    if (Date.now() - lastEvictionRef.current >= 5 * 60 * 1000) {
      lastEvictionRef.current = Date.now()
      if (persistentUserMapRef.current.size > 1000) {
        const keepSet = new Set<string>()
        channelsRef.current.forEach(ch => { if (ch.userId && (ch.displayName || ch.isIm)) keepSet.add(ch.userId) })
        const keys = Array.from(persistentUserMapRef.current.keys())
        keys.slice(0, keys.length - 750).forEach(k => { if (!keepSet.has(k)) persistentUserMapRef.current.delete(k) })
        evicted = true
      }
      if (lastMarkedTsRef.current.size > 500) {
        const keys = Array.from(lastMarkedTsRef.current.keys())
        keys.slice(0, keys.length - 375).forEach(k => lastMarkedTsRef.current.delete(k))
      }
      if (visitedChannelIdsRef.current.size > 2000) {
        const keys = Array.from(visitedChannelIdsRef.current.keys())
        keys.slice(0, keys.length - 1500).forEach(k => visitedChannelIdsRef.current.delete(k))
      }
      if (newestThreadReplyTsRef.current.size > 500) {
        const keys = Array.from(newestThreadReplyTsRef.current.keys())
        keys.slice(0, keys.length - 375).forEach(k => newestThreadReplyTsRef.current.delete(k))
      }
      if (newestChannelMsgTsRef.current.size > 500) {
        const keys = Array.from(newestChannelMsgTsRef.current.keys())
        keys.slice(0, keys.length - 375).forEach(k => newestChannelMsgTsRef.current.delete(k))
      }
      if (silentThreadPollCountRef.current.size > 200) {
        const keys = Array.from(silentThreadPollCountRef.current.keys())
        keys.slice(0, keys.length - 150).forEach(k => silentThreadPollCountRef.current.delete(k))
      }
      if (silentMsgPollInFlightRef.current.size > 500) {
        const keys = Array.from(silentMsgPollInFlightRef.current.keys())
        keys.slice(0, keys.length - 375).forEach(k => silentMsgPollInFlightRef.current.delete(k))
      }
      if (threadReplyDraftsRef.current.size > 200) {
        const keys = Array.from(threadReplyDraftsRef.current.keys())
        keys.slice(0, keys.length - 150).forEach(k => threadReplyDraftsRef.current.delete(k))
      }
      if (mainDraftsRef.current.size > 200) {
        const keys = Array.from(mainDraftsRef.current.keys())
        keys.slice(0, keys.length - 150).forEach(k => mainDraftsRef.current.delete(k))
      }
    }
    if (added || evicted) setPersistentUserMapVersion(v => v + 1)
  }, [messages, threadMessages, searchResults])

  // Focus trap for connect modal
  useEffect(() => {
    if (!showConnectModal) return
    const modal = connectModalRef.current
    if (!modal) return
    const focusable = 'button, input, textarea, [tabindex]:not([tabindex="-1"])'
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const els = Array.from(modal.querySelectorAll<HTMLElement>(focusable)).filter(el => !el.closest('.hidden'))
      if (!els.length) return
      const first = els[0]
      const last = els[els.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [showConnectModal])

  useEffect(() => {
    const el = threadTextareaRef.current
    if (!threadReplyText) { if (el) el.style.height = ''; return }
    if (threadResizeDoneByOnChange.current) { threadResizeDoneByOnChange.current = false; return }
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [threadReplyText])

  useEffect(() => {
    if (!replyText && mainTextareaRef.current) mainTextareaRef.current.style.height = ''
  }, [replyText])

  /** Map of channelId → display name for resolving bare <#CXXXXXXX> references */
  const channelMapKey = useMemo(() => channels.map(c => c.id + ':' + channelDisplayName(c)).join(','), [channels])
  const channelMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const ch of channels) map.set(ch.id, channelDisplayName(ch))
    return map
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelMapKey])

  /** Group messages by date for separators */
  const messagesWithSeparators = useMemo(() => {
    type SepItem = { type: 'separator'; date: string; key: string }
    type MsgItem = { type: 'message'; message: SlackMessage; key: string }
    const items: (SepItem | MsgItem)[] = []
    let lastDate = ''

    // conversations.history returns newest-first; iterate in reverse for oldest-first display
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const _d = msg.date ? new Date(msg.date) : null
      const msgDate = _d && !isNaN(_d.getTime()) ? [_d.getFullYear(), String(_d.getMonth()+1).padStart(2,'0'), String(_d.getDate()).padStart(2,'0')].join('-') : 'unknown'
      if (msgDate !== lastDate) {
        if (msgDate !== 'unknown') {
          lastDate = msgDate
          items.push({ type: 'separator', date: msg.date, key: `sep-${msgDate}` })
        }
      }
      items.push({ type: 'message', message: msg, key: msg.ts })
    }

    return items
  }, [messages])

  /** Same date-separator grouping for thread replies (excludes parent message at index 0) */
  const threadRepliesWithSeparators = useMemo(() => {
    type SepItem = { type: 'separator'; date: string; key: string }
    type MsgItem = { type: 'message'; message: SlackMessage; key: string }
    const items: (SepItem | MsgItem)[] = []
    if (!threadMessages || threadMessages.length <= 1) return items
    const _d0 = threadMessages[0]?.date ? new Date(threadMessages[0].date) : null
    let lastDate = _d0 && !isNaN(_d0.getTime()) ? [_d0.getFullYear(), String(_d0.getMonth()+1).padStart(2,'0'), String(_d0.getDate()).padStart(2,'0')].join('-') : ''
    for (const msg of threadMessages.slice(1)) {
      const _d = msg.date ? new Date(msg.date) : null
      const msgDate = _d && !isNaN(_d.getTime()) ? [_d.getFullYear(), String(_d.getMonth()+1).padStart(2,'0'), String(_d.getDate()).padStart(2,'0')].join('-') : 'unknown'
      if (msgDate !== lastDate) {
        if (msgDate !== 'unknown') {
          lastDate = msgDate
          items.push({ type: 'separator', date: msg.date, key: `sep-${msgDate}` })
        }
      }
      items.push({ type: 'message', message: msg, key: msg.ts })
    }
    return items
  }, [threadMessages])

  // ── Render ──

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-0">
        <div className="text-center">
          <div className="skeleton w-48 h-6 mx-auto mb-3" />
          <div className="skeleton w-32 h-4 mx-auto" />
        </div>
      </div>
    )
  }

  const usingBotToken = connection?.tokenKind === 'bot'
  const notConnected = connectionCheckedRef.current && (!connection || connection.tokenKind === 'none' || connection.connected === false)

  return (
    <div className="flex-1 flex flex-col bg-surface-0 overflow-hidden">
      {/* ── Connection banner: shown when bot-only or disconnected ── */}
      {(usingBotToken || notConnected) && (
        <div className="flex items-center justify-between gap-3 px-5 py-2 bg-yellow-50 border-b border-yellow-200/60">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 flex-shrink-0 text-yellow-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M4.93 4.93l14.14 14.14M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[12px] text-yellow-900 truncate">
              {notConnected
                ? 'Slack not connected — you\'re missing all channels and chats.'
                : 'Only showing channels your bot is in. Connect a user token to see your full Slack.'}
            </span>
          </div>
          <button
            onClick={() => { setShowConnectModal(true); setConnectError(null) }}
            className="flex-shrink-0 text-[11px] font-semibold px-3 py-1 rounded-lg bg-yellow-700 text-white hover:bg-yellow-800 transition-colors"
          >
            Connect
          </button>
        </div>
      )}

      {/* ── Connect modal ── */}
      {showConnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!connecting) { setShowConnectModal(false); setTokenInput(''); setClientSecretInput(''); setConnectError(null) } }}>
          <div
            ref={connectModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-slack-title"
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="connect-slack-title" className="text-[15px] font-semibold text-text-1 mb-1">Connect Slack</h2>
            <p className="text-[12px] text-text-2 mb-4">
              Sign in to your Slack workspace to see all your channels, DMs, and history.
            </p>

            {(!oauthConfig?.clientId || !oauthConfig?.hasSecret) && (
              <div className="mb-4 space-y-2">
                <p className="text-[11px] text-text-2">
                  One-time setup — from{' '}
                  <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-purple-1 hover:underline">api.slack.com/apps → Atlas → Basic Information</a>:
                </p>
                <input
                  type="text"
                  value={clientIdInput}
                  onChange={(e) => { setClientIdInput(e.target.value); setConnectError(null) }}
                  placeholder="Client ID"
                  className="w-full text-[12px] font-mono text-text-1 bg-surface-1 rounded-xl px-3 py-2 border border-black/[0.08] focus:outline-none focus:border-purple-1/40"
                />
                <input
                  type="password"
                  value={clientSecretInput}
                  onChange={(e) => { setClientSecretInput(e.target.value); setConnectError(null) }}
                  placeholder="Client Secret"
                  className="w-full text-[12px] font-mono text-text-1 bg-surface-1 rounded-xl px-3 py-2 border border-black/[0.08] focus:outline-none focus:border-purple-1/40"
                />
                <p className="text-[10px] text-text-3">
                  Also add redirect URL <code className="bg-surface-1 px-1 rounded">http://localhost:53682/slack/callback</code> in the app's <strong>OAuth &amp; Permissions</strong> page, plus User Token Scopes (channels/groups/im/mpim history+read, users:read, search:read, chat:write).
                </p>
              </div>
            )}

            <button
              onClick={handleOAuthConnect}
              disabled={connecting}
              className="w-full text-[13px] font-semibold text-white px-4 py-2.5 rounded-xl bg-purple-1 hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {connecting ? 'Opening browser…' : (
                <>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>
                  Sign in with Slack
                </>
              )}
            </button>

            {connectError && <p className="text-[11px] text-red-1 mt-2">{connectError}</p>}

            <div className="mt-4 pt-3 border-t border-black/[0.06]">
              <button
                onClick={() => setShowManualToken(v => !v)}
                className="text-[11px] text-text-3 hover:text-text-2 transition-colors"
              >
                {showManualToken ? '▴ Hide manual token entry' : '▾ Or paste a token manually'}
              </button>
              {showManualToken && (
                <div className="mt-2">
                  <textarea
                    value={tokenInput}
                    onChange={(e) => { setTokenInput(e.target.value); setConnectError(null) }}
                    placeholder="xoxp-..."
                    rows={2}
                    className="w-full text-[12px] font-mono text-text-1 bg-surface-1 rounded-xl px-3 py-2 border border-black/[0.08] focus:outline-none focus:border-purple-1/40 resize-none"
                  />
                  <button
                    onClick={handleConnectUserToken}
                    disabled={!(/^xox[pe]-|^xoxe\.xoxp-/.test(tokenInput.trim())) || connecting}
                    className="mt-2 text-[12px] font-semibold text-text-1 px-3 py-1.5 rounded-lg bg-surface-1 hover:bg-black/[0.04] transition-colors disabled:opacity-40"
                  >
                    {connecting ? 'Verifying…' : 'Save token'}
                  </button>
                  {tokenInput.trim().startsWith('xoxb-') && (
                    <p className="mt-1 text-[11px] text-red-500">Bot tokens (xoxb-) are not supported — paste a user token (xoxp-) instead.</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end mt-4">
              <button
                onClick={() => { setShowConnectModal(false); setTokenInput(''); setClientSecretInput(''); setConnectError(null) }}
                disabled={connecting}
                className="text-[12px] text-text-2 px-3 py-1.5 rounded-lg hover:bg-black/[0.04] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top Bar ── */}
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-black/[0.06]">
        <div className="relative flex-1 max-w-[320px]">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3/50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            aria-label={isSearchMode ? 'Search messages' : 'Search channels'}
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); if (!isSearchMode) setChannelFilterQuery(e.target.value); if (!e.target.value) { setIsSearchMode(false); setSearchResults([]); setSearchTotal(0); setChannelFilterQuery(''); submittedSlackQueryRef.current = ''; setSubmittedSlackQuery(''); if (selectedChannelRef.current && !silentMsgPollInFlightRef.current.get(selectedChannelRef.current)) loadMessages(selectedChannelRef.current, { silent: true }) } }}
            onKeyDown={handleSearchKeyDown}
            placeholder={searchQuery ? 'Search messages — press Enter' : 'Search channels...'}
            className="w-full text-[12px] text-text-1 bg-surface-1 rounded-xl pl-9 pr-3 py-2 border border-transparent focus:outline-none focus:border-purple-1/30 placeholder:text-text-3/40 transition-colors"
          />
        </div>
        <button
          onClick={() => { setMainSendError(null); setThreadSendError(null); loadChannels(); if (selectedChannelId) loadMessages(selectedChannelId); if (selectedChannelId && viewingThreadTsRef.current) loadThread(selectedChannelId, viewingThreadTsRef.current) }}
          aria-label="Refresh Slack"
          className="p-2 text-text-3 hover:text-text-1 hover:bg-surface-1 rounded-xl transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        {error && (
          <span className="text-[11px] text-red-1 ml-2">{error}</span>
        )}
      </div>

      {/* ── Main Content ── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Channel Sidebar ── */}
        <div className="flex flex-col border-r border-black/[0.06] overflow-y-auto scrollbar-hide" style={{ width: 240 }}>
          {/* Channels section */}
          {channelGroups.channels.length > 0 && (
            <div className="pt-3 pb-1">
              <h3 className="px-3 text-[10px] font-semibold text-text-3 uppercase tracking-wider mb-1">Channels</h3>
              {channelGroups.channels.map(ch => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  selected={ch.id === selectedChannelId}
                  onClick={() => handleSelectChannel(ch.id)}
                />
              ))}
            </div>
          )}

          {/* Direct Messages section */}
          {channelGroups.directMessages.length > 0 && (
            <div className="pt-3 pb-1">
              <h3 className="px-3 text-[10px] font-semibold text-text-3 uppercase tracking-wider mb-1">Direct Messages</h3>
              {channelGroups.directMessages.map(ch => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  selected={ch.id === selectedChannelId}
                  onClick={() => handleSelectChannel(ch.id)}
                />
              ))}
            </div>
          )}

          {filteredChannels.length === 0 && (
            <div className="flex-1 flex items-center justify-center px-4 py-8">
              <p className="text-[11px] text-text-3 text-center">
                {channelFilterQuery ? 'No channels match your search' : 'No channels found'}
              </p>
            </div>
          )}
        </div>

        {/* ── Message Area ── */}
        <div className="flex-1 flex min-w-0">
          {/* Messages + input */}
          <div className="flex-1 flex flex-col min-w-0">
            {isSearchMode ? (
              <>
                <div className="flex items-center gap-2 px-4 py-2 border-b border-black/[0.06]">
                  <h2 className="text-[13px] font-semibold text-text-1">Search: {submittedSlackQuery}</h2>
                  {!searchLoading && <span className="text-[11px] text-text-3">{searchTotal > searchResults.length ? `${searchResults.length} of ${searchTotal} results` : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`}</span>}
                </div>
                <div ref={searchScrollRef} className="flex-1 overflow-y-auto scrollbar-hide">
                  {searchLoading ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="skeleton w-40 h-4" />
                    </div>
                  ) : searchError && searchResults.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-[12px] text-red-1">{searchError}</p>
                    </div>
                  ) : searchResults.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-[12px] text-text-3">No results found</p>
                    </div>
                  ) : (
                    <div className="py-2">
                      {searchResults.map(msg => {
                        const ch = channels.find(c => c.id === msg.channelId)
                        const isRawChannelId = (name: string) => /^[CG][0-9A-Z]{6,}$/.test(name)
                        const parseMpdmName = (name: string) => name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ')
                        const resolveImName = (name: string) => {
                          if (name === 'Direct Message') return null
                          if (!/^[UW][0-9A-Z]{6,}$/.test(name)) return name
                          const fromRef = persistentUserMapRef.current.get(name)
                          if (fromRef && fromRef !== 'Unknown User') return fromRef
                          return null
                        }
                        const chLabel = ch ? (ch.isIm ? (channelDisplayName(ch) === 'Direct Message' ? (ch.userId && persistentUserMapRef.current.get(ch.userId) && persistentUserMapRef.current.get(ch.userId) !== 'Unknown User' ? '@' + persistentUserMapRef.current.get(ch.userId) : 'Direct Message') : '@' + channelDisplayName(ch)) : channelPrefix(ch) + channelDisplayName(ch)) : (msg.channelName ? (msg.channelIsMpim ? (msg.channelName ? parseMpdmName(msg.channelName) : 'Group DM') : msg.channelIsIm ? ((r => r ? '@' + r : 'Direct Message')(persistentUserMapRef.current.get(msg.channelId) || channelMap.get(msg.channelId) || resolveImName(msg.channelName!))) : (isRawChannelId(msg.channelName) ? (channelMap.get(msg.channelId) ? '#' + channelMap.get(msg.channelId) : 'Unknown channel') : '#' + msg.channelName)) : (msg.channelIsMpim ? 'Group DM' : msg.channelIsIm ? 'Direct Message' : 'Unknown channel'))
                        return (
                          <div key={msg.channelId + '/' + msg.ts}>
                            <div className="px-4 pt-2 pb-0.5">
                              <span className="text-[10px] text-text-3 font-medium">{chLabel}</span>
                            </div>
                            <MessageBubble
                              message={msg}
                              userMapRef={persistentUserMapRef}
                              userMapVersion={persistentUserMapVersion}
                              channelMap={channelMap}
                              currentThreadTs={viewingThreadTs}
                              selfId={selfId ?? selfRef.current?.id}
                              containerRef={searchScrollRef}
                              onThreadClick={msg.channelId ? (threadTs) => {
                                setIsSearchMode(false)
                                setSearchResults([])
                                setSearchTotal(0)
                                setSearchQuery('')
                                setChannelFilterQuery('')
                                handleSelectChannel(msg.channelId)
                                threadFallbackChannelNameRef.current = msg.channelName || null
                                threadFallbackChannelIsDmRef.current = !!(msg.channelIsIm || msg.channelIsMpim)
                                sendingThreadRef.current = false
                                setSendingThread(false)
                                if (viewingThreadTsRef.current && selectedChannelRef.current && threadReplyTextRef.current.trim()) {
                                  threadReplyDraftsRef.current.set(`${selectedChannelRef.current}:${viewingThreadTsRef.current}`, threadReplyTextRef.current)
                                }
                                threadScrolledUpRef.current = false
                                newestThreadTsForPillRef.current = newestThreadReplyTsRef.current.get(`${msg.channelId}:${threadTs}`) ?? undefined
                                setNewThreadMessages(0)
                                setThreadTruncated(false)
                                setLoadMoreAttempted(false)
                                viewingThreadTsRef.current = threadTs
                                setViewingThreadTs(threadTs)
                                setThreadMessages(null)
                                setThreadError(null)
                                setThreadSendError(null)
                                const draftKey = `${msg.channelId}:${threadTs}`
                                const savedDraft = threadReplyDraftsRef.current.get(draftKey) || ''
                                threadReplyDraftsRef.current.delete(draftKey)
                                setThreadReplyText(savedDraft)
                                if (savedDraft && threadTextareaRef.current) {
                                  requestAnimationFrame(() => {
                                    const el = threadTextareaRef.current
                                    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
                                  })
                                } else if (threadTextareaRef.current) {
                                  threadTextareaRef.current.style.height = ''
                                }
                                silentThreadPollCountRef.current.delete(`${msg.channelId}:${threadTs}`)
                                loadThread(msg.channelId, threadTs)
                              } : undefined}
                            />
                          </div>
                        )
                      })}
                      {searchResults.length < searchTotal && (
                        <div className="flex flex-col items-center py-3 gap-1">
                          {searchLoadMoreError && (
                            <p className="text-[11px] text-red-1">{searchLoadMoreError}</p>
                          )}
                          <button
                            onClick={() => { setSearchLoadMoreError(null); loadMoreSearch() }}
                            disabled={searchLoadingMore}
                            className="text-[11px] text-text-3 hover:text-text-1 disabled:opacity-50 cursor-pointer disabled:cursor-default px-3 py-1.5 rounded-lg hover:bg-black/[0.04] transition-colors"
                          >
                            {searchLoadingMore ? 'Loading…' : `Load more (${searchTotal - searchResults.length} remaining)`}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : selectedChannelId ? (
              <>
                {/* Channel header */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-black/[0.06]">
                  <h2 className="text-[13px] font-semibold text-text-1">
                    {selectedChannel ? `${channelPrefix(selectedChannel)}${channelDisplayName(selectedChannel)}` : threadFallbackChannelNameRef.current ? (threadFallbackChannelIsDmRef.current ? '@' + threadFallbackChannelNameRef.current : '#' + threadFallbackChannelNameRef.current) : selectedChannelId ? '...' : ''}
                  </h2>
                  {selectedChannel?.topic && (
                    <span className="text-[11px] text-text-3 truncate ml-2">
                      {selectedChannel.topic}
                    </span>
                  )}
                </div>

                {/* Messages list */}
                <div className="flex-1 relative overflow-hidden">
                <div
                  ref={messageContainerRef}
                  className="absolute inset-0 overflow-y-auto scrollbar-hide"
                  onScroll={handleMessageScroll}
                >
                  {loadingMessages && messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center">
                        <div className="skeleton w-40 h-4 mx-auto mb-2" />
                        <div className="skeleton w-28 h-3 mx-auto" />
                      </div>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-[12px] text-text-3">No messages yet</p>
                    </div>
                  ) : (
                    <div className="py-2">
                      {msgHasMore && (
                        <div className="flex justify-center py-2">
                          <button
                            onClick={loadOlderMessages}
                            disabled={loadingOlder}
                            className="text-[11px] text-text-3 hover:text-text-2 transition-colors px-3 py-1.5 rounded-lg hover:bg-black/[0.04] disabled:opacity-50"
                          >
                            {loadingOlder ? 'Loading...' : 'Load older messages'}
                          </button>
                        </div>
                      )}
                      {messagesWithSeparators.map(item => {
                        if (item.type === 'separator') {
                          return <DateSeparator key={item.key} dateStr={item.date} />
                        }
                        return (
                          <MessageBubble
                            key={item.key}
                            message={item.message}
                            onThreadClick={handleOpenThread}
                            userMapRef={persistentUserMapRef}
                            userMapVersion={persistentUserMapVersion}
                            channelMap={channelMap}
                            currentThreadTs={viewingThreadTs}
                            selfId={selfId ?? selfRef.current?.id}
                            containerRef={messageContainerRef}
                          />
                        )
                      })}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </div>
                {newChannelMessages > 0 && (
                  <button
                    onClick={() => {
                      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
                      setNewChannelMessages(0)
                    }}
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 bg-blue-1 text-white text-[11px] font-semibold rounded-full shadow-lg cursor-pointer"
                  >
                    ↓ {newChannelMessages} new message{newChannelMessages === 1 ? '' : 's'}
                  </button>
                )}
                </div>

                {/* Reply input */}
                <div className="px-4 py-3 border-t border-black/[0.06]">
                  {mainSendError && (
                    <p className="text-[11px] text-red-1 mb-1 px-1">{mainSendError}</p>
                  )}
                  <div className="flex items-end gap-2 bg-surface-1 rounded-xl border border-transparent px-3 py-2.5 focus-within:border-purple-1/30 transition-colors">
                    <textarea
                      ref={mainTextareaRef}
                      value={replyText}
                      onChange={(e) => { setReplyText(e.target.value); setMainSendError(null); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                      onKeyDown={handleKeyDown}
                      placeholder={`Message ${selectedChannel ? channelDisplayName(selectedChannel) : ''}`}
                      disabled={sendingMain}
                      className="flex-1 text-[13px] text-text-1 bg-transparent resize-none outline-none placeholder:text-text-3/40 max-h-[120px] leading-[1.45]"
                      style={{ minHeight: 22 }}
                    />
                    <button
                      onClick={handleSend}
                      disabled={!replyText.trim() || sendingMain}
                      aria-label="Send message"
                      className={`flex-shrink-0 p-1.5 rounded-lg transition-colors ${
                        replyText.trim() && !sendingMain
                          ? 'bg-purple-1 text-white hover:opacity-90'
                          : 'text-text-3/30'
                      }`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-2xl bg-surface-1 flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-text-3/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </div>
                  <p className="text-[13px] font-medium text-text-2">Select a conversation</p>
                  <p className="text-[11px] text-text-3 mt-1">Choose a channel or DM</p>
                </div>
              </div>
            )}
          </div>

          {/* ── Thread Panel ── */}
          {viewingThreadTs && selectedChannelId && (
            <div className="flex flex-col border-l border-black/[0.06]" style={{ width: 360 }}>
              {/* Thread header */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-black/[0.06]">
                <h3 className="text-[12px] font-semibold text-text-1">
                  {selectedChannel ? `Thread in ${channelPrefix(selectedChannel)}${channelDisplayName(selectedChannel)}` : threadFallbackChannelNameRef.current ? `Thread in ${threadFallbackChannelIsDmRef.current ? '@' : '#'}${threadFallbackChannelNameRef.current}` : 'Thread'}
                </h3>
                <button
                  onClick={handleCloseThread}
                  aria-label="Close thread"
                  className="p-1 rounded hover:bg-black/[0.04] transition-colors text-text-3 hover:text-text-1"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Thread messages */}
              <div className="flex-1 relative overflow-hidden">
              <div ref={threadContainerRef} className="absolute inset-0 overflow-y-auto scrollbar-hide" onScroll={handleThreadScroll}>
                {threadError ? (
                  <div className="flex flex-col items-center justify-center h-32 gap-2">
                    <p className="text-[11px] text-red-1">{threadError}</p>
                    <button
                      onClick={() => viewingThreadTs && loadThread(selectedChannelId!, viewingThreadTs)}
                      className="text-[11px] text-purple-1 hover:underline cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                ) : threadMessages === null ? (
                  <div className="flex items-center justify-center h-32">
                    <div className="skeleton w-32 h-4" />
                  </div>
                ) : threadMessages.length === 0 ? (
                  <div className="flex items-center justify-center h-32">
                    <p className="text-[11px] text-text-3">All messages in this thread have been deleted</p>
                  </div>
                ) : (
                  <div className="py-2">
                    <MessageBubble message={threadMessages[0]} userMapRef={persistentUserMapRef} userMapVersion={persistentUserMapVersion} channelMap={channelMap} selfId={selfId ?? selfRef.current?.id} containerRef={threadContainerRef} />
                    {threadMessages.length > 1 && (() => {
                      const realReplyCount = threadMessages[0]?.replyCount ?? 0
                      const visibleCount = Math.max(realReplyCount, threadMessages.length - 1)
                      return visibleCount > 0 ? (
                        <div className="flex items-center gap-3 px-4 py-2 my-1">
                          <div className="flex-1 h-px bg-black/[0.06]" />
                          <span className="text-[10px] text-text-3">{`${visibleCount} ${visibleCount === 1 ? 'reply' : 'replies'}`}</span>
                          <div className="flex-1 h-px bg-black/[0.06]" />
                        </div>
                      ) : null
                    })()}
                    {threadMessages.length === 1 ? (
                      <div className="flex items-center justify-center h-16">
                        <p className="text-[11px] text-text-3">No replies yet</p>
                      </div>
                    ) : (
                      threadRepliesWithSeparators.map(item => {
                        if (item.type === 'separator') {
                          return <DateSeparator key={item.key} dateStr={item.date} />
                        }
                        return <MessageBubble key={item.key} message={item.message} userMapRef={persistentUserMapRef} userMapVersion={persistentUserMapVersion} channelMap={channelMap} selfId={selfId ?? selfRef.current?.id} containerRef={threadContainerRef} />
                      })
                    )}
                    {threadTruncated && (
                      <div className="flex items-center justify-center gap-2 px-4 py-2">
                        <p className="text-[10px] text-text-3">Showing first {threadMessages.filter(m => !m.isOptimistic).length - 1} {threadMessages.filter(m => !m.isOptimistic).length - 1 === 1 ? 'reply' : 'replies'} — thread was truncated</p>
                        <button
                          disabled={loadMoreAttempted}
                          onClick={() => {
                            if (viewingThreadTs) {
                              setLoadMoreAttempted(true)
                              loadThread(selectedChannelId!, viewingThreadTs)
                            }
                          }}
                          className={`text-[10px] shrink-0 ${loadMoreAttempted ? 'text-text-3 cursor-default' : 'text-purple-1 hover:underline cursor-pointer'}`}
                        >
                          {loadMoreAttempted ? 'Thread too long to fully load' : 'Load more'}
                        </button>
                      </div>
                    )}
                    <div ref={threadEndRef} />
                  </div>
                )}
              </div>
              {newThreadMessages > 0 && (
                <button
                  onClick={() => {
                    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' })
                    setNewThreadMessages(0)
                  }}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 bg-blue-1 text-white text-[11px] font-semibold rounded-full shadow-lg cursor-pointer"
                >
                  ↓ {newThreadMessages} new repl{newThreadMessages === 1 ? 'y' : 'ies'}
                </button>
              )}
              </div>

              {/* Thread reply input */}
              <div className="px-3 py-2.5 border-t border-black/[0.06]">
                {threadSendError && (
                  <p className="text-[11px] text-red-1 mb-1 px-1">{threadSendError}</p>
                )}
                <div className="flex items-end gap-2 bg-surface-1 rounded-xl border border-transparent px-3 py-2.5 focus-within:border-purple-1/30 transition-colors">
                  <textarea
                    ref={threadTextareaRef}
                    value={threadReplyText}
                    onChange={(e) => { threadResizeDoneByOnChange.current = true; setThreadReplyText(e.target.value); setThreadSendError(null); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                    onKeyDown={handleThreadKeyDown}
                    disabled={sendingThread}
                    placeholder="Reply..."
                    className="flex-1 text-[13px] text-text-1 bg-transparent resize-none outline-none placeholder:text-text-3/40 max-h-[80px] leading-[1.45]"
                    style={{ minHeight: 22 }}
                  />
                  <button
                    onClick={handleSendThreadReply}
                    disabled={!threadReplyText.trim() || sendingThread || !threadMessages || threadMessages.length === 0}
                    aria-label="Send thread reply"
                    className={`flex-shrink-0 p-1.5 rounded-lg transition-colors ${
                      threadReplyText.trim() && !sendingThread && threadMessages && threadMessages.length > 0
                        ? 'bg-purple-1 text-white hover:opacity-90'
                        : 'text-text-3/30'
                    }`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
