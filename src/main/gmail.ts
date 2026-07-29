import fs from 'fs'
import path from 'path'
import os from 'os'
import { googleTokenPath } from './google-token-path'
import { buildQuoteHtml } from '../shared/email-utils'

// ═══════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════

export interface GmailMessageSummary {
  id: string
  threadId: string
  snippet: string
  from: string
  to: string
  subject: string
  date: string
  internalDate?: string
  labelIds: string[]
  isUnread: boolean
  hasSentMessage: boolean
  hasDraftMessage: boolean
  hasInboxMessage: boolean
}

export interface GmailAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  contentId?: string
}

export interface GmailMessage extends GmailMessageSummary {
  body: string
  cc?: string
  bcc?: string
  replyTo?: string
  inReplyTo?: string
  attachments: GmailAttachment[]
  messageIdHeader: string
  references?: string
}

export interface GmailThread {
  id: string
  messages: GmailMessage[]
  snippet: string
}

export interface GmailLabel {
  id: string
  name: string
  type: string
  threadsUnread?: number
}

// ═══════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const FETCH_TIMEOUT = 30000

// ═══════════════════════════════════════════
//  TOKEN MANAGEMENT
// ═══════════════════════════════════════════

function getTokenPath(): string {
  return googleTokenPath()
}

/**
 * Get a valid Google access token with auto-refresh.
 * Reads from the resolved Google token path (same as Google Tasks).
 * Refreshes automatically when expired.
 */
export async function getGoogleToken(): Promise<string | null> {
  const tokenPath = getTokenPath()
  if (!fs.existsSync(tokenPath)) {
    console.log('[gmail] token.json not found at', tokenPath)
    return null
  }

  try {
    const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))

    // Check if expired and refresh
    if (data.expiry && new Date(data.expiry) < new Date()) {
      if (!data.refresh_token || !data.client_id || !data.client_secret) {
        console.log('[gmail] Token expired, cannot refresh (missing credentials)')
        return null
      }

      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: data.client_id,
            client_secret: data.client_secret,
            refresh_token: data.refresh_token,
            grant_type: 'refresh_token',
          }).toString(),
          signal: AbortSignal.timeout(15000),
        })
        if (!resp.ok) throw new Error(`Refresh failed: HTTP ${resp.status}`)
        const refreshed = await resp.json() as { access_token?: string; expiry_date?: number; expires_in?: number }

        // Update token file
        data.token = refreshed.access_token
        if (refreshed.expiry_date) {
          data.expiry = new Date(refreshed.expiry_date).toISOString()
        } else if (refreshed.expires_in) {
          data.expiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        }
        fs.writeFileSync(tokenPath, JSON.stringify(data, null, 2))
        console.log('[gmail] Token refreshed successfully')
      } catch (e) {
        console.error('[gmail] Token refresh error:', e)
        return null
      }
    }

    // Check scopes — warn if gmail.modify is missing but still try
    const scopes: string[] = data.scopes || []
    if (scopes.length > 0 && !scopes.includes(GMAIL_MODIFY_SCOPE)) {
      console.log(`[gmail] Warning: token scopes do not include ${GMAIL_MODIFY_SCOPE}. ` +
        `Available: ${scopes.join(', ')}. Will still attempt API calls.`)
    }

    // Invalidate profile caches when the account changes (different refresh_token = different account)
    const accountKey = data.refresh_token ?? data.token
    if (accountKey && accountKey !== lastSeenToken) {
      if (lastSeenToken !== null) {
        cachedAuthEmail = null
        cachedAuthProfile = null
        _inboxDetailCache = null
        console.log('[gmail] Account token changed — clearing auth caches')
      }
      lastSeenToken = accountKey
    }

    return data.token || null
  } catch (e) {
    console.error('[gmail] Auth error:', e)
    return null
  }
}

// ═══════════════════════════════════════════
//  INTERNAL HELPERS
// ═══════════════════════════════════════════

let cachedAuthEmail: string | null = null
let cachedAuthProfile: { displayName: string; email: string } | null = null
let lastSeenToken: string | null = null

async function getAuthenticatedEmail(): Promise<string | null> {
  if (cachedAuthEmail) return cachedAuthEmail
  try {
    const profile = await gmailFetch('/profile')
    cachedAuthEmail = profile.emailAddress ?? null
    return cachedAuthEmail
  } catch (e) {
    console.error('[gmail] Could not fetch profile email:', e)
    return null
  }
}

