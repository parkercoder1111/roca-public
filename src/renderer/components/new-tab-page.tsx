import React, { useMemo, useRef, useState } from 'react'
import type { WebviewToolSpec } from '../lib/webview-tools'

interface Props {
  preloadedTools: WebviewToolSpec[]
  customTools: WebviewToolSpec[]
  onPickKind: (kind: string) => void
  onAddCustomTool: (url: string, label?: string) => void
}

function ToolFavicon({ src }: { src: string | undefined }) {
  const [err, setErr] = useState(false)
  if (!src || err) {
    return (
      <div className="w-11 h-11 rounded-[12px] bg-surface-2 flex items-center justify-center ring-1 ring-black/[0.05]">
        <svg className="w-5 h-5 text-text-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" strokeWidth={1.4} />
          <path strokeLinecap="round" strokeWidth={1.4} d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
        </svg>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt=""
      // Squircle-ish tile with a soft Apple-OS shadow.
      className="w-11 h-11 rounded-[12px] object-contain bg-white shadow-[0_2px_6px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.04]"
      onError={() => setErr(true)}
      draggable={false}
    />
  )
}

function AppTile({ tool, onClick }: { tool: WebviewToolSpec; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group relative flex flex-col items-center justify-start gap-3 px-4 pt-5 pb-4 rounded-2xl bg-surface-0/70 backdrop-blur-md ring-1 ring-black/[0.05] hover:ring-black/[0.10] hover:bg-surface-0 hover:-translate-y-[2px] hover:shadow-[0_10px_30px_-8px_rgba(0,0,0,0.12)] active:scale-[0.98] transition-[transform,box-shadow,background-color,border-color] duration-200 ease-out"
      title={tool.hint}
    >
      <ToolFavicon src={tool.iconUrl} />
      <div className="flex flex-col items-center gap-0.5 min-w-0 w-full">
        <div className="text-[12px] font-semibold text-text-1 tracking-tight text-center leading-tight truncate w-full">
          {tool.label}
        </div>
        <div className="text-[10px] text-text-3 truncate w-full text-center">
          {tool.hint}
        </div>
      </div>
    </button>
  )
}

export function NewTabPage({ preloadedTools, customTools, onPickKind, onAddCustomTool }: Props) {
  const [showAdd, setShowAdd] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 'google' kind is used as a default landing page elsewhere; expose it here too
  // so people can click into an empty Google tab without typing.
  const featured = useMemo(() => preloadedTools, [preloadedTools])

  const submitCustom = () => {
    const v = customUrl.trim()
    if (!v) return
    onAddCustomTool(v)
    setCustomUrl('')
    setShowAdd(false)
  }

  return (
    <div className="relative flex-1 overflow-y-auto bg-surface-0">
      {/* Soft ambient gradient — Apple's "wallpaper behind glass" feel without
          competing with content. Two subtle radial pools + a vertical wash. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(900px 500px at 15% 0%, color-mix(in srgb, var(--color-purple-1) 5%, transparent), transparent 60%),' +
            'radial-gradient(700px 400px at 100% 100%, color-mix(in srgb, var(--color-purple-1) 3%, transparent), transparent 55%),' +
            'linear-gradient(to bottom, transparent, color-mix(in srgb, var(--color-surface-1) 40%, transparent))',
        }}
      />

      <div className="relative max-w-[960px] mx-auto px-8 pt-20 pb-24">
        {/* Greeting */}
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-purple-2 text-purple-1 text-[9.5px] font-semibold tracking-[0.14em] uppercase mb-5">
            <span className="w-1 h-1 rounded-full bg-purple-1" />
            New Tab
          </div>
          <h1 className="text-[34px] font-semibold text-text-1 tracking-[-0.02em] leading-[1.1]">
            Where to next?
          </h1>
          <p className="text-[13px] text-text-3 mt-3 tracking-tight">
            Type a URL above, or jump into one of your tools.
          </p>
        </div>

        {/* Featured / Open a tool */}
        <Section title="Open a tool">
          <ToolGrid>
            {featured.map(tool => (
              <AppTile key={tool.kind} tool={tool} onClick={() => onPickKind(tool.kind)} />
            ))}
          </ToolGrid>
        </Section>

        {/* Your apps (custom tools) */}
        {customTools.length > 0 && (
          <Section title="Your apps">
            <ToolGrid>
              {customTools.map(tool => (
                <AppTile key={tool.kind} tool={tool} onClick={() => onPickKind(tool.kind)} />
              ))}
            </ToolGrid>
          </Section>
        )}

        {/* Add a custom app */}
        <Section title="Add a web app" last>
          {!showAdd ? (
            <button
              onClick={() => {
                setShowAdd(true)
                setTimeout(() => inputRef.current?.focus(), 0)
              }}
              className="w-full flex items-center justify-center gap-2 py-5 rounded-2xl border border-dashed border-black/[0.10] text-text-3 hover:text-text-1 hover:bg-surface-0/80 hover:border-black/[0.20] transition-all duration-200"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-[12px] font-medium tracking-tight">Pin any site as an app</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 p-2 rounded-2xl bg-surface-0 ring-1 ring-purple-1/30 shadow-[0_0_0_4px_var(--color-purple-2)]">
              <input
                ref={inputRef}
                type="text"
                placeholder="notion.so, linkedin.com, …"
                value={customUrl}
                onChange={e => setCustomUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); submitCustom() }
                  if (e.key === 'Escape') { setShowAdd(false); setCustomUrl('') }
                }}
                className="flex-1 px-3 py-1.5 bg-transparent text-[12.5px] text-text-1 placeholder:text-text-3 focus:outline-none"
              />
              <button
                onClick={submitCustom}
                disabled={!customUrl.trim()}
                className="px-3 py-1.5 text-[11.5px] font-semibold rounded-xl bg-purple-1 text-[color:var(--color-paper-cream)] hover:bg-purple-1/90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                Pin
              </button>
              <button
                onClick={() => { setShowAdd(false); setCustomUrl('') }}
                className="px-2 py-1.5 text-[11.5px] text-text-3 hover:text-text-1 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={last ? '' : 'mb-12'}>
      <div className="flex items-baseline justify-between mb-4 px-1">
        <h2 className="text-[10px] uppercase tracking-[0.16em] font-semibold text-text-3">
          {title}
        </h2>
      </div>
      {children}
    </div>
  )
}

function ToolGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {children}
    </div>
  )
}
