// src/renderer/components/optical-view/chat-input/slash-autocomplete.tsx
//
// Floating dropdown above the chat textarea that surfaces matching ROCA
// slash commands while the user is typing a "/foo" prefix. The parent
// (chat-input/index.tsx) owns the textarea + selection state and feeds the
// filtered options + the index of the highlighted row in. We just render.
import React from 'react'

export interface SlashOption {
  command: string
  description: string
}

interface Props {
  options: SlashOption[]
  selectedIndex: number
  onSelect: (option: SlashOption) => void
}

export function SlashAutocomplete({ options, selectedIndex, onSelect }: Props) {
  if (options.length === 0) return null

  return (
    <div className="absolute left-0 right-0 bottom-full mb-1 z-10 rounded-lg bg-surface-1 hairline shadow-lg overflow-hidden">
      {options.map((opt, i) => (
        <button
          key={opt.command}
          type="button"
          onMouseDown={(e) => {
            // onMouseDown (not onClick) so we fire before the textarea blur
            // strips focus + remounts the dropdown.
            e.preventDefault()
            onSelect(opt)
          }}
          className={`w-full flex items-baseline gap-2 px-3 py-1.5 text-left text-[12px] ${
            i === selectedIndex ? 'bg-surface-2 text-text-1' : 'text-text-2 hover:bg-surface-2'
          }`}
        >
          <span className="font-mono font-medium shrink-0">/{opt.command}</span>
          <span className="text-text-3 text-[11px] truncate">{opt.description}</span>
        </button>
      ))}
    </div>
  )
}
