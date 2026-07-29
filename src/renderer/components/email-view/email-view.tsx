import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'

let _optimisticSeq = 0
let _freshComposeSeq = 0

// ── Types ────────────────────────────────────────────────────────────────────

interface GmailMessageSummary {
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
  hasSentMessage?: boolean
  hasDraftMessage?: boolean
  hasInboxMessage?: boolean
}

interface GmailMessage extends GmailMessageSummary {
  body: string
  cc?: string
  bcc?: string
  replyTo?: string
  inReplyTo?: string
  attachments: { id: string; filename: string; mimeType: string; size: number; contentId?: string }[]
  messageIdHeader: string
  references?: string
}

interface GmailThread {
  id: string
  messages: GmailMessage[]
  snippet: string
}

// Gmail IPC methods (gmailListMessages, gmailGetThread, gmailSend, gmailReply,
// gmailArchive, gmailTrash) are declared on window.electronAPI
// in App.tsx. The types above provide local type safety for returned data.

// ── Helpers ──────────────────────────────────────────────────────────────────

import { parseSenderName } from './utils/parse-sender-name'
import { formatRelativeDate } from './utils/format-relative-date'
import { formatFullDate } from './utils/format-full-date'
import { splitAddressList } from './utils/split-address-list'
import { sanitizeHtmlBase, sanitizeHtmlPost } from './utils/sanitize-html'
import { formatFileSize } from './utils/format-file-size'
import { avatarBg } from './utils/avatar-bg'

const decodeSnippet = (s: string) => {
  if (typeof document === 'undefined') return s
  return new DOMParser().parseFromString(s, 'text/html').body.textContent || s
}
import { FolderSidebar, type FolderKey, type GmailLabelLite } from './folder-sidebar'

// ── Folder → Gmail list opts ────────────────────────────────────────────────

function folderToListOpts(folder: FolderKey): { query?: string; labelIds?: string[]; includeSpamTrash?: boolean } {
  if (folder === 'INBOX') return { labelIds: ['INBOX'] }
  if (folder === 'STARRED') return { query: 'in:starred -in:trash -in:spam' }
  if (folder === 'SENT') return { labelIds: ['SENT'] }
  if (folder === 'DRAFT') return { labelIds: ['DRAFT'] }
  // "Archive" = everything not in inbox/trash/spam/sent (Gmail has no explicit archive label)
  if (folder === 'ARCHIVE') return { query: '-in:inbox -in:trash -in:spam -is:draft' }
  if (folder === 'TRASH') return { labelIds: ['TRASH'], includeSpamTrash: true }
  if (folder.startsWith('LABEL:')) return { labelIds: [folder.slice(6)] }
  return { labelIds: ['INBOX'] }
}

// ── Icons ────────────────────────────────────────────────────────────────────

const SearchIcon = React.memo(() => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
))

const ComposeIcon = React.memo(() => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
))

const RefreshIcon = React.memo(({ spinning }: { spinning?: boolean }) => (
  <svg className={`w-3.5 h-3.5 ${spinning ? 'animate-spin-smooth' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
))

const ArchiveIcon = React.memo(() => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
  </svg>
))

const TrashIcon = React.memo(() => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
))

const SendIcon = React.memo(() => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
  </svg>
))

const CloseIcon = React.memo(() => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
))

const ChevronIcon = React.memo(({ direction }: { direction: 'up' | 'down' }) => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={direction === 'up' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} />
  </svg>
))

const AttachmentIcon = React.memo(() => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
  </svg>
))

const SpinnerIcon = React.memo(() => (
  <svg className="w-4 h-4 text-text-3/40 animate-spin-smooth" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
))

// ── Message List Item ────────────────────────────────────────────────────────

interface MessageRowProps {
  message: GmailMessageSummary
  isSelected: boolean
  isFocused: boolean
  index: number
  onSelect: (threadId: string, index: number) => void
  onStarToggle: (threadId: string, starred: boolean) => void
  relativeDate: string
  isSentOrDraft?: boolean
}

const StarButton = React.memo(function StarButton({ starred, onClick, size = 'sm' }: { starred: boolean; onClick: (e: React.MouseEvent) => void; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'
  return (
    <button
      onClick={onClick}
      aria-label={starred ? 'Unstar' : 'Star'}
      title={starred ? 'Unstar' : 'Star'}
      className={`p-1 rounded-md transition-colors cursor-pointer ${starred ? 'text-amber-400 hover:text-amber-500' : 'text-text-3/40 hover:text-amber-400'}`}
    >
      <svg className={dim} fill={starred ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.362-1.118L2.098 10.1c-.784-.57-.381-1.81.587-1.81h4.914a1 1 0 00.951-.69l1.519-4.673z" />
      </svg>
    </button>
  )
})

const MessageRow = React.memo(function MessageRow({ message, isSelected, isFocused, index, onSelect, onStarToggle, relativeDate, isSentOrDraft }: MessageRowProps) {
  const isStarred = (message.labelIds || []).includes('STARRED')
  const senderName = useMemo(() => {
    return (isSentOrDraft ? splitAddressList(message.to).map(a => parseSenderName(a)).filter(Boolean).join(', ') : parseSenderName(message.from)) || (isSentOrDraft ? '(no recipient)' : '?')
  }, [message.from, message.to, isSentOrDraft])
  const initial = senderName.charAt(0).toUpperCase()
  const bgColor = useMemo(() => avatarBg(senderName), [senderName])
  const decodedSnippet = useMemo(() => message.snippet ? decodeSnippet(message.snippet) : null, [message.snippet])

  return (
    <button
      onClick={() => onSelect(message.threadId, index)}
      className={`w-full text-left px-4 py-[13px] transition-all duration-150 cursor-pointer outline-none relative group ${
        isSelected
          ? 'bg-purple-1/[0.08]'
          : isFocused
            ? 'bg-black/[0.03]'
            : 'hover:bg-black/[0.025]'
      }`}
      role="option"
      aria-selected={isSelected}
    >
      {/* Left accent bar on selection — Mail.app-style */}
      {isSelected && (
        <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-purple-1" />
      )}
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <div className="relative shrink-0">
          <div
            className="w-[38px] h-[38px] rounded-full flex items-center justify-center text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
            style={{ backgroundColor: bgColor }}
          >
            {initial}
          </div>
          {message.isUnread && (
            <div className="absolute top-0 right-0 w-[10px] h-[10px] rounded-full bg-blue-1 border-[2px] border-surface-0 shadow-sm" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* Sender + time */}
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[13.5px] truncate tracking-tight ${
              message.isUnread ? 'font-semibold text-text-1' : 'font-medium text-text-2'
            }`}>
              {isSentOrDraft ? `To: ${senderName}` : senderName}
            </span>
            <span className={`text-[10.5px] whitespace-nowrap shrink-0 tabular-nums ${
              message.isUnread ? 'text-purple-1 font-semibold' : 'text-text-3'
            }`}>
              {relativeDate}
            </span>
          </div>

          {/* Subject — Snippet */}
          <div className="flex items-baseline gap-1.5 mt-[3px] min-w-0">
            <span className={`text-[12px] shrink-0 max-w-[55%] truncate tracking-tight ${
              message.isUnread ? 'font-medium text-text-1' : 'text-text-2'
            }`}>
              {message.subject || '(no subject)'}
            </span>
            {decodedSnippet && (
              <span className="text-[11px] text-text-3/80 truncate">
                {decodedSnippet}
              </span>
            )}
          </div>
        </div>

        {/* Star */}
        <div className="shrink-0 self-start" onClick={e => e.stopPropagation()}>
          <StarButton
            starred={isStarred}
            onClick={(e) => {
              e.stopPropagation()
              onStarToggle(message.threadId, !isStarred)
            }}
          />
        </div>
      </div>
    </button>
  )
})

function decodeHtmlEntities(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent || ''
}

// ── Thread Message ───────────────────────────────────────────────────────────

interface ThreadMessageProps {
  message: GmailMessage
  isLast: boolean
  defaultExpanded: boolean
  collapsedIds: React.MutableRefObject<Set<string>>
}

const CID_CACHE_MAX = 100
const _cidCache = new Map<string, string>()
function _cidCacheSet(key: string, value: string) {
  _cidCache.set(key, value)
  if (_cidCache.size > CID_CACHE_MAX) _cidCache.delete(_cidCache.keys().next().value!)
}

