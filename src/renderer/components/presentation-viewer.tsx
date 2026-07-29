import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { Upload } from '@shared/types'

interface Props {
  upload: Upload
  onBack: () => void
}

type ViewerState =
  | { type: 'loading'; message: string }
  | { type: 'slides'; paths: string[]; notes: string[] }
  | { type: 'pdf'; path: string }
  | { type: 'error'; message: string }

export function PresentationViewer({ upload, onBack }: Props) {
  const [state, setState] = useState<ViewerState>({ type: 'loading', message: 'Converting slides...' })
  const [currentSlide, setCurrentSlide] = useState(0)
  const [showNotes, setShowNotes] = useState(false)
  const [showThumbnails, setShowThumbnails] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        // Try slide-by-slide conversion first
        const result = await window.electronAPI.convertPptxToSlides(upload.stored_name)
        if (cancelled) return

        if (result.error) {
          // Fallback to PDF conversion
          const pdfResult = await window.electronAPI.convertUploadToPdf(upload.stored_name)
          if (cancelled) return
          if (pdfResult?.path) {
            setState({ type: 'pdf', path: pdfResult.path })
          } else {
            setState({ type: 'error', message: result.error })
          }
          return
        }

        if (result.pdf) {
          setState({ type: 'pdf', path: result.pdf })
          return
        }

        if (result.slides && result.slides.length > 0) {
          // Also fetch notes
          const notesResult = await window.electronAPI.getPptxNotes(upload.stored_name)
          if (cancelled) return
          setState({ type: 'slides', paths: result.slides, notes: notesResult.notes || [] })
        } else {
          setState({ type: 'error', message: 'No slides found in presentation' })
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setState({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load presentation' })
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [upload.stored_name])

  const totalSlides = state.type === 'slides' ? state.paths.length : 0

  const goTo = useCallback((idx: number) => {
    setCurrentSlide(Math.max(0, Math.min(idx, totalSlides - 1)))
  }, [totalSlides])

  const goNext = useCallback(() => goTo(currentSlide + 1), [currentSlide, goTo])
  const goPrev = useCallback(() => goTo(currentSlide - 1), [currentSlide, goTo])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (state.type !== 'slides') return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPrev() }
      if (e.key === 'Home') { e.preventDefault(); goTo(0) }
      if (e.key === 'End') { e.preventDefault(); goTo(totalSlides - 1) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [state, goNext, goPrev, goTo, totalSlides])

  // PDF fallback
  if (state.type === 'pdf') {
    return (
      <div className="flex flex-col h-full bg-[#1e1e1e]">
        <Toolbar upload={upload} onBack={onBack} />
        <div className="flex-1">
          <webview
            src={`file://${state.path}`}
            className="w-full h-full"
            allowpopups
          />
        </div>
      </div>
    )
  }

  // Loading
  if (state.type === 'loading') {
    return (
      <div className="flex flex-col h-full bg-[#1e1e1e]">
        <Toolbar upload={upload} onBack={onBack} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-2xl bg-white/[0.06] border border-white/[0.08] flex items-center justify-center">
              <svg className="w-5 h-5 text-white/30 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <span className="text-[11px] text-white/40">{state.message}</span>
          </div>
        </div>
      </div>
    )
  }

  // Error
  if (state.type === 'error') {
    return (
      <div className="flex flex-col h-full bg-[#1e1e1e]">
        <Toolbar upload={upload} onBack={onBack} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 px-8">
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-400/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span className="text-[12px] text-white/60 text-center leading-relaxed max-w-[300px]">{state.message}</span>
            <button
              onClick={() => window.electronAPI.showItemInFolder(upload.stored_name)}
              className="text-[10px] font-medium px-4 py-2 rounded-lg bg-white/[0.08] text-white/70 hover:bg-white/[0.12] transition-colors cursor-pointer"
            >
              Open in Finder
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Slide viewer
  const currentNotes = state.notes[currentSlide] || ''

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-[#1e1e1e]" tabIndex={0}>
      {/* Top toolbar */}
      <Toolbar
        upload={upload}
        onBack={onBack}
        slideInfo={`${currentSlide + 1} / ${totalSlides}`}
        showThumbnails={showThumbnails}
        onToggleThumbnails={() => setShowThumbnails(p => !p)}
        hasNotes={state.notes.some(n => n.length > 0)}
        showNotes={showNotes}
        onToggleNotes={() => setShowNotes(p => !p)}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Thumbnail strip */}
        {showThumbnails && (
          <div className="w-[120px] shrink-0 overflow-y-auto border-r border-white/[0.06] bg-[#171717] py-2 px-2 space-y-2">
            {state.paths.map((slidePath, i) => (
              <button
                key={slidePath}
                onClick={() => goTo(i)}
                className={`w-full rounded-lg overflow-hidden transition-all cursor-pointer group relative ${
                  i === currentSlide
                    ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-[#171717]'
                    : 'opacity-60 hover:opacity-90'
                }`}
              >
                <img
                  src={`file://${slidePath}`}
                  alt={`Slide ${i + 1}`}
                  className="w-full aspect-[16/9] object-cover bg-white"
                  loading="lazy"
                />
                <div className={`absolute bottom-0 left-0 right-0 py-0.5 text-center text-[8px] font-bold ${
                  i === currentSlide ? 'bg-blue-500 text-white' : 'bg-black/60 text-white/70'
                }`}>
                  {i + 1}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Main slide area */}
        <div className="flex-1 flex flex-col">
          <div className="flex-1 flex items-center justify-center p-6 relative">
            {/* Previous button */}
            <button
              onClick={goPrev}
              disabled={currentSlide === 0}
              aria-label="Previous slide"
              className="absolute left-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/[0.08] hover:bg-white/[0.15] disabled:opacity-20 disabled:cursor-default flex items-center justify-center transition-all cursor-pointer z-10"
            >
              <svg className="w-4 h-4 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {/* Slide image */}
            <img
              src={`file://${state.paths[currentSlide]}`}
              alt={`Slide ${currentSlide + 1}`}
              className="max-w-full max-h-full rounded-lg shadow-2xl shadow-black/40 object-contain"
              style={{ aspectRatio: '16/9' }}
            />

            {/* Next button */}
            <button
              onClick={goNext}
              disabled={currentSlide === totalSlides - 1}
              aria-label="Next slide"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/[0.08] hover:bg-white/[0.15] disabled:opacity-20 disabled:cursor-default flex items-center justify-center transition-all cursor-pointer z-10"
            >
              <svg className="w-4 h-4 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Speaker notes panel */}
          {showNotes && currentNotes && (
            <div className="shrink-0 border-t border-white/[0.06] bg-[#171717] px-4 py-3 max-h-[120px] overflow-y-auto">
              <div className="text-[9px] uppercase tracking-wider text-white/30 font-semibold mb-1.5">Speaker Notes</div>
              <p className="text-[11px] text-white/60 leading-relaxed whitespace-pre-wrap">{currentNotes}</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom navigation bar */}
      <div className="shrink-0 flex items-center justify-center gap-3 py-2 border-t border-white/[0.06] bg-[#141414]">
        <button
          onClick={() => goTo(0)}
          disabled={currentSlide === 0}
          aria-label="First slide"
          className="p-1 rounded text-white/40 hover:text-white/80 disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
          title="First slide"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={goPrev}
          disabled={currentSlide === 0}
          aria-label="Previous slide"
          className="p-1 rounded text-white/40 hover:text-white/80 disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-[11px] text-white/50 font-medium tabular-nums min-w-[60px] text-center">
          {currentSlide + 1} / {totalSlides}
        </span>
        <button
          onClick={goNext}
          disabled={currentSlide === totalSlides - 1}
          aria-label="Next slide"
          className="p-1 rounded text-white/40 hover:text-white/80 disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={() => goTo(totalSlides - 1)}
          disabled={currentSlide === totalSlides - 1}
          aria-label="Last slide"
          className="p-1 rounded text-white/40 hover:text-white/80 disabled:opacity-20 transition-colors cursor-pointer disabled:cursor-default"
          title="Last slide"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// ── Toolbar sub-component ──

function Toolbar({ upload, onBack, slideInfo, showThumbnails, onToggleThumbnails, hasNotes, showNotes, onToggleNotes }: {
  upload: Upload
  onBack: () => void
  slideInfo?: string
  showThumbnails?: boolean
  onToggleThumbnails?: () => void
  hasNotes?: boolean
  showNotes?: boolean
  onToggleNotes?: () => void
}) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] bg-[#1a1a1a]">
      <button
        onClick={onBack}
        aria-label="Back"
        className="p-1 rounded hover:bg-white/[0.08] text-white/40 hover:text-white/80 transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="w-6 h-6 rounded-md bg-amber-400/15 flex items-center justify-center shrink-0">
          <span className="text-[7px] font-bold text-amber-400 tracking-wider">PPT</span>
        </div>
        <span className="text-[11px] text-white/80 font-medium truncate">{upload.filename}</span>
      </div>

      {slideInfo && (
        <span className="text-[10px] text-white/30 font-medium tabular-nums">{slideInfo}</span>
      )}

      {onToggleThumbnails && (
        <button
          onClick={onToggleThumbnails}
          className={`p-1 rounded transition-colors cursor-pointer ${
            showThumbnails ? 'bg-white/[0.1] text-white/70' : 'text-white/30 hover:text-white/60 hover:bg-white/[0.06]'
          }`}
          aria-label="Toggle thumbnails"
          title="Toggle thumbnails"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
        </button>
      )}

      {hasNotes && onToggleNotes && (
        <button
          onClick={onToggleNotes}
          className={`p-1 rounded transition-colors cursor-pointer ${
            showNotes ? 'bg-white/[0.1] text-white/70' : 'text-white/30 hover:text-white/60 hover:bg-white/[0.06]'
          }`}
          aria-label="Toggle speaker notes"
          title="Toggle speaker notes"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </button>
      )}

      <button
        onClick={() => window.electronAPI.showItemInFolder(upload.stored_name)}
        className="p-1 rounded hover:bg-white/[0.08] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
        aria-label="Open in Finder"
        title="Open in Finder"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </button>
    </div>
  )
}
