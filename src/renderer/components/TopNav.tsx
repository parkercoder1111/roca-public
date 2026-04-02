import React from 'react'

export type NavTab = 'week' | 'filepath'

interface Props {
  activeTab: NavTab
  week: string
  onTabChange: (tab: NavTab) => void
  onFeedback: (type: 'feature' | 'bug') => void
}

export default function TopNav({ activeTab, week, onTabChange, onFeedback }: Props) {
  return (
    <nav aria-label="Main navigation"
         className="border-b border-black/[0.06] px-6 pt-3 pb-2 flex items-center justify-center sticky top-0 z-50 bg-surface-0/80 backdrop-blur-xl shrink-0"
         style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>

      {/* Left spacer for centering */}
      <div className="flex-1" />

      {/* Centered pill switcher */}
      <div
        role="tablist"
        aria-label="App tabs"
        className="flex items-center bg-black/[0.04] rounded-full p-0.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onKeyDown={(e) => {
          const tabs: NavTab[] = ['week', 'filepath']
          const idx = tabs.indexOf(activeTab)
          if (e.key === 'ArrowRight') { e.preventDefault(); onTabChange(tabs[(idx + 1) % tabs.length]) }
          if (e.key === 'ArrowLeft') { e.preventDefault(); onTabChange(tabs[(idx - 1 + tabs.length) % tabs.length]) }
        }}
      >
        {(['week', 'filepath'] as const).map(tab => {
          const labels: Record<string, string> = { week: 'Tasks', filepath: 'Files' }
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              tabIndex={activeTab === tab ? 0 : -1}
              className={`px-4 py-1 rounded-full text-[12px] font-medium transition-all duration-200 cursor-pointer focus-visible:outline-2 focus-visible:outline-purple-1/30 focus-visible:outline-offset-1 ${
                activeTab === tab
                  ? 'bg-surface-0/90 text-text-1 shadow-sm'
                  : 'text-text-3 hover:text-text-2'
              }`}
              onClick={() => onTabChange(tab)}
            >
              {labels[tab]}
            </button>
          )
        })}
      </div>

      {/* Right side — week + feedback buttons */}
      <div className="flex-1 flex items-center justify-end gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <span className="text-[10px] font-medium text-text-3 tracking-[0.08em]" title={week}>
          {week.replace(/^(\d{4})-W(\d+)$/, (_, y, w) => `W${w.padStart(2, '0')} · ${y}`)}
        </span>
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
