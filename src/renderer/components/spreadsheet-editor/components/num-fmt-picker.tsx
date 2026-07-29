import React, { useState, useEffect, useRef } from 'react'

// ── Number format dropdown ──

const NUM_FORMATS: { label: string; fmt: string }[] = [
  { label: 'General', fmt: 'General' },
  { label: 'Number', fmt: '#,##0.00' },
  { label: 'Currency', fmt: '$#,##0.00' },
  { label: 'Percent', fmt: '0.00%' },
  { label: 'Date', fmt: 'mm/dd/yyyy' },
  { label: 'Integer', fmt: '#,##0' },
]

export function NumFmtPicker({ onSelect, currentFmt }: { onSelect: (fmt: string) => void; currentFmt?: string }) {
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

  const currentLabel = NUM_FORMATS.find(f => f.fmt === currentFmt)?.label || 'General'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(p => !p)}
        aria-label="Number format"
        aria-haspopup="true"
        aria-expanded={open}
        className="h-[26px] px-2 rounded hover:bg-[#e0e0e0] transition-colors cursor-pointer flex items-center gap-1"
        title="Number format"
      >
        <span className="text-[10px] font-medium text-[#444]">{currentLabel}</span>
        <svg className="w-2 h-2 text-[#888]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-[#c0c0c0] rounded-lg shadow-lg py-1 z-50 min-w-[120px]">
          {NUM_FORMATS.map(f => (
            <button
              key={f.fmt}
              onClick={() => { onSelect(f.fmt); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-[#e8f0fe] cursor-pointer transition-colors ${
                f.fmt === currentFmt ? 'text-[#217346] font-semibold' : 'text-[#1a1a1a]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
