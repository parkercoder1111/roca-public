import React, { useMemo } from 'react'

export type BuiltinFolder = 'INBOX' | 'STARRED' | 'SENT' | 'DRAFT' | 'ARCHIVE' | 'TRASH'
export type FolderKey = BuiltinFolder | `LABEL:${string}`

export interface GmailLabelLite {
  id: string
  name: string
  type: string
}

interface Props {
  selected: FolderKey
  inboxUnread: number
  labels: GmailLabelLite[]
  onSelect: (folder: FolderKey) => void
  onCompose: () => void
  syncError?: boolean
}

// Hairline SF-style icons (1.5px strokes, crisp geometry)
const InboxIcon = () => (
  <svg className="w-[15px] h-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M4 13l3.5-7h9L20 13M4 13v5a2 2 0 002 2h12a2 2 0 002-2v-5M4 13h4l1 2h6l1-2h4" />
  </svg>
)
const StarIcon = ({ filled }: { filled?: boolean }) => (
  <svg className="w-[15px] h-[15px]" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.539-1.118l1.518-4.674a1 1 0 00-.362-1.118L2.098 10.1c-.784-.57-.381-1.81.587-1.81h4.914a1 1 0 00.951-.69l1.519-4.673z" />
  </svg>
)
const SentIcon = () => (
  <svg className="w-[15px] h-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M3.5 12l17-9-5.5 18-4-7-7.5-2z" />
  </svg>
)
const DraftIcon = () => (
  <svg className="w-[15px] h-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M4 19.5l4-1.2L18.7 7.6a1.8 1.8 0 00-2.5-2.5L5.5 15.9 4 19.5zM14 7l3 3" />
  </svg>
)
const ArchiveIcon = () => (
  <svg className="w-[15px] h-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M3 7h18M5 7v11a2 2 0 002 2h10a2 2 0 002-2V7M3 7l2-3h14l2 3M10 12h4" />
  </svg>
)
const TrashIcon = () => (
  <svg className="w-[15px] h-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0l-.9 12.1A2 2 0 0115.1 21H8.9a2 2 0 01-2-1.9L6 7h12zM10 11v6M14 11v6" />
  </svg>
)
const TagIcon = () => (
  <svg className="w-[15px] h-[15px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <circle cx="17" cy="7" r="1.2" fill="currentColor" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M3 12v-5a4 4 0 014-4h5a2 2 0 011.4.6l7 7a2 2 0 010 2.8l-6 6a2 2 0 01-2.8 0l-7-7A2 2 0 013 12z" />
  </svg>
)
const ComposeIcon = () => (
  <svg className="w-[14px] h-[14px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M12 5v14M5 12h14" />
  </svg>
)

const BUILTINS: { key: BuiltinFolder; label: string; icon: React.ReactNode }[] = [
  { key: 'INBOX', label: 'Inbox', icon: <InboxIcon /> },
  { key: 'STARRED', label: 'Starred', icon: <StarIcon /> },
  { key: 'SENT', label: 'Sent', icon: <SentIcon /> },
  { key: 'DRAFT', label: 'Drafts', icon: <DraftIcon /> },
  { key: 'ARCHIVE', label: 'Archive', icon: <ArchiveIcon /> },
  { key: 'TRASH', label: 'Trash', icon: <TrashIcon /> },
]

export function FolderSidebar({ selected, inboxUnread, labels, onSelect, onCompose, syncError }: Props) {
  const userLabels = useMemo(
    () => labels
      .filter(l => l.type === 'user' && !l.name.startsWith('CATEGORY_'))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [labels]
  )

  return (
    <div className="shrink-0 w-[210px] flex flex-col bg-gradient-to-b from-surface-0 to-surface-1/40">
      {/* Compose — primary action, pill-shaped, cushioned */}
      <div className="px-4 pt-5 pb-3">
        <button
          onClick={onCompose}
          className="w-full group relative flex items-center justify-center gap-2 px-4 py-2.5 text-[12px] font-semibold text-white bg-purple-1 rounded-full shadow-[0_2px_8px_rgba(123,47,160,0.25)] hover:shadow-[0_4px_14px_rgba(123,47,160,0.35)] active:scale-[0.98] transition-all duration-150 cursor-pointer"
          title="Compose (c)"
        >
          <ComposeIcon />
          <span className="tracking-tight">Compose</span>
        </button>
      </div>

      {/* Folders */}
      <nav className="flex-1 overflow-y-auto scrollbar-hide px-2.5 pb-4">
        {BUILTINS.map(f => {
          const active = selected === f.key
          const showBadge = f.key === 'INBOX' && inboxUnread > 0
          return (
            <button
              key={f.key}
              onClick={() => onSelect(f.key)}
              className={`w-full group flex items-center gap-2.5 px-3 py-[7px] my-[1px] text-[12.5px] rounded-full transition-all duration-150 cursor-pointer ${
                active
                  ? 'bg-purple-1/[0.08] text-purple-1 font-semibold'
                  : 'text-text-2 hover:bg-black/[0.035] hover:text-text-1'
              }`}
            >
              <span className={`shrink-0 transition-colors ${active ? 'text-purple-1' : 'text-text-3 group-hover:text-text-2'}`}>{f.icon}</span>
              <span className="flex-1 text-left truncate tracking-tight">{f.label}</span>
              {showBadge && (
                <span className="shrink-0 text-[10px] font-semibold text-white bg-purple-1 rounded-full px-[7px] py-[1px] min-w-[18px] text-center shadow-sm">
                  {inboxUnread}
                </span>
              )}
            </button>
          )
        })}

        {userLabels.length > 0 && (
          <>
            <div className="mt-4 mb-1 px-3 text-[9px] uppercase tracking-[0.08em] text-text-3/50 font-semibold">
              Labels
            </div>
            {userLabels.map(l => {
              const key: FolderKey = `LABEL:${l.id}`
              const active = selected === key
              return (
                <button
                  key={l.id}
                  onClick={() => onSelect(key)}
                  className={`w-full group flex items-center gap-2.5 px-3 py-[7px] my-[1px] text-[12.5px] rounded-full transition-all duration-150 cursor-pointer ${
                    active
                      ? 'bg-purple-1/[0.08] text-purple-1 font-semibold'
                      : 'text-text-2 hover:bg-black/[0.035] hover:text-text-1'
                  }`}
                  title={l.name}
                >
                  <span className={`shrink-0 transition-colors ${active ? 'text-purple-1' : 'text-text-3 group-hover:text-text-2'}`}><TagIcon /></span>
                  <span className="flex-1 text-left truncate tracking-tight">{l.name}</span>
                </button>
              )
            })}
          </>
        )}
      </nav>
      {syncError && (
        <div className="px-4 pb-3 text-[9.5px] text-text-3/50 flex items-center gap-1">
          <span>⚠</span>
          <span>Folder counts may be stale</span>
        </div>
      )}
    </div>
  )
}
