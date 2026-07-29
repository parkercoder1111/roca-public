import React, { useState, useEffect, useRef } from 'react'

export function ContextMenu({ x, y, onCopy, onPaste, onDelete, onInsertRowAbove, onInsertRowBelow,
  onInsertColLeft, onInsertColRight, onDeleteRow, onDeleteCol, onSortAsc, onSortDesc, onAutoFit, onClose }: {
  x: number; y: number
  onCopy: () => void; onPaste: () => void; onDelete: () => void
  onInsertRowAbove: () => void; onInsertRowBelow: () => void
  onInsertColLeft: () => void; onInsertColRight: () => void
  onDeleteRow: () => void; onDeleteCol: () => void
  onSortAsc: () => void; onSortDesc: () => void
  onAutoFit: () => void; onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Adjust position to stay in viewport
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth ? x - rect.width : x
    const ny = y + rect.height > window.innerHeight ? y - rect.height : y
    setPos({ x: Math.max(0, nx), y: Math.max(0, ny) })
  }, [x, y])

  const item = (label: string, shortcut: string | null, onClick: () => void, danger = false) => (
    <button
      key={label}
      className={`w-full flex items-center justify-between px-3 py-1.5 text-[11px] hover:bg-[#e8f0fe] transition-colors cursor-pointer text-left ${danger ? 'text-red-600' : 'text-[#1a1a1a]'}`}
      onClick={(e) => { e.stopPropagation(); onClick(); onClose() }}
    >
      <span>{label}</span>
      {shortcut && <span className="text-[9px] text-[#999] ml-4">{shortcut}</span>}
    </button>
  )

  const divider = () => <div className="border-t border-[#e0e0e0] my-1" />

  return (
    <div
      ref={menuRef}
      className="fixed bg-white border border-[#c0c0c0] rounded-lg shadow-lg py-1 z-50 min-w-[180px]"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {item('Copy', '⌘C', onCopy)}
      {item('Paste', '⌘V', onPaste)}
      {item('Delete', '⌫', onDelete)}
      {divider()}
      {item('Insert Row Above', null, onInsertRowAbove)}
      {item('Insert Row Below', null, onInsertRowBelow)}
      {item('Insert Column Left', null, onInsertColLeft)}
      {item('Insert Column Right', null, onInsertColRight)}
      {divider()}
      {item('Sort A → Z', null, onSortAsc)}
      {item('Sort Z → A', null, onSortDesc)}
      {item('Auto-fit Column Width', null, onAutoFit)}
      {divider()}
      {item('Delete Row', null, onDeleteRow, true)}
      {item('Delete Column', null, onDeleteCol, true)}
    </div>
  )
}
