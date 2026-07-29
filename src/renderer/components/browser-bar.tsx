import React, { useEffect, useRef, useState } from 'react'

interface Props {
  url: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  hidden: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onToggleHidden: () => void
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'https://www.google.com'
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('about:') || trimmed.startsWith('chrome://')) return trimmed
  if (/^[^\s]+\.[^\s/]+/.test(trimmed)) return 'https://' + trimmed
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

function parseUrl(url: string): { hostname: string; pathAndQuery: string } | null {
  if (!url || url === 'about:blank') return null
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    return { hostname: u.hostname.replace(/^www\./, ''), pathAndQuery: path + u.search }
  } catch {
    return null
  }
}

function isSecure(url: string): boolean {
  return url.startsWith('https://')
}

const navBtnCls =
  'p-1.5 rounded-full text-text-3 hover:text-text-1 hover:bg-black/[0.06] active:scale-[0.92] disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-text-3 disabled:active:scale-100 transition-all duration-150'

export function BrowserBar({
  url,
  isLoading,
  canGoBack,
  canGoForward,
  hidden,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onToggleHidden,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(url)

  useEffect(() => {
    if (!editing) setDraft(url)
  }, [url, editing])

  const focusInput = () => {
    setEditing(true)
    setDraft(url)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  // Cmd+L focuses the URL bar (browser convention). When hidden, also reveal it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        if (hidden) onToggleHidden()
        focusInput()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, onToggleHidden, url])

  if (hidden) {
    return (
      <div className="shrink-0 flex justify-center bg-surface-0 border-b border-black/[0.06]">
        <button
          onClick={onToggleHidden}
          className="px-2 py-0.5 text-text-3 hover:text-text-2 hover:bg-black/[0.04] rounded-b transition-all"
          title="Show URL bar (⌘L)"
          aria-label="Show URL bar"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
    )
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const target = normalizeUrl(draft)
    onNavigate(target)
    inputRef.current?.blur()
  }

  const parsed = parseUrl(url)
  const showLock = !editing && url && url !== 'about:blank'

  return (
    <div className="shrink-0 relative bg-gradient-to-b from-surface-0 to-surface-1/60 border-b border-black/[0.06]">
      <div className="flex items-center gap-0.5 px-2.5 py-1.5">
        <button
          onClick={onBack}
          disabled={!canGoBack}
          aria-label="Back"
          title="Back"
          className={navBtnCls}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={onForward}
          disabled={!canGoForward}
          aria-label="Forward"
          title="Forward"
          className={navBtnCls}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={isLoading ? onStop : onReload}
          aria-label={isLoading ? 'Stop' : 'Reload'}
          title={isLoading ? 'Stop' : 'Reload'}
          className={navBtnCls}
        >
          {isLoading ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
        </button>

        <form onSubmit={submit} className="flex-1 mx-1.5 min-w-0">
          <div
            className={`group flex items-center min-w-0 rounded-full transition-all duration-200 ${
              editing
                ? 'bg-surface-0 ring-1 ring-purple-1/40 shadow-[0_0_0_3px_var(--color-purple-2),inset_0_1px_2px_rgba(0,0,0,0.03)]'
                : 'bg-gradient-to-b from-black/[0.025] to-black/[0.05] ring-1 ring-black/[0.06] hover:from-black/[0.035] hover:to-black/[0.06] hover:ring-black/[0.1]'
            }`}
          >
            {showLock && (
              <span className="pl-2.5 shrink-0 flex items-center" aria-hidden>
                {isSecure(url) ? (
                  <svg className="w-3 h-3 text-green-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                  </svg>
                ) : url.startsWith('http://') ? (
                  <svg className="w-3 h-3 text-red-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                ) : null}
              </span>
            )}

            {editing ? (
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => setEditing(false)}
                onKeyDown={e => { if (e.key === 'Escape') { inputRef.current?.blur() } }}
                className="flex-1 bg-transparent px-3 py-[5px] text-[11.5px] text-text-1 focus:outline-none min-w-0 tracking-tight"
                placeholder="Search Google or type a URL"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={focusInput}
                className="flex-1 text-left px-2.5 py-[5px] truncate min-w-0 text-[11.5px] tracking-tight cursor-text"
              >
                {parsed ? (
                  <>
                    <span className="text-text-1 font-medium">{parsed.hostname}</span>
                    <span className="text-text-3">{parsed.pathAndQuery}</span>
                  </>
                ) : (
                  <span className="text-text-3">Search Google or type a URL</span>
                )}
              </button>
            )}
          </div>
        </form>

        <button
          onClick={onToggleHidden}
          aria-label="Hide URL bar"
          title="Hide URL bar"
          className={navBtnCls}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>

      {isLoading && (
        <div className="absolute bottom-0 left-0 right-0 h-[1.5px] overflow-hidden pointer-events-none" aria-hidden>
          <div className="absolute inset-y-0 -left-[35%] w-[35%] bg-gradient-to-r from-transparent via-purple-1 to-transparent animate-urlbar-sweep" />
        </div>
      )}
    </div>
  )
}