export async function gmailGetProfile(): Promise<{ displayName: string; email: string } | null> {
  if (cachedAuthProfile) return cachedAuthProfile
  try {
    const userInfo = await gmailFetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json')
    const email = userInfo.email || (await getAuthenticatedEmail()) || ''
    cachedAuthProfile = { displayName: userInfo.name || email, email }
    return cachedAuthProfile
  } catch {
    try {
      const email = await getAuthenticatedEmail()
      if (!email) return null
      cachedAuthProfile = { displayName: email, email }
      return cachedAuthProfile
    } catch (e) {
      console.error('[gmail] Could not fetch user profile:', e)
      return null
    }
  }
}

async function gmailFetch(
  endpoint: string,
  opts: RequestInit = {},
): Promise<any> {
  const token = await getGoogleToken()
  if (!token) throw new Error('No valid Google token available')

  const url = endpoint.startsWith('http') ? endpoint : `${GMAIL_BASE}${endpoint}`
  const resp = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(formatGmailError(resp.status, resp.statusText, body))
  }

  // Some endpoints (modify, trash) may return empty for 204
  const text = await resp.text()
  return text ? JSON.parse(text) : {}
}

/**
 * Turn a Gmail API error response into a short, user-friendly message.
 * The raw body is a verbose JSON blob; surface `error.message` plus an
 * actionable hint when the token is missing a scope (the common case that
 * breaks archive/trash/star).
 */
function formatGmailError(status: number, statusText: string, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const err = parsed?.error
    const message: string = err?.message || `HTTP ${status} ${statusText}`
    const scopeInsufficient =
      status === 403 &&
      (err?.details || []).some((d: any) => d?.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')
    if (scopeInsufficient) {
      return `Gmail needs re-authorization with the "modify" scope. Re-run the Google auth flow to refresh the token.`
    }
    return `Gmail: ${message}`
  } catch {
    return `Gmail API error: HTTP ${status} ${statusText}`
  }
}

/** Extract a header value from the Gmail payload headers array */
function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase())
  return h?.value || ''
}

/**
 * Recursively walk message payload parts to find the body.
 * Prefers text/html, falls back to text/plain.
 */
function extractBody(payload: any): string {
  // Single-part message — body is directly on the payload
  if (payload.body?.data && payload.body.size > 0) {
    const mimeType = (payload.mimeType || '').toLowerCase()
    if (mimeType === 'text/html') {
      return decodeBase64Url(payload.body.data)
    }
    if (mimeType === 'text/plain') {
      return plainTextToHtml(decodeBase64Url(payload.body.data))
    }
  }

  // Multipart — walk parts recursively
  const parts: any[] = payload.parts || []

  // First pass: look for text/html
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return decodeBase64Url(part.body.data)
    }
    if (part.parts) {
      const nested = extractBodyHtmlOnly(part)
      if (nested) return nested
    }
  }

  // Second pass: fall back to text/plain
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return plainTextToHtml(decodeBase64Url(part.body.data))
    }
    if (part.parts) {
      const nested = extractBodyPlainOnly(part)
      if (nested) return nested
    }
  }

  // Last resort: decode whatever is on the payload body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }

  return ''
}

/** Recursive helper that only looks for text/html, never returns plain text */
function extractBodyHtmlOnly(payload: any): string {
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  for (const part of payload.parts || []) {
    const result = extractBodyHtmlOnly(part)
    if (result) return result
  }
  return ''
}

/** Recursive helper that only looks for text/plain, returns HTML-converted content */
function extractBodyPlainOnly(payload: any): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return plainTextToHtml(decodeBase64Url(payload.body.data))
  }
  for (const part of payload.parts || []) {
    const result = extractBodyPlainOnly(part)
    if (result) return result
  }
  return ''
}

/** Extract attachment metadata from message payload */
function extractAttachments(payload: any): GmailAttachment[] {
  const attachments: GmailAttachment[] = []

  function walk(part: any) {
    if (part.filename && part.body?.attachmentId) {
      const partHeaders: Array<{ name: string; value: string }> = part.headers || []
      const rawContentId = partHeaders.find((h: { name: string }) => h.name.toLowerCase() === 'content-id')?.value
      const contentId = rawContentId ? rawContentId.replace(/^<|>$/g, '') : undefined
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: typeof part.body.size === 'number' ? part.body.size : 0,
        contentId,
      })
    }
    for (const child of part.parts || []) {
      walk(child)
    }
  }

  walk(payload)
  return attachments
}

