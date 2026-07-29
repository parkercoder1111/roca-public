import React, { useState, useCallback, useEffect, useRef } from 'react'
import { WEBVIEW_TOOLS, type WebviewToolSpec } from '../lib/webview-tools'
import { useViewMode } from '../lib/view-mode'

// Pinned tabs — ROCA-native surfaces. Slack + Email were moved to dynamic
// webview tabs (Slack is rolled back; the custom EmailView component is
// intentionally still in the repo so we can restore it in one line without
// rewriting anything).
export type NavTab = 'email' | 'week' | 'notes' | 'filepath' | 'scribe'

export type DynamicTabKind = string
export interface DynamicTab {
  id: string
  kind: DynamicTabKind
  label: string
  // Set when the tab was opened from an in-guest popup (e.g. clicking
  // Extensions → Apps Script in Sheets). The webview navigates to this URL
  // on first load instead of the tool's default landing URL. Persisted so
  // popup tabs survive an app restart.
  initialUrl?: string
}

type Theme = 'light' | 'dark'

// Read initial theme once at module load — avoids a flash of wrong theme on mount.
function readInitialTheme(): Theme {
  const saved = localStorage.getItem('roca:theme')
  if (saved === 'dark' || saved === 'light') return saved
  return 'light'
}
// Applied at module load so the first paint is already on the correct theme.
document.documentElement.setAttribute('data-theme', readInitialTheme())

// Pinned tabs shown in the strip: Tasks (week) then Notes. Files moved into the
// Settings overlay; the `filepath` NavTab value is retained in the type for
// backwards-compat with saved localStorage state.
const TABS = ['week', 'notes', 'scribe'] as const satisfies readonly NavTab[]

const TAB_LABELS: Record<NavTab, string> = {
  email: 'Email',
  week: 'Tasks',
  notes: 'Notes',
  filepath: 'Files',
  scribe: 'Scribe',
}

interface Props {
  activeTab: NavTab
  activeDynamicId: string | null
  dynamicTabs: DynamicTab[]
  dynamicUnread?: Record<string, number>
  dynamicFavicons?: Record<string, string>
  customTools?: WebviewToolSpec[]
  week: string
  onTabChange: (tab: NavTab) => void
  onSelectDynamic: (id: string) => void
  onCloseDynamic: (id: string) => void
  onNewTab: () => void
  onReorderTab?: (tabId: string, toIndex: number) => void
  onFeedback: (type: 'feature' | 'bug') => void
}

// SVG icons shown on the pinned Tasks / Files tabs — matches the other
// pinned-tab aesthetic (no favicon).
function PinnedIcon({ kind }: { kind: NavTab }) {
  const cls = 'w-3.5 h-3.5 shrink-0'
  if (kind === 'week') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    )
  }
  if (kind === 'notes') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    )
  }
  if (kind === 'filepath') {
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
          d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      </svg>
    )
  }
  if (kind === 'scribe') {
    // Microphone — the meeting note-taker.
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
          d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM19 10v2a7 7 0 01-14 0v-2M12 19v3" />
      </svg>
    )
  }
  return null
}

