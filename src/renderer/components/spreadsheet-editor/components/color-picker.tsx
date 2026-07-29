import React, { useState, useEffect, useRef } from 'react'

// ── Color palette ──

const PALETTE_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
]

export function ColorPicker({ onSelect, currentColor, label }: { onSelect: (color: string) => void; currentColor?: string; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(p => !p)}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        className="h-[26px] px-1.5 rounded hover:bg-[#e0e0e0] transition-colors cursor-pointer flex items-center gap-0.5"
        title={label}
      >
        <span className="text-[10px] font-semibold text-[#444]">{label === 'Text color' ? 'A' : ''}</span>
        <div
          className="w-4 h-1.5 rounded-sm border border-black/10"
          style={{ background: currentColor || (label === 'Text color' ? '#000000' : '#ffffff') }}
        />
        <svg className="w-2 h-2 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-[#c0c0c0] rounded-lg shadow-lg p-2 z-50 grid grid-cols-10 gap-0.5" style={{ width: 200 }}>
          {PALETTE_COLORS.map(color => (
            <button
              key={color}
              onClick={() => { onSelect(color); setOpen(false) }}
              aria-label={color}
              className={`w-[16px] h-[16px] rounded-sm border cursor-pointer hover:scale-125 transition-transform ${
                color === currentColor ? 'border-blue-500 border-2' : 'border-black/10'
              }`}
              style={{ background: color }}
              title={color}
            />
          ))}
          {/* No color / remove */}
          <button
            onClick={() => { onSelect(''); setOpen(false) }}
            className="col-span-10 mt-1 text-[9px] text-[#666] py-1 rounded hover:bg-[#f0f0f0] cursor-pointer"
          >
            No color
          </button>
        </div>
      )}
    </div>
  )
}