/** Decode base64url-encoded string */
function decodeBase64Url(data: string): string {
  // Replace base64url chars with standard base64
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

/** Convert plain text to safe HTML (escape entities, convert newlines to <br>, auto-link URLs) */
function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/(https?:\/\/[^\s<>"']+)/g, (_, url) => {
      const cleanUrl = url.replace(/[).,!?]+$/, '')
      return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>`
    })
}

/** Encode string to base64url */
function encodeBase64Url(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Parse a raw Gmail API message response into our GmailMessage type */
function parseMessage(raw: any): GmailMessage {
  const payload = raw.payload || {}
  const headers: Array<{ name: string; value: string }> = payload.headers || []
  const labelIds: string[] = raw.labelIds || []

  return {
    id: raw.id || '',
    threadId: raw.threadId || '',
    snippet: raw.snippet || '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    date: parseDate(getHeader(headers, 'Date')),
    labelIds,
    isUnread: labelIds.includes('UNREAD'),
    hasSentMessage: labelIds.includes('SENT'),
    hasDraftMessage: labelIds.includes('DRAFT'),
    hasInboxMessage: labelIds.includes('INBOX'),
    body: extractBody(payload),
    cc: getHeader(headers, 'Cc') || undefined,
    bcc: getHeader(headers, 'Bcc') || undefined,
    replyTo: getHeader(headers, 'Reply-To') || undefined,
    inReplyTo: getHeader(headers, 'In-Reply-To') || undefined,
    attachments: extractAttachments(payload),
    messageIdHeader: getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id'),
    references: getHeader(headers, 'References') || undefined,
    internalDate: raw.internalDate ? String(raw.internalDate) : undefined,
  }
}

/** Parse a raw Gmail API message into a summary (without body/attachments) */
function parseMessageSummary(raw: any): GmailMessageSummary {
  const payload = raw.payload || {}
  const headers: Array<{ name: string; value: string }> = payload.headers || []
  const labelIds: string[] = raw.labelIds || []

  return {
    id: raw.id || '',
    threadId: raw.threadId || '',
    snippet: raw.snippet || '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    date: parseDate(getHeader(headers, 'Date')),
    internalDate: raw.internalDate ? String(raw.internalDate) : undefined,
    labelIds,
    isUnread: labelIds.includes('UNREAD'),
    hasSentMessage: labelIds.includes('SENT'),
    hasDraftMessage: labelIds.includes('DRAFT'),
    hasInboxMessage: labelIds.includes('INBOX'),
  }
}

/** Parse an email date string to ISO format */
function parseDate(dateStr: string): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    return isNaN(d.getTime()) ? '' : d.toISOString()
  } catch {
    return ''
  }
}

function buildRawMessage(opts: {
  to: string
  subject: string
  body: string
  cc?: string
  bcc?: string
  from?: string
  inReplyTo?: string
  references?: string
}): string {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const lines: string[] = []

  // Headers
  if (opts.from) lines.push(`From: ${opts.from}`)
  lines.push(`To: ${opts.to}`)
  if (opts.cc) lines.push(`Cc: ${opts.cc}`)
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`)
  const encodedSubject = /[^\x00-\x7F]/.test(opts.subject)
    ? `=?UTF-8?B?${Buffer.from(opts.subject, 'utf-8').toString('base64')}?=`
    : opts.subject
  lines.push(`Subject: ${encodedSubject}`)
  const isSyntheticId = opts.inReplyTo != null && /^<thread-[^@]+@mail\.gmail\.com>$/.test(opts.inReplyTo)
  if (opts.inReplyTo && !isSyntheticId) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
  const filteredRefs = opts.references
    ? opts.references.split(' ').filter(id => !/^<thread-[^@]+@mail\.gmail\.com>$/.test(id))
    : []
  if (filteredRefs.length) lines.push(`References: ${filteredRefs.join(' ')}`)
  lines.push(`Date: ${new Date().toUTCString()}`)
  lines.push(`MIME-Version: 1.0`)
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
  lines.push('') // blank line separates headers from body

  const isHtmlBody = /^\s*<html[\s>]/i.test(opts.body)

  if (isHtmlBody) {
    // Body is pre-built HTML — strip tags for plain text part, use as-is for HTML part
    const stripped = opts.body
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|tr|td)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .replace(/\r?\n/g, '\r\n')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64')
    lines.push('')
    lines.push(Buffer.from(stripped, 'utf-8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/html; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64')
    lines.push('')
    lines.push(Buffer.from(opts.body, 'utf-8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '')
  } else {
    // Plain text body — normalize newlines and ensure CRLF for RFC 2822 compliance
    const plainText = opts.body
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .replace(/\r?\n/g, '\r\n')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64')
    lines.push('')
    lines.push(Buffer.from(plainText, 'utf-8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '')
    // HTML part — escape HTML special chars, convert newlines, wrap quoted attribution lines in <blockquote>
    const bodyLines = opts.body.split(/\r?\n/)
    const htmlParts: string[] = []
    let li = 0
    while (li < bodyLines.length) {
      const line = bodyLines[li]
      if (line.startsWith('>')) {
        const contentLines: string[] = []
        while (li < bodyLines.length && bodyLines[li].startsWith('>')) {
          contentLines.push(bodyLines[li].startsWith('> ') ? bodyLines[li].slice(2) : bodyLines[li].slice(1))
          li++
        }
        htmlParts.push(`<blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${buildQuoteHtml(contentLines)}</blockquote>`)
      } else {
        htmlParts.push(line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        li++
      }
    }
    const rawHtml = htmlParts.reduce((acc, part, i) => {
      if (i === 0) return part
      const prevIsBlock = htmlParts[i - 1].startsWith('<blockquote')
      const currIsBlock = part.startsWith('<blockquote')
      return acc + (prevIsBlock && currIsBlock ? '' : '<br>') + part
    }, '')
    const htmlBody = `<html><body>${rawHtml}</body></html>`
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/html; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64')
    lines.push('')
    lines.push(Buffer.from(htmlBody, 'utf-8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '')
  }

  lines.push(`--${boundary}--`)
  lines.push('')

  return lines.join('\r\n')
}

// ═══════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════

/**
 * List messages from inbox (paginated).
 */
export async function gmailListMessages(opts?: {
  maxResults?: number
  pageToken?: string
  query?: string
  labelIds?: string[]
  includeSpamTrash?: boolean
}): Promise<{ messages: GmailMessageSummary[]; nextPageToken?: string; failedCount?: number; failedThreadIds?: string[] }> {
  const params = new URLSearchParams()
  params.set('maxResults', String(opts?.maxResults || 50))
  if (opts?.pageToken) params.set('pageToken', opts.pageToken)
  if (opts?.query) params.set('q', opts.query)
  if (opts?.includeSpamTrash) params.set('includeSpamTrash', 'true')
  if (!opts?.query && !opts?.labelIds?.length) {
    params.append('labelIds', 'INBOX')
  } else if (opts?.labelIds?.length) {
    for (const label of opts.labelIds) {
      params.append('labelIds', label)
    }
  }

  const listData = await gmailFetch(`/threads?${params.toString()}`)
  const threadStubs: Array<{ id: string }> = listData.threads || []

  if (threadStubs.length === 0) {
    return { messages: [], nextPageToken: listData.nextPageToken }
  }

  if (!cachedAuthEmail) await getAuthenticatedEmail()

  // Fetch metadata for each thread — use the most recent message for the list row
  const messages: GmailMessageSummary[] = []
  let failedCount = 0
  const failedThreadIds: string[] = []
  // Batch fetch in parallel, up to 10 at a time
  const batchSize = 10
  for (let i = 0; i < threadStubs.length; i += batchSize) {
    const batch = threadStubs.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(stub =>
        gmailFetch(`/threads/${stub.id}?format=metadata`)
          .catch(e => {
            console.error(`[gmail] Error fetching thread ${stub.id}:`, e)
            failedCount++
            failedThreadIds.push(stub.id)
            return null
          })
      )
    )
    for (const raw of results) {
      if (!raw) continue
      const rawMsgs: any[] = raw.messages || []
      if (rawMsgs.length === 0) continue
      // Most recent message provides display metadata; thread id is the row key
      const lastMsg = rawMsgs[rawMsgs.length - 1]
      const anyStarred = rawMsgs.some((m: any) => (m.labelIds || []).includes('STARRED'))
      const baseSummary = parseMessageSummary(lastMsg)
      const firstSummary = parseMessageSummary(rawMsgs[0])
      // When the user's own reply is the most recent message, find the first correspondent
      const displayFrom = (() => {
        if (!cachedAuthEmail) {
          // Walk all messages to find the first non-SENT sender (avoids showing own address on sent threads)
          for (const m of rawMsgs) {
            if (!(m.labelIds || []).includes('SENT')) {
              const fromVal = ((m.payload?.headers as Array<{ name: string; value: string }>) || [])
                .find(h => h.name.toLowerCase() === 'from')?.value
              if (fromVal) return fromVal
            }
          }
          return baseSummary.from
        }
        if (!baseSummary.from?.toLowerCase().includes(cachedAuthEmail.toLowerCase())) {
          return baseSummary.from
        }
        for (const m of rawMsgs) {
          const fromVal = ((m.payload?.headers as Array<{ name: string; value: string }>) || [])
            .find(h => h.name.toLowerCase() === 'from')?.value
          if (fromVal && !fromVal.toLowerCase().includes(cachedAuthEmail.toLowerCase())) {
            return fromVal
          }
        }
        return baseSummary.to
      })()
      // For SENT folder display: always show the original recipient (first SENT message's To:)
      // rather than whoever the last message was addressed to (which may be the user themselves)
      const displayTo = (() => {
        for (const m of rawMsgs) {
          if ((m.labelIds || []).includes('SENT')) {
            const toVal = ((m.payload?.headers as Array<{ name: string; value: string }>) || [])
              .find(h => h.name.toLowerCase() === 'to')?.value
            if (toVal) return toVal
          }
        }
        return baseSummary.to
      })()
      const hasInboxMessage = rawMsgs.some((m: any) => (m.labelIds || []).includes('INBOX'))
      let labelIds = anyStarred ? Array.from(new Set([...(lastMsg.labelIds || []), 'STARRED'])) : lastMsg.labelIds || []
      if (hasInboxMessage && !labelIds.includes('INBOX')) labelIds = [...labelIds, 'INBOX']
      const summary: GmailMessageSummary = {
        ...baseSummary,
        from: displayFrom,
        to: displayTo,
        subject: firstSummary.subject,
        labelIds,
        id: lastMsg.id || raw.id || '',
        snippet: raw.snippet || lastMsg.snippet || '',
        isUnread: rawMsgs.some((m: any) => (m.labelIds || []).includes('UNREAD')),
        hasSentMessage: rawMsgs.some((m: any) => (m.labelIds || []).includes('SENT')),
        hasDraftMessage: rawMsgs.some((m: any) => (m.labelIds || []).includes('DRAFT')),
        hasInboxMessage,
      }
      messages.push(summary)
    }
  }

  return { messages, nextPageToken: listData.nextPageToken, failedCount, failedThreadIds }
}

/**
 * Get full message detail including body.
 */
export async function gmailGetMessage(messageId: string): Promise<GmailMessage> {
  const raw = await gmailFetch(`/messages/${messageId}?format=full`)
  return parseMessage(raw)
}

/**
 * Get a full thread (all messages in conversation).
 */
export async function gmailGetThread(threadId: string): Promise<GmailThread> {
  const raw = await gmailFetch(`/threads/${threadId}?format=full`)
  const getTs = (m: GmailMessage) =>
    parseInt(m.internalDate || '0') || new Date(m.date || 0).getTime() || 0
  const messages: GmailMessage[] = (raw.messages || [])
    .map(parseMessage)
    .sort((a: GmailMessage, b: GmailMessage) => getTs(a) - getTs(b))

  return {
    id: raw.id || threadId,
    messages,
    snippet: raw.snippet || '',
  }
}

/**
 * Send a new email.
 */
export async function gmailSend(opts: {
  to: string
  subject: string
  body: string
  cc?: string
  bcc?: string
  threadId?: string
  inReplyTo?: string
  references?: string
}): Promise<{ id: string; threadId: string }> {
  const rawMessage = buildRawMessage({
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    cc: opts.cc,
    bcc: opts.bcc,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  })

  const encoded = encodeBase64Url(rawMessage)

  const payload: any = { raw: encoded }
  if (opts.threadId) payload.threadId = opts.threadId

  const result = await gmailFetch('/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  console.log(`[gmail] Sent message to ${opts.to}, id=${result.id}`)
  return { id: result.id, threadId: result.threadId }
}

/**
 * Reply to a message (convenience wrapper).
 * Uses caller-supplied threading headers when available to skip a redundant fetch.
 */
export async function gmailReply(
  messageId: string,
  body: string,
  headers?: { inReplyTo?: string; references?: string; replyTo?: string; from?: string; to?: string; cc?: string; subject?: string; threadId?: string },
): Promise<{ id: string; threadId: string }> {
  // Skip the fetch when the caller has recipient + thread info.
  // inReplyTo may be absent (synthetic thread-ID); the else branch handles that gracefully.
  const original = (headers?.from && (headers?.replyTo || headers?.to) && headers?.threadId)
    ? null
    : await gmailGetMessage(messageId)

  // Build reply subject
  let subject = headers?.subject ?? original!.subject
  if (subject && !subject.toLowerCase().startsWith('re:')) {
    subject = `Re: ${subject}`
  }

  let inReplyTo: string
  let references: string
  let threadId: string
  let replyTo: string

  if (original) {
    // Derived from fetched message
    inReplyTo = original.messageIdHeader
    if (!inReplyTo) {
      // No Message-ID on the specific message — walk the thread to find one
      try {
        const threadData = await gmailFetch(`/threads/${original.threadId}?format=full`)
        const threadMsgs: any[] = threadData.messages || []
        for (let i = threadMsgs.length - 1; i >= 0; i--) {
          const hdrs: Array<{ name: string; value: string }> = threadMsgs[i].payload?.headers || []
          const mid = hdrs.find(h => h.name.toLowerCase() === 'message-id')?.value
          if (mid) { inReplyTo = mid; break }
        }
      } catch {
        // leave inReplyTo empty — buildRawMessage will omit the header
      }
      if (!inReplyTo) console.warn(`[gmail] Reply to ${messageId}: no Message-ID header in thread, threading headers will be omitted (threadId still binds the reply)`)
    }
    const refTokens = (original.references ?? '').trim().split(/\s+/).filter(Boolean)
    references = inReplyTo
      ? ((refTokens.length > 0 && refTokens[refTokens.length - 1] === inReplyTo)
          ? original.references!
          : (original.references ? `${original.references} ${inReplyTo}` : inReplyTo))
      : (original.references ?? '')
    threadId = original.threadId
    const authEmail = await getAuthenticatedEmail()
    const fromLower = original.from.toLowerCase()
    const authEmailLower = authEmail ? authEmail.toLowerCase() : ''
    replyTo = headers?.replyTo
      ? headers.replyTo
      : (authEmail && (fromLower.includes('<' + authEmailLower + '>') || fromLower.replace(/.*<|>/g, '').trim() === authEmailLower))
        ? original.to
        : (original.replyTo || original.from)
  } else {
    // Use caller-supplied headers (skip fetch)
    inReplyTo = headers!.inReplyTo!
    if (headers!.inReplyTo !== undefined && headers!.inReplyTo !== '') {
      const refTokens = (headers!.references ?? '').trim().split(/\s+/).filter(Boolean)
      references = (refTokens.length > 0 && refTokens[refTokens.length - 1] === headers!.inReplyTo)
        ? (headers!.references ?? headers!.inReplyTo).trim()
        : (headers!.references ? `${headers!.references} ${headers!.inReplyTo}` : headers!.inReplyTo).trim()
    } else {
      references = (headers!.references ?? '').trim()
    }
    threadId = headers!.threadId!
    replyTo = headers!.to || headers!.replyTo || headers!.from!
  }

  return gmailSend({ to: replyTo, subject, body, threadId, inReplyTo: inReplyTo || undefined, references: references || undefined, cc: headers?.cc })
}

/**
 * Mark a message as read (remove UNREAD label).
 */
export async function gmailMarkRead(messageId: string): Promise<void> {
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  })
  console.log(`[gmail] Marked message ${messageId} as read`)
}

/**
 * Mark all messages in a thread as read (remove UNREAD label atomically).
 */
export async function gmailMarkThreadRead(threadId: string): Promise<void> {
  _inboxDetailCache = null
  await gmailFetch(`/threads/${threadId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  })
  console.log(`[gmail] Marked thread ${threadId} as read`)
}

/**
 * Mark a message as unread (add UNREAD label).
 */
export async function gmailMarkUnread(messageId: string): Promise<void> {
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: ['UNREAD'] }),
  })
  console.log(`[gmail] Marked message ${messageId} as unread`)
}

/**
 * Archive a message (remove INBOX label).
 */
export async function gmailArchive(messageId: string): Promise<void> {
  await gmailFetch(`/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  })
  console.log(`[gmail] Archived message ${messageId}`)
}

/**
 * Trash a message.
 */
export async function gmailTrash(messageId: string): Promise<void> {
  _inboxDetailCache = null
  await gmailFetch(`/messages/${messageId}/trash`, {
    method: 'POST',
  })
  console.log(`[gmail] Trashed message ${messageId}`)
}

/**
 * Archive a whole thread (remove INBOX label from all messages atomically).
 */
export async function gmailArchiveThread(threadId: string): Promise<void> {
  _inboxDetailCache = null
  await gmailFetch(`/threads/${threadId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  })
  console.log(`[gmail] Archived thread ${threadId}`)
}

/**
 * Trash a whole thread atomically.
 */
export async function gmailTrashThread(threadId: string): Promise<void> {
  _inboxDetailCache = null
  await gmailFetch(`/threads/${threadId}/trash`, {
    method: 'POST',
  })
  console.log(`[gmail] Trashed thread ${threadId}`)
}

/**
 * Restore a thread from Trash (Gmail untrash).
 */
export async function gmailUntrashThread(threadId: string): Promise<void> {
  _inboxDetailCache = null
  await gmailFetch(`/threads/${threadId}/untrash`, {
    method: 'POST',
  })
  console.log(`[gmail] Untrashed thread ${threadId}`)
}

/**
 * Move an archived thread back to Inbox.
 */
export async function gmailMoveThreadToInbox(threadId: string): Promise<void> {
  _inboxDetailCache = null
  await gmailFetch(`/threads/${threadId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: ['INBOX'] }),
  })
  console.log(`[gmail] Moved thread ${threadId} to inbox`)
}

/**
 * Star / unstar a thread (toggle STARRED label).
 */
export async function gmailStarThread(threadId: string, starred: boolean): Promise<void> {
  await gmailFetch(`/threads/${threadId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }),
  })
  console.log(`[gmail] ${starred ? 'Starred' : 'Unstarred'} thread ${threadId}`)
}

/**
 * Fetch raw attachment bytes from Gmail.
 * Returns a Buffer of the decoded attachment data.
 */
export async function gmailGetAttachmentData(messageId: string, attachmentId: string): Promise<Buffer> {
  const raw = await gmailFetch(`/messages/${messageId}/attachments/${attachmentId}`)
  const base64 = (raw.data || '').replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64')
}

let _inboxDetailCache: { data: any; ts: number } | null = null
const _INBOX_CACHE_TTL_MS = 15_000

/**
 * Get all Gmail labels.
 */
export async function gmailGetLabels(): Promise<GmailLabel[]> {
  const data = await gmailFetch('/labels')
  const labels: GmailLabel[] = (data.labels || []).map((l: any) => ({
    id: l.id || '',
    name: l.name || '',
    type: l.type || '',
    threadsUnread: typeof l.threadsUnread === 'number' ? l.threadsUnread : undefined,
  }))
  try {
    const now = Date.now()
    let inboxDetail: any
    if (_inboxDetailCache && (now - _inboxDetailCache.ts) < _INBOX_CACHE_TTL_MS) {
      inboxDetail = _inboxDetailCache.data
    } else {
      inboxDetail = await gmailFetch('/labels/INBOX')
      _inboxDetailCache = { data: inboxDetail, ts: now }
    }
    const inbox = labels.find(l => l.id === 'INBOX')
    if (inbox && typeof inboxDetail.threadsUnread === 'number') {
      inbox.threadsUnread = inboxDetail.threadsUnread
    }
  } catch (err) {
    console.error('[gmail] Failed to enrich INBOX unread count:', err)
  }
  return labels
}