// Generic tab chip — used for both pinned and dynamic tabs. Chrome-style:
// rounded-top corners, active tab fills with content color and lifts above
// a darker strip; inactive tabs sit flush with the strip and are separated
// by a hairline rail on the left edge so adjacent chips read as distinct
// cells (the Chrome / Arc pattern).
function TabChip({
  isActive, showLeftDivider, onClick, onClose, icon, label, unread, locked,
  draggable, onDragStart, onDragEnd,
}: {
  isActive: boolean
  showLeftDivider: boolean
  onClick: () => void
  onClose?: () => void
  icon: React.ReactNode
  label: string
  unread?: number
  locked?: boolean
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
}) {
  return (
    <div
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`
        group relative flex items-center gap-1.5 cursor-pointer select-none
        h-[30px] min-w-0 ${onClose && !locked ? 'pl-2.5 pr-1' : 'px-2.5'}
        rounded-t-md text-[12px] font-medium
        transition-colors duration-150
        ${isActive
          ? 'text-text-1 z-10'
          : 'text-text-3 hover:text-text-1 hover:bg-surface-1'}
      `}
      style={isActive
        ? {
            background: 'var(--color-surface-0)',
            boxShadow: '0 -1px 0 0 var(--color-hairline), -1px 0 0 0 var(--color-hairline), 1px 0 0 0 var(--color-hairline)',
          }
        : showLeftDivider
          ? { boxShadow: 'inset 1px 0 0 0 var(--color-hairline)' }
          : undefined}
    >
      {icon}
      <span className="truncate min-w-0 max-w-[160px]">{label}</span>
      {!!unread && unread > 0 && (
        <span
          className="min-w-[16px] h-[16px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none px-1"
          style={{ background: 'var(--color-purple-1)', color: 'var(--color-paper-cream)' }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      {!locked && onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          className={`
            w-4 h-4 flex items-center justify-center rounded
            hover:bg-black/[0.10] transition-opacity
            ${isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'}
          `}
          title={`Close ${label}`}
          aria-label={`Close ${label}`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )
}

function ToolFavicon({ src }: { src: string | undefined }) {
  const [err, setErr] = useState(false)
  if (!src || err) {
    // Fallback: a neutral globe glyph for tools without a favicon yet.
    return (
      <svg className="w-3.5 h-3.5 shrink-0 text-text-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" strokeWidth={1.5} />
        <path strokeLinecap="round" strokeWidth={1.5} d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
      </svg>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className="w-3.5 h-3.5 shrink-0 rounded-sm"
      onError={() => setErr(true)}
      draggable={false}
    />
  )
}

export function TopNav({
  activeTab,
  activeDynamicId,
  dynamicTabs = [],
  dynamicUnread = {},
  dynamicFavicons = {},
  customTools = [],
  week,
  onTabChange,
  onSelectDynamic,
  onCloseDynamic,
  onNewTab,
  onReorderTab,
  onFeedback,
}: Props) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme)
  const [viewMode, toggleViewMode] = useViewMode()

  // Tab strip DOM ref — used both to publish the strip's screen bounds to
  // main (so cross-window drags can hit-test against us) and to read chip
  // positions during drop to compute the insertion index.
  const stripRef = useRef<HTMLDivElement | null>(null)

  // Drag state. `draggingTabId` is set on dragstart for visual fade-out
  // of the source chip. `hoverIdx` is the index where a drop would land,
  // rendered as a thin vertical insertion bar between chips.
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  // Pinned tabs occupy the first N positions; drops compute indices into
  // the *dynamic* slice (passed back to app.tsx as `toIndex`), so we keep
  // the pinned count to translate strip-DOM indices into dynamic indices.
  const PINNED_COUNT = TABS.length

  // Report the strip's screen bounds to main on layout. Main needs this
  // to know which window's strip the cursor is over during a cross-window
  // tab drag. We publish on mount, on every dynamic-tabs change (which
  // reflows the strip), and on window resize. Null = no longer tracking.
  useEffect(() => {
    const publish = () => {
      const el = stripRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      window.electronAPI.windowReportStripBounds?.({
        x: r.left, y: r.top, width: r.width, height: r.height,
      }).catch(() => {})
    }
    publish()
    window.addEventListener('resize', publish)
    return () => {
      window.removeEventListener('resize', publish)
      window.electronAPI.windowReportStripBounds?.(null).catch(() => {})
    }
  }, [dynamicTabs.length])

  // Hover indicator driven by *other windows* dragging a tab over us.
  // (Same-window drags use the local hoverIdx via dragover handler below.)
  useEffect(() => {
    const off = window.electronAPI.onTabDragHover?.((info) => {
      if (!info) { setHoverIdx(null); return }
      const el = stripRef.current
      if (!el) return
      const chips = Array.from(el.querySelectorAll('[role="tab"]')) as HTMLElement[]
      const stripLeft = el.getBoundingClientRect().left
      let idx = chips.length
      for (let i = 0; i < chips.length; i++) {
        const r = chips[i].getBoundingClientRect()
        const midX = r.left - stripLeft + r.width / 2
        if (info.x < midX) { idx = i; break }
      }
      setHoverIdx(idx)
    })
    return off
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem('roca:theme', next)
      return next
    })
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Compute the drop-target index for an in-strip dragover. Returns the
  // insertion index in DOM order (pinned tabs included), which we translate
  // to a dynamic-tabs index on drop.
  const computeDropIdx = useCallback((clientX: number): number => {
    const el = stripRef.current
    if (!el) return -1
    const chips = Array.from(el.querySelectorAll('[role="tab"]')) as HTMLElement[]
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect()
      if (clientX < r.left + r.width / 2) return i
    }
    return chips.length
  }, [])

  const handleDragStart = useCallback((tab: DynamicTab) => (e: React.DragEvent) => {
    setDraggingTabId(tab.id)
    e.dataTransfer.effectAllowed = 'move'
    // dataTransfer.setData lets some destinations (other apps) discover the
    // payload; we don't actually use it on drop — main process tracks state.
    try { e.dataTransfer.setData('application/x-roca-tab', tab.id) } catch {}
    // Kick off the main-process cursor-tracking broker for cross-window
    // moves and tear-off detection. The renderer-side HTML5 dragover/drop
    // handles same-window reorder; main's broker only fires on dragend if
    // the cursor isn't on our strip.
    window.electronAPI.tabDragBegin?.({
      tabId: tab.id,
      serializedTab: tab,
    }).catch(() => {})
  }, [])

  const handleDragEnd = useCallback((_e: React.DragEvent) => {
    setDraggingTabId(null)
    setHoverIdx(null)
    // Tell main we're done. Main inspects cursor position to decide between
    // same-window (no-op), cross-window drop, or tear-off.
    window.electronAPI.tabDragEnd?.({}).catch(() => {})
  }, [])

  const handleStripDragOver = useCallback((e: React.DragEvent) => {
    if (!draggingTabId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const idx = computeDropIdx(e.clientX)
    setHoverIdx(idx)
  }, [draggingTabId, computeDropIdx])

  const handleStripDrop = useCallback((e: React.DragEvent) => {
    if (!draggingTabId) return
    e.preventDefault()
    const idx = computeDropIdx(e.clientX)
    // Pinned tabs are locked at the start — clamp insertion past them so a
    // drop in the pinned area lands at index 0 of the dynamic slice.
    const dynIdx = Math.max(0, idx - PINNED_COUNT)
    onReorderTab?.(draggingTabId, dynIdx)
    setDraggingTabId(null)
    setHoverIdx(null)
  }, [draggingTabId, computeDropIdx, onReorderTab, PINNED_COUNT])

  return (
    <nav
      aria-label="Main navigation"
      className="px-3 pt-2 flex items-end sticky top-0 z-50 backdrop-blur-xl shrink-0"
      style={{
        WebkitAppRegion: 'drag',
        paddingBottom: 0,
        background: 'var(--color-surface-2)',
      } as React.CSSProperties}
    >
      {/* Left spacer — macOS traffic-light area + drag handle (78px is the
          standard width occupied by the three native window buttons). */}
      <div className="w-[78px] shrink-0 pb-2" />

      <div
        ref={stripRef}
        role="tablist"
        aria-label="App tabs"
        className="flex items-end pb-0 min-w-0 flex-1 overflow-x-auto scrollbar-hide relative"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onKeyDown={(e) => {
          const idx = (TABS as readonly string[]).indexOf(activeTab)
          if (e.key === 'ArrowRight') { e.preventDefault(); onTabChange(TABS[(idx + 1) % TABS.length]) }
          if (e.key === 'ArrowLeft') { e.preventDefault(); onTabChange(TABS[(idx - 1 + TABS.length) % TABS.length]) }
        }}
        onDragOver={handleStripDragOver}
        onDrop={handleStripDrop}
      >
        {(() => {
          // Build the full ordered tab list so we can compute each tab's
          // "showLeftDivider" flag (Chrome-style: a hairline rail between
          // inactive neighbors, hidden adjacent to the active tab).
          type Entry =
            | { type: 'pinned'; tab: NavTab; isActive: boolean }
            | { type: 'dynamic'; dt: DynamicTab; isActive: boolean }
          const entries: Entry[] = [
            ...TABS.map(tab => ({
              type: 'pinned' as const,
              tab,
              isActive: activeTab === tab && activeDynamicId == null,
            })),
            ...dynamicTabs.map(dt => ({
              type: 'dynamic' as const,
              dt,
              isActive: activeDynamicId === dt.id,
            })),
          ]
          return entries.map((e, i) => {
            const prevActive = i > 0 && entries[i - 1].isActive
            const showLeftDivider = i > 0 && !e.isActive && !prevActive
            // Drop indicator — a 2px vertical bar between chips marking the
            // insertion point during a drag. Sits in the flex flow as a
            // pseudo-sibling so the chips don't visually shift.
            const indicator = hoverIdx === i ? (
              <div
                key={`ind:${i}`}
                aria-hidden
                className="w-[2px] h-[24px] self-end mb-0.5 rounded-full"
                style={{ background: 'var(--color-purple-1)' }}
              />
            ) : null
            if (e.type === 'pinned') {
              return (
                <React.Fragment key={`pin:${e.tab}`}>
                  {indicator}
                  <TabChip
                    isActive={e.isActive}
                    showLeftDivider={showLeftDivider}
                    onClick={() => onTabChange(e.tab)}
                    icon={<PinnedIcon kind={e.tab} />}
                    label={TAB_LABELS[e.tab]}
                    locked
                  />
                </React.Fragment>
              )
            }
            const spec = [...WEBVIEW_TOOLS, ...customTools].find(t => t.kind === e.dt.kind)
            const iconSrc = dynamicFavicons[e.dt.id] ?? spec?.iconUrl
            const isDragging = draggingTabId === e.dt.id
            return (
              <React.Fragment key={e.dt.id}>
                {indicator}
                <div
                  // Wrap so the dragging-fade style applies without leaking
                  // into TabChip's existing className composition.
                  style={isDragging ? { opacity: 0.4 } : undefined}
                >
                  <TabChip
                    isActive={e.isActive}
                    showLeftDivider={showLeftDivider}
                    onClick={() => onSelectDynamic(e.dt.id)}
                    onClose={() => onCloseDynamic(e.dt.id)}
                    icon={<ToolFavicon src={iconSrc} />}
                    label={e.dt.label}
                    unread={dynamicUnread[e.dt.id]}
                    draggable={!!onReorderTab}
                    onDragStart={handleDragStart(e.dt)}
                    onDragEnd={handleDragEnd}
                  />
                </div>
              </React.Fragment>
            )
          })
        })()}
        {/* Trailing drop indicator — when the cursor sits past the last tab. */}
        {hoverIdx != null && (() => {
          const entryCount = TABS.length + dynamicTabs.length
          return hoverIdx === entryCount ? (
            <div
              aria-hidden
              className="w-[2px] h-[24px] self-end mb-0.5 rounded-full"
              style={{ background: 'var(--color-purple-1)' }}
            />
          ) : null
        })()}

        {/* + button — opens a fresh ROCA new-tab page (URL bar + app grid),
            mirroring browser behavior. The grid lives inside the tab, so the
            top-nav stays clean. */}
        <button
          onClick={onNewTab}
          className="w-7 h-[28px] ml-1 mb-0.5 flex items-center justify-center rounded-full text-text-3 hover:text-text-1 hover:bg-surface-1 active:scale-90 transition-all duration-150 cursor-pointer"
          title="New tab (⌘T)"
          aria-label="New tab"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      <div className="shrink-0 flex items-center justify-end gap-3 pb-2 pl-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <span className="mono tabular text-[10px] font-medium text-text-3 tracking-[0.08em] whitespace-nowrap" title={week}>
          {week.replace(/^(\d{4})-W(\d+)$/, (_, y, w) => `W${w.padStart(2, '0')} · ${y}`)}
        </span>
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-md text-text-3 hover:text-text-1 hover:bg-surface-1 transition-colors cursor-pointer"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="4" strokeWidth={1.5} />
              <path strokeLinecap="round" strokeWidth={1.5} d="M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4l1.4-1.4M17 7l1.4-1.4" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          )}
        </button>
        <button
          onClick={toggleViewMode}
          className="p-1.5 rounded-md text-text-3 hover:text-text-1 hover:bg-surface-1 transition-colors cursor-pointer"
          title={viewMode === 'optical' ? 'Switch to terminal view' : 'Switch to optical view'}
          aria-label={viewMode === 'optical' ? 'Switch to terminal view' : 'Switch to optical view'}
        >
          {viewMode === 'optical' ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M4 6h16M4 6v12a1 1 0 001 1h14a1 1 0 001-1V6M7 10l3 2-3 2M12 14h5" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1-3.5A8.95 8.95 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          )}
        </button>
        <button
          className="p-1.5 rounded-md text-purple-1/70 hover:text-purple-1 hover:bg-purple-2 transition-colors cursor-pointer"
          title="Request a feature"
          aria-label="Request a feature"
          onClick={() => onFeedback('feature')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </button>
        <button
          className="p-1.5 rounded-md text-red-1/70 hover:text-red-1 hover:bg-red-2 transition-colors cursor-pointer"
          title="Report a bug"
          aria-label="Report a bug"
          onClick={() => onFeedback('bug')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </button>
      </div>
    </nav>
  )
}
