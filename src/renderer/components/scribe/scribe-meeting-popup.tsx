import { useEffect, useState } from 'react'
import type { CalEvent } from './types'

// "Start note taker" prompt — fires (anywhere in ROCA) when a calendar meeting
// is about to start. Mounted once at the app level.
export function ScribeMeetingPopup() {
  const [event, setEvent] = useState<CalEvent | null>(null)

  useEffect(() => window.electronAPI.scribe.onMeetingStarting((e) => setEvent(e)), [])

  if (!event) return null

  const start = async () => {
    await window.electronAPI.scribe.start(event.title, event.id)
    setEvent(null)
  }

  return (
    <div className="fixed bottom-6 right-6 z-[100] w-80 rounded-xl bg-surface-2 shadow-2xl border border-black/[0.08] p-4">
      <div className="text-text-3 text-xs mb-1">Meeting starting</div>
      <div className="text-text-1 font-medium mb-3 truncate">{event.title}</div>
      <div className="flex gap-2">
        <button
          onClick={start}
          className="flex-1 rounded-md bg-purple-1 text-white py-2 text-sm font-medium"
        >
          Start note taker
        </button>
        <button
          onClick={() => setEvent(null)}
          className="rounded-md border border-black/[0.1] px-3 py-2 text-sm text-text-2"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
