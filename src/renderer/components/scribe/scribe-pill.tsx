import { useEffect, useState } from 'react'

// The floating recording pill (renders in its own always-on-top window).
// Only visible while recording, so it just shows a steady recording animation —
// no "saving" churn from the invisible mid-recording transcription passes.
export function ScribePill() {
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    // Frameless transparent window — clear inherited backgrounds.
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])

  const stop = () => {
    // Feel instant: dim immediately; the window closes right after.
    setStopping(true)
    window.electronAPI.scribe.stop()
  }
  const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  return (
    <div style={drag} className="w-full h-full flex items-center justify-center">
      <style>{`@keyframes scribePulse{0%,100%{opacity:.35;transform:scaleY(.55)}50%{opacity:1;transform:scaleY(1)}}`}</style>
      <div
        className="flex items-center gap-2.5 rounded-2xl px-3.5 py-2 shadow-lg select-none transition-opacity"
        style={{ background: '#2b2b2d', opacity: stopping ? 0.4 : 1 }}
      >
        {/* orb */}
        <svg className="w-5 h-5 text-white/90" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <circle cx="12" cy="12" r="7" strokeWidth="1.4" />
          <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
        </svg>

        {/* live level bars — part of the drag handle, not click targets */}
        <div className="flex items-center gap-1 h-4">
          {[0, 140, 280].map((d) => (
            <span
              key={d}
              className="w-1.5 h-3 rounded-full bg-green-400"
              style={{ animation: 'scribePulse 1s ease-in-out infinite', animationDelay: `${d}ms` }}
            />
          ))}
        </div>

        {/* stop */}
        <button
          onClick={stop}
          style={noDrag}
          title="Stop recording"
          className="ml-0.5 w-6 h-6 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center"
        >
          <span className="w-2.5 h-2.5 bg-white rounded-[3px]" />
        </button>
      </div>
    </div>
  )
}
