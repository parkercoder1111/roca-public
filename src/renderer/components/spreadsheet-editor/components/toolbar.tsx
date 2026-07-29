import React from 'react'
import type { Upload } from '@shared/types'

export function Toolbar({ upload, onBack, dirty, isSaving, onSave, onRefresh, saveMessage, onSearch, undoCount, redoCount, onUndo, onRedo }: {
  upload: Upload
  onBack: () => void
  dirty: number
  isSaving: boolean
  onSave: () => void
  onRefresh: () => void
  saveMessage?: string | null
  onSearch?: () => void
  undoCount?: number
  redoCount?: number
  onUndo?: () => void
  onRedo?: () => void
}) {
  return (
    <div className="shrink-0 flex items-center gap-1 px-3 py-2 border-b border-black/[0.06]">
      <button
        onClick={onBack}
        aria-label="Go back"
        className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <span className="text-[11px] text-text-1 font-medium truncate flex-1">{upload.filename}</span>

      {saveMessage && (
        <span className={`text-[10px] ${saveMessage.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
          {saveMessage}
        </span>
      )}

      {dirty > 0 && (
        <button
          onClick={onSave}
          disabled={isSaving}
          className="px-2 py-1 rounded text-[10px] font-medium bg-[#217346] text-white hover:bg-[#1a5c38] transition-colors cursor-pointer disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      )}

      {/* Undo */}
      {onUndo && (
        <button
          onClick={onUndo}
          disabled={!undoCount}
          aria-label="Undo"
          className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer disabled:opacity-25"
          title="Undo (⌘Z)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
          </svg>
        </button>
      )}

      {/* Redo */}
      {onRedo && (
        <button
          onClick={onRedo}
          disabled={!redoCount}
          aria-label="Redo"
          className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer disabled:opacity-25"
          title="Redo (⌘⇧Z)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" />
          </svg>
        </button>
      )}

      {onSearch && (
        <button
          onClick={onSearch}
          aria-label="Find in spreadsheet"
          className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
          title="Find (⌘F)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      )}

      <button
        onClick={onRefresh}
        aria-label="Refresh"
        className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
        title="Refresh"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
      <button
        onClick={() => window.electronAPI.showItemInFolder(upload.stored_name)}
        aria-label="Open in Finder"
        className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
        title="Open in Finder"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </button>
    </div>
  )
}
