import React from 'react'
import type { CellData, CellStyle } from '@shared/xlsx-utils'
import { ColorPicker } from './color-picker'
import { NumFmtPicker } from './num-fmt-picker'

export function FormattingToolbar({ selectedCellData, dirtyStyle, onToggleBold, onToggleItalic, onToggleUnderline, onFontColor, onFillColor, onAlignment, onNumFmt }: {
  selectedCellData: CellData | null
  dirtyStyle?: CellStyle
  onToggleBold: () => void
  onToggleItalic: () => void
  onToggleUnderline: () => void
  onFontColor: (color: string) => void
  onFillColor: (color: string) => void
  onAlignment: (align: string) => void
  onNumFmt: (fmt: string) => void
}) {
  const style = selectedCellData?.style
  const isBold = dirtyStyle?.bold ?? style?.bold ?? false
  const isItalic = dirtyStyle?.italic ?? style?.italic ?? false
  const isUnderline = dirtyStyle?.underline ?? style?.underline ?? false
  const fontColor = dirtyStyle?.fontColor ?? style?.fontColor
  const fillColor = dirtyStyle?.fill ?? style?.fill
  const hAlign = dirtyStyle?.alignment?.horizontal ?? style?.alignment?.horizontal ?? 'left'
  const numFmt = dirtyStyle?.numFmt ?? selectedCellData?.numFmt

  const sep = () => <div className="w-px h-[18px] bg-[#d4d4d4] mx-0.5" />

  return (
    <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-[#d4d4d4] bg-[#f0f0f0]">
      {/* Bold */}
      <button
        onClick={onToggleBold}
        className={`h-[26px] w-[26px] rounded flex items-center justify-center transition-colors cursor-pointer ${
          isBold ? 'bg-[#d0d8e8] text-[#1a1a1a]' : 'hover:bg-[#e0e0e0] text-[#444]'
        }`}
        aria-label="Bold"
        title="Bold (Cmd+B)"
      >
        <span className="text-[12px] font-extrabold" style={{ fontFamily: 'serif' }}>B</span>
      </button>

      {/* Italic */}
      <button
        onClick={onToggleItalic}
        className={`h-[26px] w-[26px] rounded flex items-center justify-center transition-colors cursor-pointer ${
          isItalic ? 'bg-[#d0d8e8] text-[#1a1a1a]' : 'hover:bg-[#e0e0e0] text-[#444]'
        }`}
        aria-label="Italic"
        title="Italic (Cmd+I)"
      >
        <span className="text-[12px] font-semibold italic" style={{ fontFamily: 'serif' }}>I</span>
      </button>

      {/* Underline */}
      <button
        onClick={onToggleUnderline}
        className={`h-[26px] w-[26px] rounded flex items-center justify-center transition-colors cursor-pointer ${
          isUnderline ? 'bg-[#d0d8e8] text-[#1a1a1a]' : 'hover:bg-[#e0e0e0] text-[#444]'
        }`}
        aria-label="Underline"
        title="Underline (Cmd+U)"
      >
        <span className="text-[12px] font-semibold underline" style={{ fontFamily: 'serif' }}>U</span>
      </button>

      {sep()}

      {/* Text color */}
      <ColorPicker label="Text color" currentColor={fontColor} onSelect={onFontColor} />

      {/* Fill color */}
      <ColorPicker label="Fill color" currentColor={fillColor} onSelect={onFillColor} />

      {sep()}

      {/* Alignment */}
      <button
        onClick={() => onAlignment('left')}
        className={`h-[26px] w-[26px] rounded flex items-center justify-center transition-colors cursor-pointer ${
          hAlign === 'left' ? 'bg-[#d0d8e8]' : 'hover:bg-[#e0e0e0]'
        }`}
        aria-label="Align left"
        title="Align left"
      >
        <svg className="w-3.5 h-3.5 text-[#444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18M3 12h10M3 18h14" />
        </svg>
      </button>
      <button
        onClick={() => onAlignment('center')}
        className={`h-[26px] w-[26px] rounded flex items-center justify-center transition-colors cursor-pointer ${
          hAlign === 'center' ? 'bg-[#d0d8e8]' : 'hover:bg-[#e0e0e0]'
        }`}
        aria-label="Align center"
        title="Align center"
      >
        <svg className="w-3.5 h-3.5 text-[#444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18M7 12h10M5 18h14" />
        </svg>
      </button>
      <button
        onClick={() => onAlignment('right')}
        className={`h-[26px] w-[26px] rounded flex items-center justify-center transition-colors cursor-pointer ${
          hAlign === 'right' ? 'bg-[#d0d8e8]' : 'hover:bg-[#e0e0e0]'
        }`}
        aria-label="Align right"
        title="Align right"
      >
        <svg className="w-3.5 h-3.5 text-[#444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18M11 12h10M7 18h14" />
        </svg>
      </button>

      {sep()}

      {/* Number format */}
      <NumFmtPicker currentFmt={numFmt} onSelect={onNumFmt} />
    </div>
  )
}