const ThreadMessage = React.memo(function ThreadMessage({ message, isLast, defaultExpanded, collapsedIds }: ThreadMessageProps) {
  const [expanded, setExpanded] = useState(() => defaultExpanded && !collapsedIds.current.has(message.id))

  const [downloadErrors, setDownloadErrors] = useState<Map<string, string>>(new Map())
  const [showImages, setShowImages] = useState(false)
  const [cidResolvedBody, setCidResolvedBody] = useState<string | null>(null)
  const [resolvedCids, setResolvedCids] = useState<Set<string>>(new Set())
  const [pendingCids, setPendingCids] = useState(false)
  const senderName = useMemo(() => parseSenderName(message.from) || '?', [message.from])
  const fullDate = useMemo(() => message.internalDate && Number(message.internalDate) > 0 ? formatFullDate(new Date(Number(message.internalDate)).toISOString()) : message.date ? formatFullDate(message.date) : 'Unknown date', [message.internalDate, message.date])
  const baseSanitized = useMemo(() => sanitizeHtmlBase(cidResolvedBody ?? message.body ?? ''), [cidResolvedBody, message.body])
  const sanitizedBody = useMemo(() => sanitizeHtmlPost(baseSanitized, showImages), [baseSanitized, showImages])
  const hasBlockedImages = useMemo(() => {
    return /(?:src|srcset)\s*=\s*["']?(?:https?:)?\/\/|url\s*\(\s*["']?(?:https?:)?\/\//i.test(baseSanitized)
  }, [baseSanitized])

  const decodedSnippet = useMemo(() => message.snippet ? decodeSnippet(message.snippet) : null, [message.snippet])
  const attachmentIdKey = useMemo(() => message.attachments.map(a => a.id).join(','), [message.attachments])

  useEffect(() => {
    if (!expanded || cidResolvedBody) return
    const body = message.body || ''
    if (!body.includes('cid:') && !message.attachments.some(a => a.contentId)) { setCidResolvedBody(null); setResolvedCids(new Set()); setPendingCids(false); return }
    const cidRefs = new Set<string>()
    const cidRegex = /src\s*=\s*["']cid:([^"'\s>]+)["']/gi
    let m: RegExpExecArray | null
    while ((m = cidRegex.exec(body)) !== null) cidRefs.add(m[1])
    const cssCidRegex = /url\s*\(\s*["']?cid:([^"')\s]+)["']?\s*\)/gi
    while ((m = cssCidRegex.exec(body)) !== null) cidRefs.add(m[1])
    if (cidRefs.size === 0) { setCidResolvedBody(null); setResolvedCids(new Set()); setPendingCids(false); return }
    let cancelled = false
    setPendingCids(true)
    ;(async () => {
      let processed = body
      const resolved = new Set<string>()
      const results = await Promise.all([...cidRefs].map(async cid => {
        const attachment = message.attachments.find(a => a.contentId === cid)
        if (!attachment) return null
        const cacheKey = `${message.id}:${attachment.id}`
        const cached = _cidCache.get(cacheKey)
        if (cached) return { cid, mimeType: attachment.mimeType, data: cached }
        try {
          const result = await window.electronAPI.gmailGetInlineImage(message.id, attachment.id, attachment.mimeType)
          if (cancelled) return null
          if (result.ok && result.data) {
            _cidCacheSet(cacheKey, result.data)
            return { cid, mimeType: attachment.mimeType, data: result.data }
          }
        } catch { /* skip this cid ref */ }
        return null
      }))
      if (cancelled) return
      for (const r of results) {
        if (!r) continue
        const dataUri = `data:${r.mimeType};base64,${r.data}`
        const escaped = r.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        processed = processed.replace(new RegExp(`src\\s*=\\s*["']cid:${escaped}["']`, 'g'), `src="${dataUri}"`)
        processed = processed.replace(new RegExp(`url\\s*\\(\\s*["']?cid:${escaped}["']?\\s*\\)`, 'g'), `url("${dataUri}")`)
        resolved.add(r.cid)
      }
      processed = processed.replace(/<img[^>]*src\s*=\s*["']cid:[^"'\s>]+["'][^>]*\/?>/gi, '')
      if (!cancelled) { setCidResolvedBody(processed); setResolvedCids(resolved); setPendingCids(false) }
    })()
    return () => { cancelled = true }
  }, [message.id, message.body, attachmentIdKey, expanded])

  return (
    <div className={`${!isLast ? 'border-b border-black/[0.04]' : ''}`}>
      {/* Message header — always visible, clickable to toggle */}
      <button
        onClick={() => { if (expanded) collapsedIds.current.add(message.id); else collapsedIds.current.delete(message.id); setExpanded(!expanded) }}
        className="w-full text-left px-8 py-4 flex items-start gap-3.5 hover:bg-black/[0.015] transition-colors duration-150 cursor-pointer"
      >
        <div
          className="w-[34px] h-[34px] rounded-full flex items-center justify-center shrink-0 text-[12px] font-semibold text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
          style={{ backgroundColor: avatarBg(senderName) }}
        >
          {senderName.charAt(0).toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-[13px] font-semibold text-text-1 truncate tracking-tight shrink-0 max-w-[45%]">{senderName}</span>
              {!expanded && (
                <span className="text-[11.5px] text-text-3 truncate min-w-0 flex-1">{decodedSnippet}</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[10.5px] text-text-3 tabular-nums">{fullDate}</span>
              <span className="text-text-3/60"><ChevronIcon direction={expanded ? 'up' : 'down'} /></span>
            </div>
          </div>
          {expanded && (() => {
            const toNames = splitAddressList(message.to).map((a: string) => parseSenderName(a)).filter(Boolean).join(', ')
            const ccNames = message.cc ? splitAddressList(message.cc).map((a: string) => parseSenderName(a)).filter(Boolean).join(', ') : ''
            const bccNames = message.bcc ? splitAddressList(message.bcc).map((a: string) => parseSenderName(a)).filter(Boolean).join(', ') : ''
            return (toNames || ccNames || bccNames) ? (
              <div className="text-[10.5px] text-text-3 mt-1 tracking-tight">
                {toNames && <>to <span className="text-text-2">{toNames}</span></>}
                {ccNames && <span> · cc <span className="text-text-2">{ccNames}</span></span>}
                {bccNames && <span> · bcc <span className="text-text-2">{bccNames}</span></span>}
              </div>
            ) : null
          })()}
        </div>
      </button>

      {/* Message body */}
      {expanded && (
        <div className="pr-8 pb-5 pl-[62px]">
          {/* Show images prompt */}
          {!showImages && hasBlockedImages && (
            <button
              onClick={() => setShowImages(true)}
              className="mb-3 text-[11px] text-blue-1 hover:underline cursor-pointer tracking-tight"
            >
              Show images
            </button>
          )}

          {/* HTML body — constrain to pane width; wide blocks (tables, code) scroll within */}
          <div style={{ maxWidth: '100%', minWidth: 0, position: 'relative' }}>
            {message.labelIds.includes('DRAFT') && !message.body?.trim() ? (
              <p className="text-[12.5px] text-text-3/50 italic">(empty draft)</p>
            ) : !message.body?.trim() && !message.attachments.length ? (
              <p className="text-[12.5px] text-text-3/50 italic">(empty body)</p>
            ) : (
              <div
                className="text-[12.5px] text-text-2 leading-[1.6] workbook-content overflow-x-auto"
                style={{ overflowWrap: 'break-word', maxWidth: '100%' }}
                dangerouslySetInnerHTML={{ __html: sanitizedBody }}
              />
            )}
          </div>

          {/* Attachments */}
          {(!(pendingCids && resolvedCids.size === 0) || message.attachments.some(att => !att.contentId)) && message.attachments.some(att => !att.contentId || !resolvedCids.has(att.contentId)) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.filter(att => !att.contentId || !resolvedCids.has(att.contentId)).map(att => (
                <div key={att.id}>
                  <button
                    onClick={async () => {
                      setDownloadErrors(prev => { const m = new Map(prev); m.delete(att.id); return m })
                      try {
                        const result = await window.electronAPI.gmailDownloadAttachment(message.id, att.id, att.filename)
                        if (result && !result.ok && !result.canceled) setDownloadErrors(prev => new Map(prev).set(att.id, result.error || 'Download failed'))
                      } catch (err) {
                        setDownloadErrors(prev => new Map(prev).set(att.id, err instanceof Error ? err.message : 'Download failed'))
                      }
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-1 border border-black/[0.06] rounded-lg text-[10px] text-text-2 cursor-pointer hover:bg-black/[0.04] transition-colors"
                  >
                    <AttachmentIcon />
                    <span className="truncate max-w-[140px]">{att.filename}</span>
                    <span className="text-text-3">{formatFileSize(att.size)}</span>
                  </button>
                  {downloadErrors.get(att.id) && (
                    <p role="alert" className="mt-1 text-[10px] text-red-1">{downloadErrors.get(att.id)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ── Compose Drawer (Gmail-style bottom-right slide-in) ──────────────────────

interface ComposeDrawerProps {
  onSend: (opts: { to: string; cc?: string; bcc?: string; subject: string; body: string }) => Promise<void>
  onClose: () => void
  onDiscard?: () => void
  initial?: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string }
  title?: string
  warning?: string
}

const ComposeModal = React.memo(function ComposeDrawer({ onSend, onClose, onDiscard, initial, title, warning }: ComposeDrawerProps) {
  const [to, setTo] = useState(initial?.to ?? '')
  const [cc, setCc] = useState(initial?.cc ?? '')
  const [showCc, setShowCc] = useState(!!initial?.cc)
  const [bcc, setBcc] = useState(initial?.bcc ?? '')
  const [showBcc, setShowBcc] = useState(!!initial?.bcc)
  const [subject, setSubject] = useState(initial?.subject ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnNoSubject, setWarnNoSubject] = useState(false)
  const [warnUnsavedDraft, setWarnUnsavedDraft] = useState(false)
  const [closing, setClosing] = useState(false)
  const toRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<Element | null>(null)
  const sendingRef = useRef(false)

  useEffect(() => {
    returnFocusRef.current = document.activeElement
    toRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => { if (returnFocusRef.current instanceof HTMLElement) returnFocusRef.current.focus() }
  }, [])

  // Focus trap
  useEffect(() => {
    const modal = modalRef.current
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
  }, [])

  function handleClose() {
    const hasEdits = subject !== (initial?.subject ?? '') || body !== (initial?.body ?? '') ||
      to !== (initial?.to ?? '') || cc !== (initial?.cc ?? '') || bcc !== (initial?.bcc ?? '')
    if (hasEdits) { setWarnUnsavedDraft(true); return }
    setClosing(true)
    setTimeout(onClose, 180)
  }

  function handleDiscard() {
    setClosing(true)
    setTimeout(onDiscard ?? onClose, 180)
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!to.trim() || !body.trim()) {
      const missingTo = !to.trim()
      const missingBody = !body.trim()
      setError(missingTo && missingBody ? 'Please fill in the To and message fields' : missingTo ? 'Please fill in the To field' : 'Please fill in the message field')
      return
    }
    if (!subject.trim() && !warnNoSubject) { setWarnNoSubject(true); return }
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      await onSend({ to: to.trim(), cc: cc.trim() || undefined, bcc: bcc.trim() || undefined, subject: subject.trim(), body: body.trim() })
      setClosing(true)
      setTimeout(onClose, 180)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') handleClose()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSend(e as unknown as React.FormEvent) }
  }

  return (
    <div
      className={`fixed bottom-5 right-5 z-[100] ${closing ? 'compose-drawer-exit' : 'compose-drawer-enter'}`}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-modal-title"
        className="w-[560px] max-w-[95vw] max-h-[85vh] flex flex-col bg-surface-0 border border-[color:var(--color-hairline)] rounded-2xl shadow-[0_24px_60px_-20px_rgba(26,23,21,0.25),_0_8px_20px_-10px_rgba(26,23,21,0.12)] overflow-hidden"
      >
        {/* Header — paper-ivory tonal strip */}
        <div className="shrink-0 px-5 py-3 flex items-center justify-between border-b border-[color:var(--color-hairline)] bg-surface-1">
          <h2 id="compose-modal-title" className="text-[12.5px] font-semibold text-text-1 tracking-tight">{title ?? 'New Message'}</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-full text-text-3 hover:text-text-1 hover:bg-black/[0.06] transition-all duration-150 cursor-pointer"
            aria-label="Close compose"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSend} className="flex-1 flex flex-col overflow-hidden">
          {/* To / CC / Subject — row-based, hairline separators */}
          <div className="shrink-0 px-5">
            <div className="flex items-center gap-3 py-2.5 border-b border-black/[0.04]">
              <label htmlFor="compose-to" className="text-[11px] text-text-3 w-10 shrink-0 tracking-tight">To</label>
              <input
                ref={toRef}
                id="compose-to"
                type="text"
                value={to}
                onChange={e => setTo(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                placeholder="recipient@example.com"
                className="flex-1 text-[13px] bg-transparent border-0 focus:outline-none text-text-1 placeholder-text-3/40 tracking-tight"
              />
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="text-[10.5px] text-text-3 hover:text-text-1 transition-colors cursor-pointer px-1.5 py-0.5 rounded-md hover:bg-black/[0.04]"
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  type="button"
                  onClick={() => setShowBcc(true)}
                  className="text-[10.5px] text-text-3 hover:text-text-1 transition-colors cursor-pointer px-1.5 py-0.5 rounded-md hover:bg-black/[0.04]"
                >
                  Bcc
                </button>
              )}
            </div>

            {showCc && (
              <div className="flex items-center gap-3 py-2.5 border-b border-black/[0.04]">
                <label htmlFor="compose-cc" className="text-[11px] text-text-3 w-10 shrink-0 tracking-tight">Cc</label>
                <input
                  id="compose-cc"
                  type="text"
                  value={cc}
                  onChange={e => setCc(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                  placeholder="cc@example.com"
                  className="flex-1 text-[13px] bg-transparent border-0 focus:outline-none text-text-1 placeholder-text-3/40 tracking-tight"
                />
              </div>
            )}

            {showBcc && (
              <div className="flex items-center gap-3 py-2.5 border-b border-black/[0.04]">
                <label htmlFor="compose-bcc" className="text-[11px] text-text-3 w-10 shrink-0 tracking-tight">Bcc</label>
                <input
                  id="compose-bcc"
                  type="text"
                  value={bcc}
                  onChange={e => setBcc(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                  placeholder="bcc@example.com"
                  className="flex-1 text-[13px] bg-transparent border-0 focus:outline-none text-text-1 placeholder-text-3/40 tracking-tight"
                />
              </div>
            )}

            <div className="flex items-center gap-3 py-2.5 border-b border-black/[0.04]">
              <label htmlFor="compose-subject" className="text-[11px] text-text-3 w-10 shrink-0 tracking-tight">Subject</label>
              <input
                id="compose-subject"
                type="text"
                value={subject}
                onChange={e => { setSubject(e.target.value); if (warnNoSubject) setWarnNoSubject(false) }}
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                placeholder="Subject"
                className="flex-1 text-[14px] font-medium bg-transparent border-0 focus:outline-none text-text-1 placeholder-text-3/40 tracking-tight"
              />
            </div>
          </div>

          {warning && (
            <div role="alert" className="shrink-0 mx-5 mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
              <span className="text-[11px] text-amber-700 tracking-tight">{warning}</span>
            </div>
          )}

          {/* Body — roomy, no visible border */}
          <div className="flex-1 px-5 py-3 overflow-y-auto">
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Write your message…"
              rows={10}
              className="w-full h-full min-h-[200px] px-0 py-0 text-[13px] bg-transparent border-0 focus:outline-none text-text-1 placeholder-text-3/45 resize-none leading-relaxed tracking-tight"
            />
          </div>

          {warnNoSubject && (
            <div role="alert" className="shrink-0 mx-5 mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-between gap-3">
              <span className="text-[11px] text-amber-700 tracking-tight">No subject — send anyway?</span>
              <button type="submit" className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 transition-colors cursor-pointer underline underline-offset-2">Send anyway</button>
            </div>
          )}
          {warnUnsavedDraft && (
            <div role="alert" className="shrink-0 mx-5 mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-between gap-3">
              <span className="text-[11px] text-amber-700 tracking-tight">Discard unsaved edits?</span>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setWarnUnsavedDraft(false)} className="text-[11px] text-amber-700 hover:text-amber-900 transition-colors cursor-pointer underline underline-offset-2">Keep editing</button>
                <button type="button" onClick={() => { setClosing(true); setTimeout(onDiscard ?? onClose, 180) }} className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 transition-colors cursor-pointer underline underline-offset-2">Discard</button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="shrink-0 px-5 pb-2 text-[10.5px] text-red-1">{error}</p>
          )}

          {/* Actions */}
          <div className="shrink-0 flex items-center justify-between px-5 py-3 border-t border-[color:var(--color-hairline)] bg-surface-1">
            <span className="text-[10px] text-text-3/60 tracking-tight">Esc to close</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDiscard}
                className="px-3.5 py-1.5 rounded-full text-[11.5px] font-medium text-text-3 hover:text-text-1 hover:bg-black/[0.04] transition-all duration-150 cursor-pointer"
              >
                Discard
              </button>
              <button
                type="submit"
                disabled={!to.trim() || !body.trim() || sending}
                className="flex items-center gap-1.5 px-5 py-1.5 rounded-full text-[11.5px] font-semibold text-white bg-gradient-to-b from-blue-1 to-blue-1/90 hover:shadow-[0_4px_14px_rgba(59,130,246,0.4)] active:scale-[0.98] transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_2px_6px_rgba(59,130,246,0.25)]"
              >
                {sending ? <SpinnerIcon /> : <SendIcon />}
                Send
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
})

// ── Undo-send Toast ──────────────────────────────────────────────────────────

interface UndoSendToastProps {
  label: string
  expiresAt: number
  onUndo: () => void
}

const UndoSendToast = React.memo(function UndoSendToast({ label, expiresAt, onUndo }: UndoSendToastProps) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()))
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Date.now()))
    }, 100)
    return () => clearInterval(id)
  }, [expiresAt])

  const total = 5000
  const progress = Math.max(0, Math.min(1, remaining / total))

  return (
    <div className="fixed bottom-5 left-5 z-[110] compose-drawer-enter">
      <div className="relative flex items-center gap-3 pl-4 pr-2 py-2 rounded-full bg-[color:var(--color-text-1)] text-[color:var(--color-paper-cream)] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)] overflow-hidden">
        {/* Progress rail */}
        <div
          className="absolute bottom-0 left-0 h-[2px] bg-[color:var(--color-paper-cream)]/70 transition-[width] duration-100 ease-linear"
          style={{ width: `${progress * 100}%` }}
        />
        <span className="text-[12px] font-medium tracking-tight">{label}</span>
        <button
          onClick={onUndo}
          className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-paper-cream)] hover:text-white px-3 py-1 rounded-full hover:bg-white/10 transition-colors cursor-pointer"
          aria-label="Undo send"
        >
          Undo
        </button>
      </div>
    </div>
  )
})

// ── Main Component ───────────────────────────────────────────────────────────

export function EmailView({ onUnreadCount }: { onUnreadCount?: (count: number) => void }) {
  // State
  const [messages, setMessages] = useState<GmailMessageSummary[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [thread, setThread] = useState<GmailThread | null>(null)
  const threadRef = useRef<GmailThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingThread, setLoadingThread] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [composing, setComposing] = useState(false)
  const [draftBeingEdited, setDraftBeingEdited] = useState<{ threadId: string; messageId: string; to: string; cc: string; bcc: string; subject: string; body: string; messageIdHeader?: string; inReplyTo?: string; references?: string; htmlWarning?: boolean } | null>(null)
  // Resume-prefill for fresh composes that were undone (no backing draft to trash)
  const [composeResumeInitial, setComposeResumeInitial] = useState<{ to: string; cc: string; bcc: string; subject: string; body: string } | null>(null)
  // Undo-send toast: one pending send at a time. Execute fires the API, undo restores UI state.
  const [pendingSend, setPendingSend] = useState<{ label: string; threadId: string; expiresAt: number; execute: () => void; undo: () => void } | null>(null)
  const pendingSendRef = useRef<typeof pendingSend>(null)
  pendingSendRef.current = pendingSend
  const pendingSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const pendingReplyDraftsRef = useRef<Map<string, string>>(new Map())
  const [nextPageToken, setNextPageToken] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [loadWarning, setLoadWarning] = useState<string | null>(null)
  const [, setRelativeDateTick] = useState(0)
  const [selectedFolder, setSelectedFolder] = useState<FolderKey>('INBOX')
  const [labels, setLabels] = useState<GmailLabelLite[]>([])
  const [inboxUnreadCount, setInboxUnreadCount] = useState(0)
  const [sendError, setSendError] = useState<string | null>(null)
  const [flushNotice, setFlushNotice] = useState<string | null>(null)
  const flushNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sendingReply, setSendingReply] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [labelSyncError, setLabelSyncError] = useState(false)

  // Refs
  const mountedRef = useRef(true)
  const focusedThreadIdRef = useRef<string | null>(null)
  const selectedFolderRef = useRef<FolderKey>('INBOX')
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval>>()
  const messagesRef = useRef<GmailMessageSummary[]>([])
  const searchQueryRef = useRef(searchQuery)
  const submittedSearchQueryRef = useRef(searchQuery)
  const selectedThreadIdRef = useRef<string | null>(null)
  const listPaneRef = useRef<HTMLDivElement>(null)
  const threadScrollRef = useRef<HTMLDivElement>(null)
  const threadScrolledUpRef = useRef(false)
  const firstUnreadIdxRef = useRef(-1)
  const [newThreadReplies, setNewThreadReplies] = useState(0)
  const prevThreadMsgCountRef = useRef(0)
  const [listWidth, setListWidth] = useState(380)
  const resizingRef = useRef(false)
  const resizeStartXRef = useRef(0)
  const resizeStartWidthRef = useRef(0)
  const resizeMoveHandlerRef = useRef<((e: MouseEvent) => void) | null>(null)
  const resizeUpHandlerRef = useRef<(() => void) | null>(null)
  const selfRef = useRef<{ displayName: string; email: string } | null>(null)
  const recentlyReadThreadIdsRef = useRef<Set<string>>(new Set())
  const recentlyReadTimestampsRef = useRef<Map<string, number>>(new Map())
  const collapsedIdsRef = useRef<Set<string>>(new Set())
  const optimisticallyDecrementedRef = useRef<Set<string>>(new Set())
  const recentlyRemovedThreadsRef = useRef<Map<string, number>>(new Map())
  const lastMarkReadAtByFolderRef = useRef<Map<string, number>>(new Map())
  const loadingMoreRef = useRef(false)
  const loadGenRef = useRef(0)
  const labelsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const nextPageTokenRef = useRef<string | null>(null)
  const nextPageTokenSetAtRef = useRef<number>(0)
  const sendingReplyRef = useRef(false)
  const sendingReplyForThreadRef = useRef<string | null>(null)
  const replyDraftRef = useRef('')
  const archivingRef = useRef(false)
  const trashingRef = useRef(false)
  const movingToInboxRef = useRef(false)
  const untrashingRef = useRef(false)
  const pendingArchiveRef = useRef(false)
  const gmailPollFailCountRef = useRef(0)
  const gmailLabelPollFailCountRef = useRef(0)
  const gmailSilentThreadPollFailCountRef = useRef(0)
  const gmailMarkReadFailCountRef = useRef(new Map<string, number>())
  const gmailSilentPollInFlightRef = useRef(new Map<string, boolean>())
  const gmailSilentThreadPollInFlightRef = useRef<Map<string, boolean>>(new Map())
  const gmailLabelPollInFlightRef = useRef(false)
  const prevThreadIsUnreadRef = useRef(false)

  // Keep refs in sync
  threadRef.current = thread
  messagesRef.current = messages
  nextPageTokenRef.current = nextPageToken
  focusedThreadIdRef.current = focusedThreadId
  selectedFolderRef.current = selectedFolder
  replyDraftRef.current = replyDraft

  // ── Data loading ─────────────────────────────────────────────────────────

  const loadMessages = useCallback(async (query?: string, append?: boolean, silent?: boolean) => {
    const pollKey = `${selectedFolderRef.current}|${query ?? ''}`
    if (silent && gmailSilentPollInFlightRef.current.get(pollKey)) return
    if (!append && !silent) setLoading(true)
    if (!silent) setError(null)
    const requestedFolder = selectedFolderRef.current
    const requestedQuery = query ?? null
    const gen = !append && !silent ? ++loadGenRef.current : -1
    try {
      const opts: { query?: string; pageToken?: string; labelIds?: string[]; includeSpamTrash?: boolean } = {}
      if (query) {
        const folder = selectedFolderRef.current
        if (folder === 'TRASH') {
          opts.query = query; opts.includeSpamTrash = true; opts.labelIds = ['TRASH']
        } else if (folder === 'SENT') {
          opts.query = `in:sent ${query}`
        } else if (folder === 'DRAFT') {
          opts.query = `is:draft ${query}`
        } else if (folder === 'INBOX') {
          opts.query = `in:inbox ${query}`
        } else if (folder === 'STARRED') {
          opts.query = `in:starred -in:trash -in:spam ${query}`
        } else if (folder.startsWith('LABEL:')) {
          opts.query = `label:${folder.slice(6)} ${query}`
        } else if (folder === 'ARCHIVE') {
          opts.query = `-in:inbox -in:trash -in:spam -is:draft ${query}`
        } else {
          opts.query = query
        }
      } else {
        const folderOpts = folderToListOpts(selectedFolderRef.current)
        Object.assign(opts, folderOpts)
      }
      if (append && nextPageTokenRef.current) opts.pageToken = nextPageTokenRef.current
      if (silent) gmailSilentPollInFlightRef.current.set(pollKey, true)
      const result = await window.electronAPI.gmailListMessages(opts)
      if (selectedFolderRef.current !== requestedFolder) return  // stale: folder changed mid-flight
      if (!mountedRef.current) return
      if (append) {
        if (requestedQuery !== null && requestedQuery !== submittedSearchQueryRef.current) return
        setMessages(prev => {
          const prevMap = new Map(prev.map(m => [m.threadId, m]))
          const appendNow = Date.now()
          result.messages.forEach((m: GmailMessageSummary) => {
            const forcedRead = recentlyReadThreadIdsRef.current.has(m.threadId) && (appendNow - (recentlyReadTimestampsRef.current.get(m.threadId) ?? 0)) <= 5 * 60 * 1000
            prevMap.set(m.threadId, forcedRead ? { ...m, isUnread: false } : m)
          })
          const ts = (m: GmailMessageSummary) => m.internalDate ? Number(m.internalDate) : (() => { const v = new Date(m.date).getTime(); return isNaN(v) ? 0 : v })()
          return [...prevMap.values()].sort((a, b) => ts(b) - ts(a))
        })
      } else if (silent) {
        if (requestedQuery !== null && requestedQuery !== submittedSearchQueryRef.current) return
        const TEN_MIN = 10 * 60 * 1000
        const FIVE_MIN = 5 * 60 * 1000
        recentlyReadTimestampsRef.current.forEach((addedAt, id) => {
          if (Date.now() - addedAt > TEN_MIN) {
            recentlyReadThreadIdsRef.current.delete(id)
            recentlyReadTimestampsRef.current.delete(id)
            optimisticallyDecrementedRef.current.delete(id)
          }
        })
        recentlyRemovedThreadsRef.current.forEach((removedAt, id) => {
          if (Date.now() - removedAt > FIVE_MIN) recentlyRemovedThreadsRef.current.delete(id)
        })
        // Silent poll: prepend new threads, refresh metadata, and remove externally archived/trashed threads
        setMessages(prev => {
          if (prev.length === 0) return result.messages
          const freshById = new Map<string, GmailMessageSummary>(
            result.messages.map((m: GmailMessageSummary) => [m.threadId, m])
          )
          const existingIds = new Set(prev.map(m => m.threadId))
          const newMessages = result.messages.filter((m: GmailMessageSummary) => {
            if (existingIds.has(m.threadId)) return false
            const removedAt = recentlyRemovedThreadsRef.current.get(m.threadId)
            if (removedAt !== undefined && Date.now() - removedAt < FIVE_MIN) {
              // Let it through if the server now shows it in INBOX — a reply re-added it
              if (m.labelIds?.includes('INBOX')) { recentlyRemovedThreadsRef.current.delete(m.threadId); return true }
              return false
            }
            return true
          })
          // Determine the oldest thread date in the fresh results — threads newer than this
          // that are NOT in fresh results have been archived/trashed externally.
          // Threads older than this are from pagination and kept as-is.
          const freshTimes = result.messages.map((m: GmailMessageSummary) => m.internalDate ? Number(m.internalDate) : new Date(m.date).getTime()).filter((t: number) => !isNaN(t))
          const oldestFreshTime = freshTimes.length > 0 ? Math.min(...freshTimes) : Infinity
          const failedIds = new Set<string>(result.failedThreadIds ?? [])
          const updated = prev
            .map(m => {
              const fresh = freshById.get(m.threadId)
              if (fresh) {
                const inSet = recentlyReadThreadIdsRef.current.has(m.threadId)
                const addedAt = inSet ? (recentlyReadTimestampsRef.current.get(m.threadId) ?? 0) : 0
                const freshTime = fresh.internalDate ? Number(fresh.internalDate) : new Date(fresh.date).getTime()
                const hasNewReply = inSet && freshTime > addedAt
                const forceRead = inSet && !hasNewReply && Date.now() - addedAt <= 5 * 60 * 1000
                if (inSet && (hasNewReply || !forceRead || !fresh.isUnread)) {
                  recentlyReadThreadIdsRef.current.delete(m.threadId)
                  recentlyReadTimestampsRef.current.delete(m.threadId)
                  optimisticallyDecrementedRef.current.delete(m.threadId)
                }
                return { ...fresh, isUnread: forceRead ? false : fresh.isUnread }
              }
              return m
            })
            .filter(m => {
              if (freshById.has(m.threadId)) return true
              // Never evict the thread currently open — Gmail may not have indexed a just-sent reply yet
              if (m.threadId === selectedThreadIdRef.current) return true
              // Preserve threads that specifically failed to fetch — they may still exist
              if (failedIds.has(m.threadId)) return true
              // Inbox empty — remove all
              if (result.messages.length === 0) return false
              // Keep threads older than the fresh page (from pagination); evict newer ones that vanished.
              // If internalDate is missing, keep conservatively — sender-supplied Date headers are unreliable.
              const t = m.internalDate ? Number(m.internalDate) : new Date(m.date).getTime()
              return isNaN(t) ? true : (t <= oldestFreshTime && t < Date.now() + 86400_000)
            })
          const getTime = (m: GmailMessageSummary) => { const t = m.internalDate ? Number(m.internalDate) : new Date(m.date).getTime(); return isNaN(t) ? 0 : t }
          const sorted = updated.sort((a, b) => getTime(b) - getTime(a))
          if (newMessages.length === 0) return sorted
          return [...newMessages, ...sorted].sort((a, b) => getTime(b) - getTime(a))
        })
        if ((result.failedCount ?? 0) === 0) setLoadWarning(null)
      } else {
        if (requestedQuery !== null && requestedQuery !== submittedSearchQueryRef.current) return
        if (gen !== -1 && loadGenRef.current !== gen) return
        const now = Date.now()
        const messages = result.messages.map((m: GmailMessageSummary) => {
          if (!recentlyReadThreadIdsRef.current.has(m.threadId)) return m
          const addedAt = recentlyReadTimestampsRef.current.get(m.threadId) ?? 0
          if (now - addedAt > 5 * 60 * 1000) return m
          return { ...m, isUnread: false }
        })
        setMessages(messages)
      }
      if (!silent) {
        setNextPageToken(result.nextPageToken ?? null)
        if (result.nextPageToken) nextPageTokenSetAtRef.current = Date.now()
      }
      if (!silent) {
        if ((result.failedCount ?? 0) > 0) {
          setLoadWarning(`${result.failedCount} thread${result.failedCount !== 1 ? 's' : ''} failed to load`)
        } else {
          setLoadWarning(null)
        }
      }
      if (mountedRef.current) setError(null)
      if (silent) gmailPollFailCountRef.current = 0
    } catch (err) {
      if (append && mountedRef.current) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // Expired pagination tokens return HTTP 400 or an "invalid" token error.
        // Clear the stale token and restart pagination from the beginning.
        if (/400|invalid.*token|invalid cursor/i.test(errMsg)) {
          setNextPageToken(null)
          nextPageTokenSetAtRef.current = 0
          loadMessages(submittedSearchQueryRef.current || undefined)
        } else {
          setError(errMsg || 'Failed to load more messages')
        }
      } else if (mountedRef.current && (gen !== -1 && loadGenRef.current === gen)) setError(err instanceof Error ? err.message : 'Failed to load messages')
      if (silent) gmailPollFailCountRef.current++
    } finally {
      if (silent) gmailSilentPollInFlightRef.current.delete(pollKey)
      if (!silent) loadingMoreRef.current = false
      if (mountedRef.current) {
        if (gen !== -1 && loadGenRef.current === gen) {
          setLoading(false)
          setRefreshing(false)
        }
        if (!silent) setLoadingMore(false)
      }
    }
  }, [])

  const loadMessagesRef = useRef(loadMessages)

  const loadThread = useCallback(async (threadId: string, silent?: boolean) => {
    if (silent && gmailSilentThreadPollInFlightRef.current.get(threadId)) return
    const wasUnread = messagesRef.current.find(m => m.threadId === threadId)?.isUnread ?? false
    if (!silent) setLoadingThread(true)
    if (!silent) setThreadError(null)
    if (!silent) {
      const pending = pendingReplyDraftsRef.current.get(threadId)
      pendingReplyDraftsRef.current.delete(threadId)
      setReplyDraft(pending ?? '')
      if (pending) requestAnimationFrame(() => { const el = replyTextareaRef.current; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } })
    }
    if (!silent) setReplyError(null)
    try {
      if (silent) gmailSilentThreadPollInFlightRef.current.set(threadId, true)
      const t = await window.electronAPI.gmailGetThread(threadId)
      if (threadId !== selectedThreadIdRef.current) {
        if (recentlyReadThreadIdsRef.current.has(threadId)) {
          // UI already shows thread as read — sync to server even though user switched away
          window.electronAPI.gmailMarkThreadRead(threadId).catch(() => {})
        } else if (optimisticallyDecrementedRef.current.has(threadId)) {
          // Stale and never marked read — restore the optimistic unread-count decrement
          optimisticallyDecrementedRef.current.delete(threadId)
          setInboxUnreadCount(prev => prev + 1)
        }
        return
      }
      if (!mountedRef.current) return
      if (silent) {
        gmailSilentThreadPollFailCountRef.current = 0
        firstUnreadIdxRef.current = recentlyReadThreadIdsRef.current.has(threadId) ? -1 : t.messages.findIndex((m: GmailMessage) => m.isUnread)
        // Preserve in-progress reply draft if silent poll reveals thread now ends with DRAFT/TRASH
        const incomingLastReal = [...t.messages].reverse().find((m: GmailMessage) => !m.id.startsWith('optimistic-'))
        const prevLastReal = [...(threadRef.current?.messages ?? [])].reverse().find((m: GmailMessage) => !m.id.startsWith('optimistic-'))
        if (
          incomingLastReal?.labelIds?.some((l: string) => l === 'DRAFT' || l === 'TRASH') &&
          !prevLastReal?.labelIds?.some((l: string) => l === 'DRAFT' || l === 'TRASH') &&
          replyDraftRef.current.trim()
        ) {
          pendingReplyDraftsRef.current.set(threadId, replyDraftRef.current)
          if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
        }
        setThread(prev => {
          if (!prev) return t
          const serverIds = new Set(t.messages.map((m: GmailMessage) => m.id))
          const optimisticTail = prev.messages.filter((m: GmailMessage) => {
            if (!m.id.startsWith('optimistic-') || serverIds.has(m.id)) return false
            // Drop optimistic once Gmail has indexed the real reply (SENT message within 2min)
            const optimisticTs = new Date(m.date).getTime()
            return !t.messages.some((sm: GmailMessage) =>
              sm.labelIds?.includes('SENT') && Math.abs((sm.internalDate ? Number(sm.internalDate) : new Date(sm.date).getTime()) - optimisticTs) < 120_000
            )
          })
          return optimisticTail.length > 0 ? { ...t, messages: [...t.messages, ...optimisticTail] } : t
        })
        // If new unread messages arrived and the user is still viewing at the bottom, mark read
        const unreadMsgs = t.messages.filter((m: GmailMessage) => m.isUnread)
        if (unreadMsgs.length > 0 && !threadScrolledUpRef.current) {
          const lastReadAt = recentlyReadTimestampsRef.current.get(threadId) ?? 0
          const hasNewUnread = unreadMsgs.some((m: GmailMessage) => (m.internalDate ? Number(m.internalDate) : new Date(m.date).getTime()) > lastReadAt)
          if (hasNewUnread || !recentlyReadThreadIdsRef.current.has(threadId)) {
            if ((gmailMarkReadFailCountRef.current.get(threadId) ?? 0) < 3) {
              const firstRead = !recentlyReadThreadIdsRef.current.has(threadId)
              const threadHasInbox = t.messages.some((m: GmailMessage) => (m.labelIds || []).includes('INBOX'))
              recentlyReadTimestampsRef.current.set(threadId, Date.now())
              firstUnreadIdxRef.current = -1
              recentlyReadThreadIdsRef.current.add(threadId)
              window.electronAPI.gmailMarkThreadRead(threadId)
                .then(() => {
                  gmailMarkReadFailCountRef.current.delete(threadId)
                  if (threadHasInbox) lastMarkReadAtByFolderRef.current.set('INBOX', Date.now())
                  recentlyReadTimestampsRef.current.set(threadId, Date.now())
                  setMessages(prev => prev.map(m =>
                    m.threadId === threadId ? { ...m, isUnread: false } : m
                  ))
                  setThread(prev => prev && prev.id === threadId
                    ? { ...prev, messages: prev.messages.map(m => ({ ...m, isUnread: false })) }
                    : prev
                  )
                  if (firstRead && threadHasInbox && !optimisticallyDecrementedRef.current.has(threadId)) setInboxUnreadCount(prev => Math.max(0, prev - 1))
                })
                .catch(e => { gmailMarkReadFailCountRef.current.set(threadId, (gmailMarkReadFailCountRef.current.get(threadId) ?? 0) + 1); recentlyReadTimestampsRef.current.delete(threadId); recentlyReadThreadIdsRef.current.delete(threadId); setMessages(prev => prev.map(m => m.threadId === threadId ? { ...m, isUnread: true } : m)); console.warn('[email] mark-thread-read failed (silent):', e) })
            }
          }
        }
      } else {
        gmailMarkReadFailCountRef.current.delete(threadId)
        firstUnreadIdxRef.current = t.messages.findIndex((m: GmailMessage) => m.isUnread)
        setThread(t)
      }
      // Publish rich context for the ROCA Assistant to read on demand
      if (!silent && t.messages.length > 0) {
        const latest = t.messages[t.messages.length - 1]
        const stripped = (latest.body || '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000)
        window.electronAPI.writeActiveContext({
          tab: 'email',
          email: {
            threadId: t.id,
            subject: t.messages[0].subject || '(no subject)',
            from: latest.from,
            to: latest.to,
            messageCount: t.messages.length,
            latestMessageText: stripped,
          },
        }).catch(() => {})
      }
      // Mark all unread messages as read — only on explicit open, not background polls
      if (!silent) {
        const unreadMsgs = t.messages.filter((m: GmailMessage) => m.isUnread)
        if (unreadMsgs.length > 0) {
          const firstRead = !recentlyReadThreadIdsRef.current.has(threadId)
          const threadHasInbox = t.messages.some((m: GmailMessage) => (m.labelIds || []).includes('INBOX'))
          recentlyReadThreadIdsRef.current.add(threadId)
          recentlyReadTimestampsRef.current.set(threadId, Date.now())
          const savedFirstUnreadIdx = firstUnreadIdxRef.current
          window.electronAPI.gmailMarkThreadRead(threadId)
            .then(() => {
              if (threadHasInbox) lastMarkReadAtByFolderRef.current.set('INBOX', Date.now())
              firstUnreadIdxRef.current = -1
              setMessages(prev => prev.map(m =>
                m.threadId === threadId ? { ...m, isUnread: false } : m
              ))
              setThread(prev => prev && prev.id === threadId ? { ...prev, messages: prev.messages.map(m => ({ ...m, isUnread: false })) } : prev)
              if (firstRead && threadHasInbox && !optimisticallyDecrementedRef.current.has(threadId)) setInboxUnreadCount(prev => Math.max(0, prev - 1))
            })
            .catch(e => {
              if (threadId !== selectedThreadIdRef.current) return
              console.warn('[email] mark-thread-read failed:', e)
              firstUnreadIdxRef.current = savedFirstUnreadIdx
              setMessages(prev => prev.map(m => m.threadId === threadId ? { ...m, isUnread: true } : m))
              recentlyReadThreadIdsRef.current.delete(threadId)
              recentlyReadTimestampsRef.current.delete(threadId)
              if (optimisticallyDecrementedRef.current.has(threadId)) {
                optimisticallyDecrementedRef.current.delete(threadId)
                setInboxUnreadCount(prev => prev + 1)
              }
            })
        }
      }
    } catch (err) {
      recentlyReadThreadIdsRef.current.delete(threadId)
      recentlyReadTimestampsRef.current.delete(threadId)
      if (threadId === selectedThreadIdRef.current) pendingArchiveRef.current = false
      if (silent) gmailSilentThreadPollFailCountRef.current++
      if (mountedRef.current && threadId === selectedThreadIdRef.current && !silent) {
        setMessages(prev => prev.map(m => m.threadId === threadId ? { ...m, isUnread: wasUnread } : m))
        setThreadError(err instanceof Error ? err.message : 'Failed to load thread')
        if (wasUnread && optimisticallyDecrementedRef.current.has(threadId)) {
          optimisticallyDecrementedRef.current.delete(threadId)
          setInboxUnreadCount(prev => prev + 1)
        }
      }
    } finally {
      if (silent) gmailSilentThreadPollInFlightRef.current.delete(threadId)
      if (mountedRef.current && threadId === selectedThreadIdRef.current && !silent) setLoadingThread(false)
    }
  }, [])
  const loadThreadRef = useRef(loadThread)

  // Initial load
  useEffect(() => {
    mountedRef.current = true
    loadMessages()
    window.electronAPI.gmailGetProfile().then(p => { if (p) { selfRef.current = p } }).catch(() => {})
    window.electronAPI.gmailGetLabels()
      .then(ls => {
        if (!mountedRef.current) return
        setLabels(ls)
        const inbox = ls.find(l => l.id === 'INBOX')
        if (inbox?.threadsUnread != null) setInboxUnreadCount(inbox.threadsUnread)
      })
      .catch(e => {
        console.warn('[email] gmailGetLabels failed:', e)
        labelsRetryTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return
          if (gmailLabelPollInFlightRef.current) return
          gmailLabelPollInFlightRef.current = true
          window.electronAPI.gmailGetLabels()
            .then(ls => {
              if (!mountedRef.current) return
              setLabels(ls)
              const inbox = ls.find(l => l.id === 'INBOX')
              if (inbox?.threadsUnread != null) setInboxUnreadCount(inbox.threadsUnread)
            })
            .catch(() => {})
            .finally(() => { gmailLabelPollInFlightRef.current = false })
        }, 5000)
      })
    // Intentional: pendingSendTimerRef closure runs to completion after unmount so in-flight sends complete
    return () => { mountedRef.current = false; clearTimeout(labelsRetryTimerRef.current); if (flushNoticeTimerRef.current) clearTimeout(flushNoticeTimerRef.current) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup resize listeners if component unmounts during a drag
  useEffect(() => {
    return () => {
      if (resizeMoveHandlerRef.current) document.removeEventListener('mousemove', resizeMoveHandlerRef.current)
      if (resizeUpHandlerRef.current) document.removeEventListener('mouseup', resizeUpHandlerRef.current)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  // Keep searchQueryRef in sync so the polling interval always uses the latest search
  useEffect(() => { searchQueryRef.current = searchQuery }, [searchQuery])

  // Keep loadMessagesRef in sync so the polling interval always holds the latest closure
  useEffect(() => { loadMessagesRef.current = loadMessages }, [loadMessages])

  // Keep loadThreadRef in sync so the polling interval always holds the latest closure
  useEffect(() => { loadThreadRef.current = loadThread }, [loadThread])

  // Polling — refresh every 30s; also refresh immediately on tab visibility restore
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        loadMessagesRef.current(submittedSearchQueryRef.current || undefined, undefined, true)
        if (selectedThreadIdRef.current) loadThreadRef.current(selectedThreadIdRef.current, true)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    pollTimerRef.current = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (gmailPollFailCountRef.current >= 3 && gmailPollFailCountRef.current % 5 !== 0) return
      loadMessagesRef.current(submittedSearchQueryRef.current || undefined, undefined, true)
      if (selectedThreadIdRef.current && !(gmailSilentThreadPollFailCountRef.current >= 3 && gmailSilentThreadPollFailCountRef.current % 5 !== 0)) loadThreadRef.current(selectedThreadIdRef.current, true)
      if (gmailLabelPollFailCountRef.current < 3 || gmailLabelPollFailCountRef.current % 5 === 0) {
        if (!gmailLabelPollInFlightRef.current) {
          gmailLabelPollInFlightRef.current = true
          window.electronAPI.gmailGetLabels()
            .then(ls => {
              if (!mountedRef.current) return
              gmailLabelPollFailCountRef.current = 0
              setLabelSyncError(false)
              setLabels(ls)
              const inbox = ls.find(l => l.id === 'INBOX')
              if (inbox?.threadsUnread != null && Date.now() - (lastMarkReadAtByFolderRef.current.get('INBOX') ?? 0) > 10000) setInboxUnreadCount(inbox.threadsUnread!)
            })
            .catch(() => {
              gmailLabelPollFailCountRef.current++
              if (mountedRef.current && gmailLabelPollFailCountRef.current >= 3) setLabelSyncError(true)
            })
            .finally(() => {
              gmailLabelPollInFlightRef.current = false
            })
        }
      }
    }, 30000)
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Single interval for relative timestamp refresh across all message rows
  useEffect(() => {
    const id = setInterval(() => setRelativeDateTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])

  // Report unread count to parent
  useEffect(() => {
    if (onUnreadCount) onUnreadCount(inboxUnreadCount)
  }, [inboxUnreadCount, onUnreadCount])

  // Auto-scroll thread to first unread on load; fall back to bottom if all messages are read
  useEffect(() => {
    if (!thread?.messages.length) return
    if (threadScrolledUpRef.current) {
      const prev = prevThreadMsgCountRef.current
      const curr = thread.messages.length
      if (curr > prev) setNewThreadReplies(n => n + (curr - prev))
      prevThreadMsgCountRef.current = curr
      return
    }
    prevThreadMsgCountRef.current = thread.messages.length
    const el = threadScrollRef.current
    if (!el) return
    const firstUnreadIdx = firstUnreadIdxRef.current
    if (firstUnreadIdx >= 0) {
      const child = el.children[firstUnreadIdx] as HTMLElement | undefined
      if (child) { child.scrollIntoView({ block: 'start', behavior: 'instant' }); return }
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  }, [thread?.id, thread?.messages.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Infinite scroll ──────────────────────────────────────────────────────

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !listRef.current) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && nextPageToken && !loadingMoreRef.current) {
          const TWENTY_MIN = 20 * 60 * 1000
          if (nextPageTokenSetAtRef.current > 0 && Date.now() - nextPageTokenSetAtRef.current > TWENTY_MIN) {
            setNextPageToken(null)
            nextPageTokenSetAtRef.current = 0
            setRefreshing(true)
            loadMessages(submittedSearchQueryRef.current || undefined)
            return
          }
          loadingMoreRef.current = true
          setLoadingMore(true)
          loadMessages(submittedSearchQueryRef.current || undefined, true)
        }
      },
      { root: listRef.current, threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [nextPageToken]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Resize handling ──────────────────────────────────────────────────────

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    resizeStartXRef.current = e.clientX
    resizeStartWidthRef.current = listWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = e.clientX - resizeStartXRef.current
      const newWidth = Math.max(280, Math.min(600, resizeStartWidthRef.current + delta))
      setListWidth(newWidth)
    }

    const handleMouseUp = () => {
      resizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      resizeMoveHandlerRef.current = null
      resizeUpHandlerRef.current = null
    }

    resizeMoveHandlerRef.current = handleMouseMove
    resizeUpHandlerRef.current = handleMouseUp
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [listWidth])

  const handleThreadScroll = useCallback(() => {
    const el = threadScrollRef.current
    if (!el) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80
    threadScrolledUpRef.current = !atBottom
    if (atBottom) setNewThreadReplies(0)
  }, [])

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    if (labelsRetryTimerRef.current) { clearTimeout(labelsRetryTimerRef.current); labelsRetryTimerRef.current = undefined }
    setRefreshing(true)
    setLoadWarning(null)
    setActionError(null)
    setSendError(null)
    setThreadError(null)
    setNextPageToken(null)
    nextPageTokenSetAtRef.current = 0
    setFocusedThreadId(null)
    pendingArchiveRef.current = false
    collapsedIdsRef.current.clear()
    loadMessages(submittedSearchQueryRef.current || undefined)
    if (selectedThreadIdRef.current && replyDraftRef.current.trim()) {
      pendingReplyDraftsRef.current.set(selectedThreadIdRef.current, replyDraftRef.current)
      if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
    }
    if (selectedThreadIdRef.current && !pendingSendRef.current && !sendingReplyRef.current) {
      loadThread(selectedThreadIdRef.current)
    }
    window.electronAPI.gmailGetLabels().then(ls => {
      if (!mountedRef.current) return
      setLabels(ls)
      setLabelSyncError(false)
      const inbox = ls.find(l => l.id === 'INBOX')
      if (inbox?.threadsUnread != null) setInboxUnreadCount(inbox.threadsUnread)
    }).catch(() => {})
  }, [loadMessages, loadThread])

  const handleFolderChange = useCallback((folder: FolderKey) => {
    if (pendingSendRef.current) {
      if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current)
      pendingSendRef.current.execute()
      setPendingSend(null)
    }
    if (selectedThreadIdRef.current && replyDraftRef.current.trim()) {
      pendingReplyDraftsRef.current.set(selectedThreadIdRef.current, replyDraftRef.current)
      if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
    }
    setReplyDraft('')
    selectedFolderRef.current = folder
    setSelectedFolder(folder)
    setSearchQuery('')
    setIsSearchMode(false)
    submittedSearchQueryRef.current = ''
    setNextPageToken(null)
    nextPageTokenSetAtRef.current = 0
    setMessages([])
    recentlyReadThreadIdsRef.current.clear()
    recentlyReadTimestampsRef.current.clear()
    optimisticallyDecrementedRef.current.clear()
    recentlyRemovedThreadsRef.current.clear()
    setLoadWarning(null)
    setActionError(null)
    setSendError(null)
    setThreadError(null)
    setFocusedThreadId(null)
    selectedThreadIdRef.current = null
    setSelectedThreadId(null)
    setThread(null)
    pendingArchiveRef.current = false
    setLoadingThread(false)
    loadMessages(undefined)
  }, [loadMessages])

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    setActionError(null)
    setSendError(null)
    const trimmedQuery = searchQuery.trim()
    if (trimmedQuery === '' && submittedSearchQueryRef.current === '') return
    if (pendingSendRef.current) {
      if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current)
      pendingSendRef.current.execute()
      setPendingSend(null)
    }
    if (selectedThreadIdRef.current && replyDraftRef.current.trim()) {
      pendingReplyDraftsRef.current.set(selectedThreadIdRef.current, replyDraftRef.current)
      if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
    }
    setReplyDraft('')
    submittedSearchQueryRef.current = trimmedQuery
    setIsSearchMode(!!trimmedQuery)
    selectedThreadIdRef.current = null
    setSelectedThreadId(null)
    setThread(null)
    setLoadingThread(false)
    setNextPageToken(null)
    nextPageTokenSetAtRef.current = 0
    setMessages([])
    recentlyReadThreadIdsRef.current.clear()
    recentlyReadTimestampsRef.current.clear()
    optimisticallyDecrementedRef.current.clear()
    recentlyRemovedThreadsRef.current.clear()
    setLoadWarning(null)
    setFocusedThreadId(null)
    loadMessages(trimmedQuery || undefined)
  }, [loadMessages, searchQuery])

  const handleStarToggle = useCallback((threadId: string, starred: boolean) => {
    // Optimistic: update local state, fire-and-forget API call, rollback on failure
    setMessages(prev => prev.map(m => {
      if (m.threadId !== threadId) return m
      const labelIds = starred
        ? Array.from(new Set([...(m.labelIds || []), 'STARRED']))
        : (m.labelIds || []).filter(l => l !== 'STARRED')
      return { ...m, labelIds }
    }))
    setThread(prev => prev && prev.id === threadId ? {
      ...prev,
      messages: prev.messages.map(m => ({
        ...m,
        labelIds: starred
          ? Array.from(new Set([...(m.labelIds || []), 'STARRED']))
          : (m.labelIds || []).filter(l => l !== 'STARRED')
      }))
    } : prev)
    // Capture pre-mutation state so rollback restores STARRED label correctly
    const originalIndex = messagesRef.current.findIndex(m => m.threadId === threadId)
    const removedThread = messagesRef.current.find(m => m.threadId === threadId)
    if (!starred && selectedFolderRef.current === 'STARRED') {
      setMessages(prev => prev.filter(m => m.threadId !== threadId))
      recentlyRemovedThreadsRef.current.set(threadId, Date.now())
      if (selectedThreadIdRef.current === threadId) {
        selectedThreadIdRef.current = null
        setSelectedThreadId(null)
        setThread(null)
      }
    }
    window.electronAPI.gmailStarThread(threadId, starred).catch(e => {
      console.warn('[email] star toggle failed:', e)
      if (!starred && removedThread) {
        setMessages(prev => {
          const arr = [...prev]
          const removedTime = removedThread!.internalDate ? Number(removedThread!.internalDate) : new Date(removedThread!.date).getTime()
          const insertAt = arr.findIndex(m => {
            const t = m.internalDate ? Number(m.internalDate) : new Date(m.date).getTime()
            return t < removedTime
          })
          arr.splice(insertAt >= 0 ? insertAt : (originalIndex >= 0 ? originalIndex : arr.length), 0, removedThread!)
          return arr
        })
        recentlyRemovedThreadsRef.current.delete(threadId)
        return
      }
      setMessages(prev => prev.map(m => {
        if (m.threadId !== threadId) return m
        const labelIds = starred
          ? (m.labelIds || []).filter(l => l !== 'STARRED')
          : Array.from(new Set([...(m.labelIds || []), 'STARRED']))
        return { ...m, labelIds }
      }))
      setThread(prev => prev && prev.id === threadId ? {
        ...prev,
        messages: prev.messages.map(m => ({
          ...m,
          labelIds: starred
            ? (m.labelIds || []).filter(l => l !== 'STARRED')
            : Array.from(new Set([...(m.labelIds || []), 'STARRED']))
        }))
      } : prev)
    })
  }, [])

  const handleSelectThread = useCallback((threadId: string, index: number) => {
    if (threadId === selectedThreadIdRef.current) return
    const prevThreadId = selectedThreadIdRef.current
    if (prevThreadId && replyDraftRef.current.trim()) {
      pendingReplyDraftsRef.current.set(prevThreadId, replyDraftRef.current)
      if (pendingReplyDraftsRef.current.size > 100) {
        pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!)
      }
    }
    setReplyDraft('')
    pendingArchiveRef.current = false
    collapsedIdsRef.current.clear()
    selectedThreadIdRef.current = threadId
    setSelectedThreadId(threadId)
    setFocusedThreadId(threadId)
    threadScrolledUpRef.current = false
    prevThreadMsgCountRef.current = 0
    setNewThreadReplies(0)
    sendingReplyRef.current = false
    setSendingReply(false)
    setActionError(null)
    setSendError(null)
    setReplyError(null)
    if (replyTextareaRef.current) replyTextareaRef.current.style.height = ''
    const prevMsg = messagesRef.current.find(m => m.threadId === threadId)
    prevThreadIsUnreadRef.current = prevMsg?.isUnread ?? false
    setMessages(prev => prev.map(m => m.threadId === threadId ? { ...m, isUnread: false } : m))
    recentlyReadThreadIdsRef.current.add(threadId)
    recentlyReadTimestampsRef.current.set(threadId, Date.now())
    if (prevMsg?.isUnread && !optimisticallyDecrementedRef.current.has(threadId)) {
      const hasInbox = (prevMsg.labelIds || []).includes('INBOX') || !!prevMsg.hasInboxMessage
      if (hasInbox) {
        optimisticallyDecrementedRef.current.add(threadId)
        setInboxUnreadCount(prev => Math.max(0, prev - 1))
      }
    }
    loadThread(threadId)
  }, [loadThread])

  const handleArchive = useCallback(async () => {
    if (!thread || archivingRef.current) return
    if (pendingSendRef.current?.threadId === thread.id) { setActionError('Send pending — click Undo first or wait'); return }
    archivingRef.current = true
    setActionError(null)
    const wasSearchMode = isSearchMode
    const prevLabels = messagesRef.current.find(m => m.threadId === thread.id)?.labelIds
    try {
      await window.electronAPI.gmailArchiveThread(thread.id)
      if (!mountedRef.current) return
      const archivedMsg = messagesRef.current.find(m => m.threadId === thread.id)
      const shouldRemoveFromList = wasSearchMode || selectedFolderRef.current === 'INBOX'
      if (shouldRemoveFromList) {
        setMessages(prev => prev.filter(m => m.threadId !== thread.id))
        recentlyRemovedThreadsRef.current.set(thread.id, Date.now())
      } else {
        setMessages(prev => prev.map(m => m.threadId === thread.id ? { ...m, labelIds: (m.labelIds || []).filter(l => l !== 'INBOX'), hasInboxMessage: false } : m))
        setThread(prev => prev && prev.id === thread.id ? { ...prev, messages: prev.messages.map(m => ({ ...m, labelIds: (m.labelIds || []).filter(l => l !== 'INBOX') })) } : prev)
      }
      if (archivedMsg?.isUnread && !recentlyReadThreadIdsRef.current.has(thread.id) && !optimisticallyDecrementedRef.current.has(thread.id) && thread.messages.some(m => (m.labelIds || []).includes('INBOX'))) {
        recentlyReadThreadIdsRef.current.add(thread.id)
        optimisticallyDecrementedRef.current.add(thread.id)
        setInboxUnreadCount(prev => Math.max(0, prev - 1))
      }
      if (selectedThreadIdRef.current === thread.id) {
        if (replyDraftRef.current.trim() && thread.id) {
          pendingReplyDraftsRef.current.set(thread.id, replyDraftRef.current)
          if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
        }
        selectedThreadIdRef.current = null
        setSelectedThreadId(null)
        setThread(null)
        if (shouldRemoveFromList) {
          const remaining = messagesRef.current.filter(m => m.threadId !== thread.id)
          if (remaining.length > 0) {
            const archivedIdx = messagesRef.current.findIndex(m => m.threadId === thread.id)
            const newIdx = Math.max(0, Math.min(archivedIdx, remaining.length - 1))
            handleSelectThread(remaining[newIdx].threadId, newIdx)
          } else {
            setFocusedThreadId(null)
          }
        } else {
          setFocusedThreadId(null)
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        setActionError(err instanceof Error ? err.message : 'Failed to archive')
        if (prevLabels !== undefined) setMessages(msgs => msgs.map(m => m.threadId === thread.id ? { ...m, labelIds: prevLabels } : m))
      }
    } finally {
      archivingRef.current = false
    }
  }, [thread, isSearchMode, handleSelectThread])

  // Auto-resize reply textarea when a pending draft is restored after thread loads
  useEffect(() => {
    if (loadingThread || !replyDraft) return
    const el = replyTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [replyDraft, loadingThread])

  // Fire pending archive once thread finishes loading (user pressed 'e' before thread resolved)
  useEffect(() => {
    if (!loadingThread && thread && pendingArchiveRef.current) {
      pendingArchiveRef.current = false
      const hasInbox = thread.messages.some(m => (m.labelIds||[]).includes('INBOX'))
      const hasDraftOrTrash = thread.messages.some(m => (m.labelIds||[]).includes('DRAFT')) || thread.messages.some(m => (m.labelIds||[]).includes('TRASH'))
      if (selectedFolder !== 'ARCHIVE' && selectedFolder !== 'TRASH' && selectedFolder !== 'DRAFT' && hasInbox && !(isSearchMode && hasDraftOrTrash)) {
        handleArchive()
      }
    }
  }, [loadingThread, thread, handleArchive, selectedFolder, isSearchMode])

  const handleTrash = useCallback(async () => {
    if (!thread || trashingRef.current) return
    if (pendingSendRef.current?.threadId === thread.id) { setActionError('Send pending — click Undo first or wait'); return }
    pendingArchiveRef.current = false
    trashingRef.current = true
    setActionError(null)
    try {
      await window.electronAPI.gmailTrashThread(thread.id)
      if (!mountedRef.current) return
      const trashedMsg = messagesRef.current.find(m => m.threadId === thread.id)
      setMessages(prev => prev.filter(m => m.threadId !== thread.id))
      recentlyRemovedThreadsRef.current.set(thread.id, Date.now())
      if (trashedMsg?.isUnread && !recentlyReadThreadIdsRef.current.has(thread.id) && !optimisticallyDecrementedRef.current.has(thread.id) && thread.messages.some(m => (m.labelIds || []).includes('INBOX'))) {
        recentlyReadThreadIdsRef.current.add(thread.id)
        optimisticallyDecrementedRef.current.add(thread.id)
        setInboxUnreadCount(prev => Math.max(0, prev - 1))
      }
      if (selectedThreadIdRef.current === thread.id) {
        if (replyDraftRef.current.trim() && thread.id) {
          pendingReplyDraftsRef.current.set(thread.id, replyDraftRef.current)
          if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
        }
        selectedThreadIdRef.current = null
        setSelectedThreadId(null)
        setThread(null)
        const remaining = messagesRef.current.filter(m => m.threadId !== thread.id)
        if (remaining.length > 0) {
          const trashedIdx = messagesRef.current.findIndex(m => m.threadId === thread.id)
          const newIdx = Math.max(0, Math.min(trashedIdx, remaining.length - 1))
          handleSelectThread(remaining[newIdx].threadId, newIdx)
        } else {
          setFocusedThreadId(null)
        }
      }
    } catch (err) {
      if (mountedRef.current) setActionError(err instanceof Error ? err.message : 'Failed to trash')
    } finally {
      trashingRef.current = false
    }
  }, [thread, handleSelectThread])

  const handleMoveToInbox = useCallback(async () => {
    if (!thread || movingToInboxRef.current) return
    if (pendingSendRef.current?.threadId === thread.id) { setActionError('Send pending — click Undo first or wait'); return }
    pendingArchiveRef.current = false
    movingToInboxRef.current = true
    setActionError(null)
    try {
      await window.electronAPI.gmailMoveThreadToInbox(thread.id)
      if (!mountedRef.current) return
      const movedMsg = messagesRef.current.find(m => m.threadId === thread.id)
      if (movedMsg?.isUnread && optimisticallyDecrementedRef.current.has(thread.id)) {
        optimisticallyDecrementedRef.current.delete(thread.id)
        recentlyReadThreadIdsRef.current.delete(thread.id)
        setInboxUnreadCount(prev => prev + 1)
      }
      setMessages(prev => prev.filter(m => m.threadId !== thread.id))
      if (selectedThreadIdRef.current === thread.id) {
        if (replyDraftRef.current.trim() && thread.id) {
          pendingReplyDraftsRef.current.set(thread.id, replyDraftRef.current)
          if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
        }
        selectedThreadIdRef.current = null
        setSelectedThreadId(null)
        setThread(null)
        const remaining = messagesRef.current.filter(m => m.threadId !== thread.id)
        if (remaining.length > 0) {
          const curIdx = messagesRef.current.findIndex(m => m.threadId === thread.id)
          const newIdx = Math.max(0, Math.min(curIdx, remaining.length - 1))
          handleSelectThread(remaining[newIdx].threadId, newIdx)
        } else {
          setFocusedThreadId(null)
        }
      }
    } catch (err) {
      if (mountedRef.current) setActionError(err instanceof Error ? err.message : 'Failed to move to inbox')
    } finally {
      movingToInboxRef.current = false
    }
  }, [thread, handleSelectThread])

  const handleUntrash = useCallback(async () => {
    if (!thread || untrashingRef.current) return
    if (pendingSendRef.current?.threadId === thread.id) { setActionError('Send pending — click Undo first or wait'); return }
    pendingArchiveRef.current = false
    untrashingRef.current = true
    setActionError(null)
    try {
      await window.electronAPI.gmailUntrashThread(thread.id)
      if (!mountedRef.current) return
      const trashedMsg = messagesRef.current.find(m => m.threadId === thread.id)
      if (trashedMsg?.isUnread && optimisticallyDecrementedRef.current.has(thread.id)) {
        optimisticallyDecrementedRef.current.delete(thread.id)
        recentlyReadThreadIdsRef.current.delete(thread.id)
        setInboxUnreadCount(prev => prev + 1)
      }
      setMessages(prev => prev.filter(m => m.threadId !== thread.id))
      if (selectedThreadIdRef.current === thread.id) {
        if (replyDraftRef.current.trim() && thread.id) {
          pendingReplyDraftsRef.current.set(thread.id, replyDraftRef.current)
          if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
        }
        selectedThreadIdRef.current = null
        setSelectedThreadId(null)
        setThread(null)
        const remaining = messagesRef.current.filter(m => m.threadId !== thread.id)
        if (remaining.length > 0) {
          const curIdx = messagesRef.current.findIndex(m => m.threadId === thread.id)
          const newIdx = Math.max(0, Math.min(curIdx, remaining.length - 1))
          handleSelectThread(remaining[newIdx].threadId, newIdx)
        } else {
          setFocusedThreadId(null)
        }
      }
    } catch (err) {
      if (mountedRef.current) setActionError(err instanceof Error ? err.message : 'Failed to restore from trash')
    } finally {
      untrashingRef.current = false
    }
  }, [thread, handleSelectThread])

  // Open compose drawer pre-filled with the draft's current content.
  // On send, the compose flow trashes the original draft so we don't have duplicates.
  const handleEditDraft = useCallback(() => {
    if (!thread || !thread.messages.length) return
    const msg = [...thread.messages].reverse().find(m => !m.id.startsWith('optimistic-') && m.labelIds?.includes('DRAFT'))
         ?? [...thread.messages].reverse().find(m => !m.id.startsWith('optimistic-'))
    if (!msg) return
    const originalBody = msg.body || ''
    const isHtml = /<[a-zA-Z][^>]*>/.test(originalBody)
    // Strip HTML for textarea editing — users can reformat in compose
    const intermediate = originalBody
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<t[dh][^>]*>/gi, '  ')
      .replace(/<\/(tr|td|th)[^>]*>/gi, '\n')
      .replace(/<(p|div)[^>]*>/gi, '\n')
      .replace(/<\/(p|div|br)[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a\s[^>]*href=(?:["']([^"']+)["']|([^\s>"']+))[^>]*>([\s\S]*?)<\/a>/gi, (_, quotedHref, unquotedHref, inner) => {
        const href = quotedHref || unquotedHref
        const text = inner.replace(/<[^>]+>/g, '').trim()
        return text ? `${text} (${href})` : href
      })
    const plain = isHtml
      ? decodeHtmlEntities(
          new DOMParser().parseFromString(intermediate, 'text/html').body.textContent ?? ''
        ).replace(/\n{3,}/g, '\n\n').trim()
      : originalBody
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
          .replace(/\n{3,}/g, '\n\n').trim()
    setDraftBeingEdited({
      threadId: thread.id,
      messageId: msg.id,
      to: msg.to || '',
      cc: msg.cc || '',
      bcc: msg.bcc || '',
      subject: msg.subject || '',
      body: plain,
      htmlWarning: isHtml || undefined,
      messageIdHeader: msg.messageIdHeader,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
    })
    setSendError(null)
    setComposeResumeInitial(null)
    setComposing(true)
  }, [thread])

  // Schedule a pending send with 5s undo window. If another send is already
  // pending, flush it immediately and start a fresh 5s countdown for the new one.
  const schedulePendingSend = useCallback((opts: { label: string; threadId: string; execute: () => void; undo: () => void }) => {
    setSendError(null)
    const existing = pendingSendRef.current
    if (existing) {
      if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current)
      existing.execute()
      setPendingSend(null)
      if (existing.threadId !== opts.threadId) {
        if (flushNoticeTimerRef.current) clearTimeout(flushNoticeTimerRef.current)
        setFlushNotice('Previous send delivered')
        flushNoticeTimerRef.current = setTimeout(() => setFlushNotice(null), 3000)
      }
    }
    let fired = false
    const safeExecute = () => { if (fired) return; fired = true; opts.execute() }
    const expiresAt = Date.now() + 5000
    const timer = setTimeout(() => {
      const p = pendingSendRef.current
      if (!p) return
      p.execute()
      if (mountedRef.current) setPendingSend(null)
      pendingSendTimerRef.current = null
    }, 5000)
    pendingSendTimerRef.current = timer
    setPendingSend({ label: opts.label, threadId: opts.threadId, expiresAt, execute: safeExecute, undo: opts.undo })
  }, [])

  const cancelPendingSend = useCallback(() => {
    const p = pendingSendRef.current
    if (!p) return
    if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current)
    pendingSendTimerRef.current = null
    p.undo()
    setPendingSend(null)
  }, [])

  // The 5-second timer (schedulePendingSend) handles the send after the undo window.
  // Do NOT force-execute on unmount — that collapses the undo window when the user switches tabs.

  const sendReply = useCallback((replyAll: boolean) => {
    if (pendingSendRef.current?.threadId === thread?.id) {
      setReplyError('Undo pending — click Undo first or wait'); return
    }
    if (!thread || !replyDraft.trim()) return
    if (sendingReplyRef.current && sendingReplyForThreadRef.current === thread.id) return
    if (!selfRef.current) { setReplyError('Still loading your profile — try again'); return }
    sendingReplyRef.current = true
    sendingReplyForThreadRef.current = thread.id
    const realMessages = thread.messages.filter(m => !m.id.startsWith('optimistic-'))
    if (realMessages.length === 0) { sendingReplyRef.current = false; setReplyError('Still sending previous reply — please wait a moment'); return }
    const lastMsg = realMessages[realMessages.length - 1]
    const sentBody = replyDraft.trim()
    const originalIsHtml = /<[a-zA-Z][^>]*>/.test(lastMsg.body ?? '')
    const fullBody = (() => {
      const d = lastMsg.internalDate ? new Date(Number(lastMsg.internalDate)) : lastMsg.date ? new Date(lastMsg.date) : new Date()
      const dateStr = d.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      if (originalIsHtml) {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const strippedBody = (lastMsg.body ?? '').replace(/^\s*<html[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*?<\/html>\s*$/i, '')
        return `<html><body><div style="white-space:pre-wrap;word-break:break-word">${esc(sentBody).replace(/\n/g, '<br>')}</div><br><p style="margin:0 0 .5em;color:#666">On ${esc(dateStr)}, ${esc(lastMsg.from)} wrote:</p><blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${strippedBody}</blockquote></body></html>`
      }
      const rawSrc = lastMsg.body || lastMsg.snippet || ''
      let snippet: string
      if (!/<[a-zA-Z][^>]*>/.test(rawSrc)) {
        snippet = rawSrc.replace(/\n{3,}/g, '\n\n').trim()
      } else {
        const raw = rawSrc
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<\/td>/gi, '\t')
          .replace(/<\/tr>/gi, '\n')
          .replace(/<\/(p|div)[^>]*>/gi, '\n')
          .replace(/<br\s*\/?>/gi, '\n')
        snippet = (new DOMParser().parseFromString(raw, 'text/html').body.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
      }
      if (snippet.length > 4000) snippet = snippet.slice(0, 4000) + '\n[...]'
      const quoted = snippet.split('\n').map(l => '> ' + l).join('\n')
      return sentBody + `\n\nOn ${dateStr}, ${lastMsg.from} wrote:\n${quoted}`
    })()
    const threadId = thread.id
    const messageId = lastMsg.id
    const fromEmailCheck = selfRef.current?.email ? (lastMsg.from.toLowerCase().includes('<' + selfRef.current.email.toLowerCase() + '>') || lastMsg.from.toLowerCase().replace(/.*<|>/g, '').trim() === selfRef.current.email.toLowerCase()) : false
    const isSelf = selfRef.current?.email ? (fromEmailCheck || (lastMsg.labelIds || []).includes('SENT')) : (lastMsg.labelIds || []).includes('SENT')
    let targetTo = isSelf ? lastMsg.to : (lastMsg.replyTo || lastMsg.from)
    if (!isSelf && !targetTo?.trim()) { sendingReplyRef.current = false; setReplyError('Cannot reply: no sender address found'); return }
    let targetCc: string | undefined
    const extractEmail = (addr: string) => {
      const m = addr.match(/<([^>]+)>/)
      return m ? m[1].toLowerCase() : addr.toLowerCase().trim()
    }
    if (isSelf) {
      const selfEmail = selfRef.current?.email?.toLowerCase()
      if (!selfEmail) { sendingReplyRef.current = false; setReplyError('Profile not loaded — try again'); return }
      const toAddrs = splitAddressList(lastMsg.to).filter(a => extractEmail(a) !== selfEmail)
      const ccAddrs = lastMsg.cc ? splitAddressList(lastMsg.cc).filter(a => extractEmail(a) !== selfEmail) : []
      if (toAddrs.length === 0 && ccAddrs.length === 0) {
        sendingReplyRef.current = false
        setReplyError('No other recipients — this thread only includes you')
        return
      }
      if (replyAll) {
        if (toAddrs.length === 0 && ccAddrs.length > 0) {
          targetTo = ccAddrs[0]
          targetCc = ccAddrs.length > 1 ? ccAddrs.slice(1).join(', ') : undefined
        } else {
          targetTo = toAddrs.join(', ')
          targetCc = ccAddrs.length ? ccAddrs.join(', ') : undefined
        }
      } else {
        targetTo = toAddrs[0] || ccAddrs[0] || ''
        if (!targetTo) { sendingReplyRef.current = false; setReplyError('No other recipients — this thread only includes you'); return }
        targetCc = undefined
      }
    } else if (!isSelf && replyAll) {
      const selfEmail = selfRef.current?.email?.toLowerCase()
      if (!selfEmail) { sendingReplyRef.current = false; setReplyError('Profile not loaded — try again in a moment'); return }
      const primaryEmail = extractEmail(targetTo)
      const toAddrs = lastMsg.to ? splitAddressList(lastMsg.to).filter(a => { const e = extractEmail(a); return e !== selfEmail && e !== primaryEmail }) : []
      const ccAddrs = lastMsg.cc ? splitAddressList(lastMsg.cc).filter(a => { const e = extractEmail(a); return e !== selfEmail && e !== primaryEmail }) : []
      if (toAddrs.length > 0) targetTo = [targetTo, ...toAddrs].join(', ')
      if (ccAddrs.length > 0) targetCc = ccAddrs.join(', ')
    }
    const subject = thread.messages[0]?.subject ?? lastMsg.subject
    const replySubject = subject ? (!subject.toLowerCase().startsWith('re:') ? 'Re: ' + subject : subject) : ''
    const replyTextareaEl = replyTextareaRef.current
    setReplyDraft('')
    if (replyTextareaEl) replyTextareaEl.style.height = ''
    setReplyError(null)

    // Walk newest→oldest to find a valid Message-ID for threading headers
    const threadingMsgId = (() => {
      for (let i = realMessages.length - 1; i >= 0; i--) {
        if (realMessages[i].messageIdHeader) return realMessages[i].messageIdHeader
      }
      return `<thread-${threadId}@mail.gmail.com>`
    })()

    // Build RFC 2822-compliant References: collect all Message-IDs oldest→newest, with threadingMsgId last
    const threadingReferences = (() => {
      const ids = Array.from(new Set(realMessages.map(m => m.messageIdHeader).filter(Boolean) as string[]))
      if (ids[ids.length - 1] !== threadingMsgId) ids.push(threadingMsgId)
      const joined = ids.join(' ')
      if (joined.length > 900) {
        // RFC 2822: keep first ID + as many trailing IDs as fit within limit
        const first = ids[0]
        const trailing: string[] = []
        let len = first.length
        for (let i = ids.length - 1; i > 0; i--) {
          if (len + 1 + ids[i].length > 900) break
          trailing.unshift(ids[i])
          len += 1 + ids[i].length
        }
        return [first, ...trailing].join(' ') || undefined
      }
      return joined || undefined
    })()

    schedulePendingSend({
      label: 'Reply sent',
      threadId,
      execute: () => {
        sendingReplyRef.current = true
        sendingReplyForThreadRef.current = threadId
        if (mountedRef.current && selectedThreadIdRef.current === threadId) setSendingReply(true)
        window.electronAPI.gmailReply(messageId, fullBody, {
            inReplyTo: /^<thread-[^@]+@mail\.gmail\.com>$/.test(threadingMsgId) ? undefined : threadingMsgId,
            references: /^<thread-[^@]+@mail\.gmail\.com>$/.test(threadingMsgId) ? undefined : threadingReferences,
            from: selfRef.current!.email,
            to: targetTo,
            cc: targetCc,
            subject: replySubject,
            threadId: lastMsg.threadId,
          })
          .then(() => {
            sendingReplyRef.current = false
            sendingReplyForThreadRef.current = null
            if (!mountedRef.current) return
            if (selectedThreadIdRef.current === threadId) {
              setSendingReply(false)
              setReplyError(null)
              const selfProfile = selfRef.current
              const optimisticReply: GmailMessage = {
                id: `optimistic-${++_optimisticSeq}`,
                threadId: threadId,
                snippet: sentBody.slice(0, 100),
                from: selfProfile ? `${selfProfile.displayName} <${selfProfile.email}>` : 'You',
                to: targetTo,
                cc: targetCc,
                subject: replySubject,
                date: new Date().toISOString(),
                internalDate: String(Date.now()),
                labelIds: ['SENT'],
                isUnread: false,
                body: originalIsHtml ? fullBody : (() => {
                  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  const lines = fullBody.split('\n')
                  const parts: string[] = []
                  let i = 0
                  while (i < lines.length) {
                    if (lines[i].startsWith('> ') || lines[i] === '>') {
                      const block: string[] = []
                      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
                        block.push(esc(lines[i].startsWith('> ') ? lines[i].slice(2) : ''))
                        i++
                      }
                      parts.push('<blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">' + block.join('\n') + '</blockquote>')
                    } else {
                      parts.push(esc(lines[i]))
                      i++
                    }
                  }
                  return '<html><body><div style="white-space:pre-wrap;word-break:break-word">' + parts.join('\n') + '</div></body></html>'
                })(),
                attachments: [],
                messageIdHeader: '',
              }
              setThread(prev => prev ? { ...prev, messages: [...prev.messages, optimisticReply] } : prev)
              threadScrolledUpRef.current = false
              loadThread(threadId, true).catch(() => {})
            }
            loadMessages(submittedSearchQueryRef.current || undefined, undefined, true)
          })
          .catch(err => {
            sendingReplyRef.current = false
            sendingReplyForThreadRef.current = null
            if (mountedRef.current && selectedThreadIdRef.current === threadId) {
              setSendingReply(false)
              setReplyError(err instanceof Error ? err.message : 'Failed to send reply')
              setReplyDraft(sentBody)
            } else {
              pendingReplyDraftsRef.current.set(threadId, sentBody)
              if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
            }
          })
      },
      undo: () => {
        sendingReplyRef.current = false
        sendingReplyForThreadRef.current = null
        if (selectedThreadIdRef.current === threadId) {
          if (!replyDraftRef.current.trim()) {
            setReplyDraft(sentBody)
            requestAnimationFrame(() => {
              const el = replyTextareaRef.current
              if (el) {
                el.style.height = 'auto'
                el.style.height = el.scrollHeight + 'px'
              }
            })
          }
        } else {
          pendingReplyDraftsRef.current.set(threadId, sentBody)
          if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
        }
      },
    })
  }, [thread, replyDraft, schedulePendingSend, loadThread, loadMessages])
  const handleReply = useCallback(() => sendReply(false), [sendReply])
  const handleReplyAll = useCallback(() => sendReply(true), [sendReply])

  const handleComposeSend = useCallback(async (opts: { to: string; cc?: string; bcc?: string; subject: string; body: string }) => {
    const draftCtx = draftBeingEdited
    // Drawer closes on its own via handleClose() after onSend resolves

    // Pre-compute threading headers for draft-edit replies.
    // If inReplyTo is synthetic, fetch the thread to find the real Message-ID so
    // non-Gmail clients can reconstruct the conversation via RFC 2822 headers.
    let draftInReplyTo: string | undefined = draftCtx?.inReplyTo || undefined
    let draftReferences: string | undefined = (() => {
      if (!draftCtx) return undefined
      const refTokens = (draftCtx.references ?? '').trim().split(/\s+/).filter(Boolean)
      const irt = draftCtx.inReplyTo
      if (!irt) return draftCtx.references?.trim() || undefined
      if (refTokens.length > 0 && refTokens[refTokens.length - 1] === irt) return draftCtx.references ?? irt
      return (draftCtx.references?.trim() ? `${draftCtx.references} ${irt}` : irt) || undefined
    })()
    const sendBody = (draftCtx?.htmlWarning && !opts.body.trimStart().startsWith('<'))
      ? `<html><body><div style="white-space:pre-wrap">${opts.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div></body></html>`
      : opts.body
    const wasComposing = composing
    schedulePendingSend({
      label: 'Message sent',
      threadId: draftCtx?.threadId ?? `__fresh-${++_freshComposeSeq}`,
      execute: async () => {
        // Resolve RFC 2822 threading headers inside execute() so the modal closes immediately
        // while the undo window runs. Only needed when inReplyTo is a synthetic Gmail thread ID.
        let resolvedInReplyTo = draftInReplyTo
        let resolvedReferences = draftReferences
        if (draftCtx && resolvedInReplyTo && /^<thread-[^@]+@mail\.gmail\.com>$/.test(resolvedInReplyTo)) {
          try {
            const t = await window.electronAPI.gmailGetThread(draftCtx.threadId)
            const realMsgs = t.messages.filter((m: GmailMessage) => !m.id.startsWith('optimistic-'))
            let realMsgId: string | undefined
            for (let i = realMsgs.length - 1; i >= 0; i--) {
              const mid = realMsgs[i].messageIdHeader
              if (mid && !/^<thread-[^@]+@mail\.gmail\.com>$/.test(mid)) { realMsgId = mid; break }
            }
            if (realMsgId) {
              resolvedInReplyTo = realMsgId
              const ids = Array.from(new Set(realMsgs.map((m: GmailMessage) => m.messageIdHeader).filter((id: string) => id && !/^<thread-[^@]+@mail\.gmail\.com>$/.test(id))))
              if (ids[ids.length - 1] !== realMsgId) ids.push(realMsgId)
              resolvedReferences = ids.join(' ') || undefined
            } else {
              resolvedInReplyTo = undefined
              resolvedReferences = draftCtx.references?.split(' ').filter(id => !/^<thread-[^@]+@mail\.gmail\.com>$/.test(id)).join(' ') || undefined
            }
          } catch (e) {
            console.warn('[email] thread fetch failed for RFC 2822 headers, trying local cache:', e)
            const localMsgs = (threadRef.current?.id === draftCtx.threadId ? threadRef.current.messages : [])
              .filter((m: GmailMessage) => !m.id.startsWith('optimistic-'))
            let localMsgId: string | undefined
            for (let i = localMsgs.length - 1; i >= 0; i--) {
              const mid = localMsgs[i].messageIdHeader
              if (mid && !/^<thread-[^@]+@mail\.gmail\.com>$/.test(mid)) { localMsgId = mid; break }
            }
            if (localMsgId) {
              resolvedInReplyTo = localMsgId
              const ids = Array.from(new Set(localMsgs.map((m: GmailMessage) => m.messageIdHeader).filter((id: string) => id && !/^<thread-[^@]+@mail\.gmail\.com>$/.test(id))))
              if (ids[ids.length - 1] !== localMsgId) ids.push(localMsgId)
              resolvedReferences = ids.join(' ') || undefined
            } else {
              resolvedInReplyTo = undefined
              resolvedReferences = draftCtx.references?.split(' ').filter((id: string) => !/^<thread-[^@]+@mail\.gmail\.com>$/.test(id)).join(' ') || undefined
            }
            if (!resolvedInReplyTo && draftCtx.messageIdHeader && !/^<thread-[^@]+@mail\.gmail\.com>$/.test(draftCtx.messageIdHeader)) {
              resolvedInReplyTo = draftCtx.messageIdHeader
              resolvedReferences = draftCtx.messageIdHeader
            }
          }
        }
        window.electronAPI.gmailSend(
          draftCtx
            ? { ...opts, body: sendBody, threadId: draftCtx.threadId, inReplyTo: resolvedInReplyTo, references: resolvedReferences }
            : opts
        )
          .then(() => {
            if (draftCtx) {
              window.electronAPI.gmailTrash(draftCtx.messageId)
                .catch(e => {
                  console.warn('[email] draft trash failed:', e)
                  if (mountedRef.current) setActionError('Draft sent but could not be removed — it may reappear briefly.')
                })
            }
            if (!mountedRef.current) return
            if (draftCtx) {
              const hasInboxMsg = messagesRef.current.find(m => m.threadId === draftCtx.threadId && m.hasInboxMessage)
              if (!hasInboxMsg) {
                setMessages(prev => prev.filter(m => m.threadId !== draftCtx.threadId))
                recentlyRemovedThreadsRef.current.set(draftCtx.threadId, Date.now())
              }
              if (selectedThreadIdRef.current === draftCtx.threadId) {
                if (hasInboxMsg) {
                  loadThread(draftCtx.threadId).catch(() => {})
                } else {
                  selectedThreadIdRef.current = null
                  setSelectedThreadId(null)
                  setThread(null)
                }
              }
            }
            loadMessages(submittedSearchQueryRef.current || undefined, undefined, true)
          })
          .catch(err => {
            console.error('[email] compose send failed:', err)
            if (mountedRef.current) {
              setSendError(err instanceof Error ? err.message : 'Failed to send message')
              if (draftCtx) setDraftBeingEdited(draftCtx)
              setComposeResumeInitial({ to: opts.to, cc: opts.cc ?? '', bcc: opts.bcc ?? '', subject: opts.subject, body: opts.body })
              if (wasComposing) setComposing(true)
            }
          })
      },
      undo: () => {
        // Reopen the drawer with exact content restored
        if (draftCtx) setDraftBeingEdited(draftCtx)
        setComposeResumeInitial({ to: opts.to, cc: opts.cc ?? '', bcc: opts.bcc ?? '', subject: opts.subject, body: opts.body })
        setComposing(true)
      },
    })
    setDraftBeingEdited(null)
  }, [draftBeingEdited, composing, schedulePendingSend, loadMessages, loadThread])

  // ── Keyboard navigation ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      const isMeta = e.metaKey || e.ctrlKey

      if (isInput && e.key === 'Escape') return

      if (e.key === 'Escape') {
        if (composing) {
          // ComposeModal handles Escape with its own exit animation — don't bypass it
          return
        }
        if (selectedThreadId) {
          if (replyDraftRef.current.trim()) {
            pendingReplyDraftsRef.current.set(selectedThreadId, replyDraftRef.current)
            if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
          }
          selectedThreadIdRef.current = null
          setSelectedThreadId(null)
          setThread(null)
          return
        }
        return
      }

      // Skip hotkeys when typing or when compose is open
      if (isInput) return
      if (composing) return

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault()
          const msgs = messagesRef.current
          const curIdx = focusedThreadIdRef.current ? msgs.findIndex(m => m.threadId === focusedThreadIdRef.current) : -1
          const nextIdx = Math.min(curIdx + 1, msgs.length - 1)
          const nextMsg = msgs[nextIdx]
          if (nextMsg) {
            setFocusedThreadId(nextMsg.threadId)
            const rows = listRef.current?.querySelectorAll('[role="option"]')
            rows?.[nextIdx]?.scrollIntoView({ block: 'nearest' })
          }
          break
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault()
          const msgs = messagesRef.current
          const curIdx = focusedThreadIdRef.current ? msgs.findIndex(m => m.threadId === focusedThreadIdRef.current) : msgs.length
          const prevIdx = Math.max(curIdx - 1, 0)
          const prevMsg = msgs[prevIdx]
          if (prevMsg) {
            setFocusedThreadId(prevMsg.threadId)
            const rows = listRef.current?.querySelectorAll('[role="option"]')
            rows?.[prevIdx]?.scrollIntoView({ block: 'nearest' })
          }
          break
        }
        case 'Enter': {
          e.preventDefault()
          const focusedMsg = focusedThreadIdRef.current ? messagesRef.current.find(m => m.threadId === focusedThreadIdRef.current) : undefined
          if (focusedMsg) handleSelectThread(focusedMsg.threadId, messagesRef.current.indexOf(focusedMsg))
          break
        }
        case 'r': {
          if (selectedThreadId) {
            e.preventDefault()
            replyTextareaRef.current?.focus()
          }
          break
        }
        case 'c': {
          e.preventDefault()
          setSendError(null)
          setComposeResumeInitial(null)
          setComposing(true)
          break
        }
        case 'e': {
          if (selectedThreadId && !!thread && selectedFolder !== 'ARCHIVE' && selectedFolder !== 'TRASH' && selectedFolder !== 'DRAFT' && selectedFolder !== 'SENT' && !!thread.messages.some(m => (m.labelIds||[]).includes('INBOX')) && !(isSearchMode && (thread.messages.some(m => (m.labelIds||[]).includes('DRAFT')) || thread.messages.some(m => (m.labelIds||[]).includes('TRASH'))))) {
            e.preventDefault()
            handleArchive()
          } else if (selectedThreadId && loadingThread && selectedFolder !== 'ARCHIVE' && selectedFolder !== 'TRASH' && selectedFolder !== 'DRAFT' && selectedFolder !== 'SENT') {
            e.preventDefault()
            pendingArchiveRef.current = true
          }
          break
        }
        case '#': {
          if (selectedThreadId && selectedFolder !== 'TRASH' && !(isSearchMode && (thread?.messages.some(m => (m.labelIds||[]).includes('DRAFT')) || thread?.messages.some(m => (m.labelIds||[]).includes('TRASH'))))) {
            e.preventDefault()
            handleTrash()
          }
          break
        }
        case '/': {
          e.preventDefault()
          searchInputRef.current?.focus()
          break
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [messages, selectedThreadId, selectedFolder, composing, handleArchive, handleTrash, handleSelectThread, isSearchMode, thread])

  // ── Derived ──────────────────────────────────────────────────────────────

  const threadSubject = useMemo(() => {
    if (!thread || !thread.messages.length) return ''
    return thread.messages[0].subject || '(no subject)'
  }, [thread])

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col h-full bg-surface-0 view-enter">
      {/* ── Top toolbar — frosted, search-centric ── */}
      <div className="shrink-0 flex items-center gap-2 px-6 py-3 bg-surface-0/80 backdrop-blur-xl border-b border-black/[0.04]">
        <form onSubmit={handleSearch} className="flex-1 flex items-center">
          <div className="relative w-full max-w-[520px]">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-3/60 pointer-events-none">
              <SearchIcon />
            </div>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value)
                if (e.target.value === '') {
                  submittedSearchQueryRef.current = ''
                  if (isSearchMode) {
                    setSendError(null)
                    setLoadWarning(null)
                    setNextPageToken(null)
                    setMessages([])
                    recentlyRemovedThreadsRef.current.clear()
                    recentlyReadThreadIdsRef.current.clear()
                    recentlyReadTimestampsRef.current.clear()
                    optimisticallyDecrementedRef.current.clear()
                    if (selectedThreadIdRef.current && replyDraftRef.current.trim()) {
                      pendingReplyDraftsRef.current.set(selectedThreadIdRef.current, replyDraftRef.current)
                      if (pendingReplyDraftsRef.current.size > 100) { pendingReplyDraftsRef.current.delete(pendingReplyDraftsRef.current.keys().next().value!) }
                    }
                    setReplyDraft('')
                    selectedThreadIdRef.current = null
                    setSelectedThreadId(null)
                    setThread(null)
                    setFocusedThreadId(null)
                    loadMessages(undefined)
                  }
                  setIsSearchMode(false)
                }
              }}
              placeholder="Search mail"
              className="w-full pl-10 pr-3 py-2 text-[12.5px] bg-black/[0.035] border border-transparent rounded-full focus:outline-none focus:bg-black/[0.05] focus:border-purple-1/25 focus:shadow-[0_0_0_4px_rgba(123,47,160,0.06)] text-text-1 placeholder-text-3/45 tracking-tight transition-all duration-150"
            />
          </div>
        </form>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Refresh"
          className="p-2 text-text-3 hover:text-text-1 hover:bg-black/[0.04] rounded-full transition-all duration-150 cursor-pointer disabled:cursor-not-allowed"
          title="Refresh"
        >
          <RefreshIcon spinning={refreshing} />
        </button>
      </div>

      {/* ── Main content ── */}
      <div className="flex-1 flex overflow-hidden">
        <FolderSidebar
          selected={selectedFolder}
          inboxUnread={inboxUnreadCount}
          labels={labels}
          onSelect={handleFolderChange}
          onCompose={() => { setSendError(null); setComposeResumeInitial(null); setComposing(true) }}
          syncError={labelSyncError}
        />
        {/* ── Left pane: Message list ── */}
        <div
          ref={listPaneRef}
          className="shrink-0 flex flex-col overflow-hidden"
          style={{ width: `${listWidth}px` }}
        >
          {/* Partial-load warning */}
          {loadWarning && (
            <div className="shrink-0 px-4 py-1.5 text-[10px] text-text-3 bg-surface-1 border-b border-black/[0.06] flex items-center gap-1.5">
              <span>{loadWarning}</span>
              <button onClick={() => setLoadWarning(null)} className="ml-auto text-text-3/60 hover:text-text-2 cursor-pointer">✕</button>
            </div>
          )}

          {/* Loading state */}
          {loading && !messages.length ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-8 h-8 rounded-xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center mx-auto mb-3">
                  <SpinnerIcon />
                </div>
                <span className="text-[10px] text-text-3/60">Loading inbox</span>
              </div>
            </div>
          ) : error && !messages.length ? (
            /* Error state */
            <div className="flex-1 flex items-center justify-center px-6">
              <div className="text-center">
                <div className="w-8 h-8 rounded-xl bg-red-2 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-3.5 h-3.5 text-red-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-[11px] font-medium text-text-2 mb-1">Failed to load</p>
                <p className="text-[10px] text-text-3 mb-3">{error}</p>
                <button
                  onClick={() => loadMessages()}
                  className="px-3 py-1.5 text-[10px] font-medium text-blue-1 hover:bg-blue-2 rounded-lg transition-colors cursor-pointer"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : messages.length === 0 ? (
            /* Empty state */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-12 h-12 rounded-2xl bg-surface-1 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-text-3/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-[13px] font-medium text-text-2">{submittedSearchQueryRef.current ? 'No results' : 'Inbox zero'}</p>
                <p className="text-[11px] text-text-3 mt-1">{submittedSearchQueryRef.current ? `No messages matching "${submittedSearchQueryRef.current}"` : "You're all caught up"}</p>
              </div>
            </div>
          ) : (
            /* Message list */
            <div ref={listRef} className="flex-1 overflow-y-auto scrollbar-hide" role="listbox" aria-label="Message list">
              {messages.map((msg, idx) => (
                <MessageRow
                  key={msg.threadId}
                  message={msg}
                  isSelected={msg.threadId === selectedThreadId}
                  isFocused={msg.threadId === focusedThreadId && msg.threadId !== selectedThreadId}
                  index={idx}
                  onSelect={handleSelectThread}
                  onStarToggle={handleStarToggle}
                  relativeDate={((msg.internalDate && Number(msg.internalDate) > 0) ? formatRelativeDate(new Date(Number(msg.internalDate)).toISOString()) : msg.date ? formatRelativeDate(msg.date) : '') || '—'}
                  isSentOrDraft={(!isSearchMode && (selectedFolder === 'SENT' || selectedFolder === 'DRAFT')) || (!isSearchMode && (selectedFolder === 'STARRED' || selectedFolder === 'ARCHIVE') && !msg.hasInboxMessage && (!!msg.hasSentMessage || !!msg.hasDraftMessage)) || (isSearchMode && !msg.hasInboxMessage && (!!msg.hasDraftMessage || !!msg.hasSentMessage))}
                />
              ))}
              {/* Infinite scroll sentinel */}
              {nextPageToken && (
                <>
                  <div ref={sentinelRef} />
                  {loadingMore && (
                    <div className="py-4 flex items-center justify-center">
                      <div className="flex items-center gap-2">
                        <SpinnerIcon />
                        <span className="text-[10px] text-text-3">Loading more</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Resize handle ── */}
        <div
          className="w-px shrink-0 cursor-col-resize bg-black/[0.05] hover:bg-purple-1/30 active:bg-purple-1/50 transition-colors duration-150"
          onMouseDown={handleResizeStart}
        />

        {/* ── Right pane: Thread detail ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {loadingThread ? (
            /* Loading thread */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-8 h-8 rounded-xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center mx-auto mb-3">
                  <SpinnerIcon />
                </div>
                <span className="text-[10px] text-text-3/60">Loading thread</span>
              </div>
            </div>
          ) : threadError ? (
            /* Thread error */
            <div className="flex-1 flex items-center justify-center px-6">
              <div className="text-center">
                <p className="text-[11px] font-medium text-red-1 mb-1">Error loading thread</p>
                <p className="text-[10px] text-text-3">{threadError}</p>
                <button onClick={() => selectedThreadId && loadThread(selectedThreadId, false)} className="px-3 py-1.5 text-[10px] font-medium text-blue-1 hover:bg-blue-2 rounded-lg transition-colors cursor-pointer mt-3">Retry</button>
              </div>
            </div>
          ) : thread ? (
            /* Thread view */
            <>
              {/* Thread header — generous padding, display-weight subject */}
              <div className="shrink-0 px-8 pt-6 pb-4 bg-surface-0/80 backdrop-blur-xl border-b border-black/[0.04] flex items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                  <h2 className="text-[20px] font-semibold text-text-1 leading-[1.25] tracking-tight">{threadSubject}</h2>
                  <p className="text-[11px] text-text-3 mt-1.5 tracking-tight">
                    {(() => { const count = thread.messages.filter(m => !m.id.startsWith('optimistic-')).length; return `${count} message${count !== 1 ? 's' : ''}`; })()}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Star */}
                  {(() => {
                    const threadStarred = thread.messages.some(m => (m.labelIds || []).includes('STARRED'))
                    return (
                      <StarButton
                        size="md"
                        starred={threadStarred}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleStarToggle(thread.id, !threadStarred)
                        }}
                      />
                    )
                  })()}
                  {(() => { const lastRealMsg = thread?.messages.filter(m => !m.id.startsWith('optimistic-')).at(-1); const hasDraftLast = !!(lastRealMsg?.labelIds?.includes('DRAFT')); return hasDraftLast || selectedFolder === 'DRAFT' || (isSearchMode && thread?.messages.some(m => (m.labelIds||[]).includes('DRAFT'))); })() && (
                    <button
                      onClick={handleEditDraft}
                      aria-label="Edit draft"
                      className="px-3.5 py-1.5 text-[11.5px] font-semibold text-white bg-gradient-to-b from-purple-1 to-purple-1/90 hover:shadow-[0_3px_10px_rgba(123,47,160,0.3)] active:scale-[0.98] rounded-full transition-all duration-150 cursor-pointer shadow-[0_1px_4px_rgba(123,47,160,0.2)]"
                      title="Edit draft"
                    >
                      Edit draft
                    </button>
                  )}
                  {(selectedFolder === 'ARCHIVE' || (selectedFolder === 'STARRED' && !thread?.messages.some(m => (m.labelIds||[]).includes('INBOX'))) || (isSearchMode && !thread?.messages.some(m => (m.labelIds||[]).includes('INBOX')) && !thread?.messages.some(m => (m.labelIds||[]).includes('TRASH') || (m.labelIds||[]).includes('DRAFT')))) && (
                    <button
                      onClick={handleMoveToInbox}
                      aria-label="Move to inbox"
                      className="px-3.5 py-1.5 text-[11.5px] font-medium text-text-2 hover:text-text-1 hover:bg-black/[0.04] rounded-full transition-all duration-150 cursor-pointer"
                      title="Move to Inbox"
                    >
                      Move to Inbox
                    </button>
                  )}
                  {selectedFolder === 'TRASH' && (
                    <button
                      onClick={handleUntrash}
                      aria-label="Restore from trash"
                      className="px-3.5 py-1.5 text-[11.5px] font-medium text-text-2 hover:text-text-1 hover:bg-black/[0.04] rounded-full transition-all duration-150 cursor-pointer"
                      title="Restore"
                    >
                      Restore
                    </button>
                  )}
                  {(isSearchMode ? (thread?.messages.some(m => (m.labelIds||[]).includes('INBOX')) && !thread?.messages.some(m => (m.labelIds || []).includes('TRASH')) && !thread?.messages.some(m => (m.labelIds || []).includes('DRAFT'))) : (selectedFolder !== 'TRASH' && selectedFolder !== 'DRAFT' && selectedFolder !== 'ARCHIVE' && thread?.messages.some(m => (m.labelIds||[]).includes('INBOX')))) && (
                    <button
                      onClick={handleArchive}
                      aria-label="Archive email"
                      className="p-2 text-text-3 hover:text-text-1 hover:bg-black/[0.04] rounded-full transition-all duration-150 cursor-pointer"
                      title="Archive"
                    >
                      <ArchiveIcon />
                    </button>
                  )}
                  {(isSearchMode ? !thread?.messages.some(m => (m.labelIds || []).includes('TRASH')) && !thread?.messages.some(m => (m.labelIds || []).includes('DRAFT')) : selectedFolder !== 'TRASH') && (
                    <button
                      onClick={handleTrash}
                      aria-label="Trash email"
                      className="p-2 text-text-3/70 hover:text-red-1 hover:bg-red-2/70 rounded-full transition-all duration-150 cursor-pointer"
                      title="Trash"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>

              {/* Thread messages */}
              <div className="flex-1 overflow-hidden relative">
                <div ref={threadScrollRef} onScroll={handleThreadScroll} className="absolute inset-0 overflow-y-auto scrollbar-hide">
                  {(() => {
                    const lastIdx = thread.messages.length - 1
                    return thread.messages.map((msg, idx) => (
                      <ThreadMessage
                        key={msg.id}
                        message={msg}
                        isLast={idx === lastIdx}
                        defaultExpanded={idx === lastIdx || msg.isUnread}
                        collapsedIds={collapsedIdsRef}
                      />
                    ))
                  })()}
                </div>
                {newThreadReplies > 0 && (
                  <button
                    onClick={() => {
                      const el = threadScrollRef.current
                      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                      setNewThreadReplies(0)
                    }}
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 bg-blue-1 text-white text-[11px] font-semibold rounded-full shadow-lg cursor-pointer"
                  >
                    {newThreadReplies} new repl{newThreadReplies === 1 ? 'y' : 'ies'} ↓
                  </button>
                )}
              </div>

              {/* Reply box — floating card pinned at bottom of thread pane */}
              {(isSearchMode || (selectedFolder !== 'DRAFT' && selectedFolder !== 'TRASH')) && !(thread?.messages.filter(m => !m.id.startsWith('optimistic-')).at(-1)?.labelIds?.some(l => l === 'DRAFT' || l === 'TRASH')) && (
              <div className="px-6 pt-3 pb-5">
                <div className="rounded-2xl bg-surface-1/90 border border-black/[0.05] shadow-[0_2px_12px_rgba(0,0,0,0.04)] overflow-hidden focus-within:border-purple-1/25 focus-within:shadow-[0_2px_16px_rgba(123,47,160,0.12)] transition-all duration-200">
                  <textarea
                    ref={replyTextareaRef}
                    value={replyDraft}
                    onChange={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; setReplyDraft(e.target.value); setReplyError(null) }}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); handleReply() } }}
                    disabled={!!sendingReply || (!!pendingSend && pendingSend.threadId === thread?.id)}
                    placeholder="Write a reply…"
                    rows={3}
                    className="w-full px-4 py-3 text-[13px] bg-transparent border-0 focus:outline-none text-text-1 placeholder-text-3/45 resize-none overflow-y-auto max-h-[160px] leading-relaxed tracking-tight"
                  />
                  <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-black/[0.04] bg-black/[0.01]">
                    <button
                      onClick={handleReplyAll}
                      disabled={!replyDraft.trim() || (!!pendingSend && pendingSend.threadId === thread?.id) || sendingReply}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11.5px] font-semibold text-text-2 bg-black/[0.04] hover:bg-black/[0.07] active:scale-[0.98] transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Reply All
                    </button>
                    <button
                      onClick={handleReply}
                      disabled={!replyDraft.trim() || (!!pendingSend && pendingSend.threadId === thread?.id) || sendingReply}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[11.5px] font-semibold text-white bg-gradient-to-b from-blue-1 to-blue-1/90 hover:shadow-[0_3px_10px_rgba(59,130,246,0.35)] active:scale-[0.98] transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_1px_4px_rgba(59,130,246,0.25)]"
                    >
                      <SendIcon />
                      Reply
                    </button>
                  </div>
                </div>
                {replyError && (
                  <p role="alert" className="mt-2 text-[10.5px] text-red-1">{replyError}</p>
                )}
                {pendingSend && pendingSend.threadId === thread?.id && (
                  <p className="mt-1 text-[10.5px] text-text-3/60">Reply queued — use Undo to cancel</p>
                )}
              </div>
              )}
            </>
          ) : (
            /* No thread selected */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-black/[0.03] to-black/[0.01] border border-black/[0.04] flex items-center justify-center mx-auto mb-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]">
                  <svg className="w-6 h-6 text-text-3/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.3} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-[14px] font-semibold text-text-2 tracking-tight">No message selected</p>
                <p className="text-[11.5px] text-text-3/80 mt-1 tracking-tight">Choose a conversation from the list</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Compose drawer (bottom-right slide-in) ── */}
      {composing && (
        <ComposeModal
          onSend={handleComposeSend}
          onClose={() => {
            setComposing(false); setDraftBeingEdited(null); setComposeResumeInitial(null); setSendError(null)
          }}
          onDiscard={() => {
            if (draftBeingEdited) {
              window.electronAPI.gmailTrash(draftBeingEdited.messageId).catch(() => {})
              recentlyRemovedThreadsRef.current.set(draftBeingEdited.threadId, Date.now())
              if (!draftBeingEdited.inReplyTo) {
                setMessages(prev => prev.filter(m => m.threadId !== draftBeingEdited.threadId))
                if (selectedThreadIdRef.current === draftBeingEdited.threadId) {
                  selectedThreadIdRef.current = null
                  setSelectedThreadId(null)
                  setThread(null)
                }
              } else if (selectedThreadIdRef.current === draftBeingEdited.threadId) {
                loadThread(draftBeingEdited.threadId, false)
              }
            }
            setComposing(false); setDraftBeingEdited(null); setComposeResumeInitial(null); setSendError(null)
          }}
          initial={composeResumeInitial ?? (draftBeingEdited ? {
            to: draftBeingEdited.to,
            cc: draftBeingEdited.cc,
            bcc: draftBeingEdited.bcc,
            subject: draftBeingEdited.subject,
            body: draftBeingEdited.body,
          } : undefined)}
          title={draftBeingEdited ? 'Edit draft' : 'New Message'}
          warning={draftBeingEdited?.htmlWarning ? 'Formatted content was converted to plain text for editing' : undefined}
        />
      )}

      {/* ── Action failure banner (archive/trash/move/star) ── */}
      {actionError && (
        <div className="fixed bottom-28 left-5 z-[110] flex items-center gap-3 pl-4 pr-2 py-2 rounded-full bg-red-600 text-white shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)] max-w-[520px]">
          <span className="text-[12px] font-medium tracking-tight truncate">{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-white hover:text-white/80 px-3 py-1 rounded-full hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Send failure banner (bottom-left, above undo toast) ── */}
      {sendError && (
        <div className="fixed bottom-16 left-5 z-[110] flex items-center gap-3 pl-4 pr-2 py-2 rounded-full bg-red-600 text-white shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)]">
          <span className="text-[12px] font-medium tracking-tight">Send failed — {sendError}</span>
          <button
            onClick={() => setSendError(null)}
            className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-white hover:text-white/80 px-3 py-1 rounded-full hover:bg-white/10 transition-colors cursor-pointer"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Cross-thread flush notice (bottom-left, above sendError banner) ── */}
      {flushNotice && (
        <div className="fixed bottom-[10rem] left-5 z-[110] flex items-center gap-3 pl-4 pr-3 py-2 rounded-full bg-[color:var(--color-text-1)] text-[color:var(--color-paper-cream)] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)] compose-drawer-enter">
          <span className="text-[12px] font-medium tracking-tight">{flushNotice}</span>
        </div>
      )}

      {/* ── Undo-send toast (bottom-left) ── */}
      {pendingSend && (
        <UndoSendToast
          label={pendingSend.label}
          expiresAt={pendingSend.expiresAt}
          onUndo={cancelPendingSend}
        />
      )}
    </div>
  )
}
