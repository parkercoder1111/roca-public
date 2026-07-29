import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Upload } from '@shared/types'
import { SpreadsheetEditor } from './spreadsheet-editor'
import { PresentationViewer } from './presentation-viewer'

interface Props {
  upload: Upload
  onBack: () => void
}

type PreviewState =
  | { type: 'loading' }
  | { type: 'image'; blobUrl: string }
  | { type: 'pdf'; filePath: string }
  | { type: 'html'; content: string }
  | { type: 'docx'; data: ArrayBuffer | Uint8Array }
  | { type: 'pptx' }
  | { type: 'xlsx' }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }

export function FilePreview({ upload, onBack }: Props) {
  const [preview, setPreview] = useState<PreviewState>({ type: 'loading' })
  const [refreshKey, setRefreshKey] = useState(0)
  const blobUrlRef = useRef<string | null>(null)
  const docxContainerRef = useRef<HTMLDivElement | null>(null)

  // DOCX-specific state
  const [docxZoom, setDocxZoom] = useState(100)
  const [docxSearchOpen, setDocxSearchOpen] = useState(false)
  const [docxSearchQuery, setDocxSearchQuery] = useState('')
  const [docxOutline, setDocxOutline] = useState<{ text: string; level: number; idx: number }[]>([])
  const [docxShowOutline, setDocxShowOutline] = useState(false)
  const docxSearchInputRef = useRef<HTMLInputElement>(null)
  const docxScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setPreview({ type: 'loading' })

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }

    async function load() {
      try {
        const mime = upload.mime_type || ''
        const name = upload.filename.toLowerCase()

        if (mime.startsWith('image/')) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          const blob = new Blob([data], { type: mime })
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          setPreview({ type: 'image', blobUrl: url })
          return
        }

        if (mime === 'application/pdf' || name.endsWith('.pdf')) {
          const result = await window.electronAPI.serveUploadPath(upload.stored_name)
          if (cancelled) return
          if (result?.path) {
            setPreview({ type: 'pdf', filePath: result.path })
          } else {
            setPreview({ type: 'error', message: 'PDF file not found' })
          }
          return
        }

        if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          || name.endsWith('.docx')) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          const buffer = data.buffer ? data.buffer : data
          setPreview({ type: 'docx', data: buffer })
          return
        }

        // PPT/PPTX — use dedicated PresentationViewer
        if (mime === 'application/vnd.ms-powerpoint'
          || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          || name.match(/\.pptx?$/)) {
          if (!cancelled) setPreview({ type: 'pptx' })
          return
        }

        if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          || mime === 'application/vnd.ms-excel'
          || name.endsWith('.xlsx') || name.endsWith('.xls')) {
          if (!cancelled) setPreview({ type: 'xlsx' })
          return
        }

        if (mime === 'text/csv' || name.endsWith('.csv')) {
          if (!cancelled) setPreview({ type: 'xlsx' })
          return
        }

        if (mime.startsWith('text/') || mime === 'application/json'
          || name.match(/\.(md|txt|json|js|ts|py|sh|yaml|yml|toml|cfg|ini|log)$/)) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          setPreview({ type: 'text', content: new TextDecoder().decode(data.buffer || data) })
          return
        }

        setPreview({ type: 'error', message: `Preview not available for ${mime || upload.filename}` })
      } catch (err: unknown) {
        if (!cancelled) {
          setPreview({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load preview' })
        }
      }
    }

    load()
    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [upload.id, upload.stored_name, refreshKey])

  // Render DOCX and extract headings for outline
  useEffect(() => {
    if (preview.type !== 'docx' || !docxContainerRef.current) return
    let cancelled = false

    async function render() {
      const docxPreview = await import('docx-preview')
      if (cancelled || !docxContainerRef.current) return
      if (preview.type !== 'docx') return
      docxContainerRef.current.innerHTML = ''
      await docxPreview.renderAsync(preview.data, docxContainerRef.current, undefined, {
        inWrapper: true,
        ignoreWidth: true,
        ignoreHeight: true,
        ignoreFonts: false,
        breakPages: false,
        ignoreLastRenderedPageBreak: true,
        experimental: true,
      })

      if (cancelled || !docxContainerRef.current) return

      // Extract headings for outline (store index, not live DOM ref)
      if (docxContainerRef.current) {
        const headings = docxContainerRef.current.querySelectorAll('h1, h2, h3, h4')
        const outline: { text: string; level: number; idx: number }[] = []
        let idx = 0
        headings.forEach(el => {
          const text = el.textContent?.trim()
          if (text) {
            const level = parseInt(el.tagName[1])
            outline.push({ text, level, idx })
          }
          idx++
        })
        setDocxOutline(outline)
      }
    }

    render().catch((err) => {
      if (!cancelled) {
        setPreview({ type: 'error', message: err.message || 'DOCX render failed' })
      }
    })

    return () => { cancelled = true }
  }, [preview])

  // DOCX search highlighting
  useEffect(() => {
    if (preview.type !== 'docx' || !docxContainerRef.current) return
    // Remove previous highlights
    docxContainerRef.current.querySelectorAll('.docx-search-highlight').forEach(el => {
      const parent = el.parentNode
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent || ''), el)
        parent.normalize()
      }
    })

    if (!docxSearchQuery || docxSearchQuery.length < 2) return

    // Walk text nodes and highlight matches — process one text node at a time
    // to avoid stale node references from surroundContents splitting nodes
    const query = docxSearchQuery.toLowerCase()
    let highlighted = false

    const walker = document.createTreeWalker(docxContainerRef.current, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let node: Text | null
    while ((node = walker.nextNode() as Text)) textNodes.push(node)

    for (const textNode of textNodes) {
      const text = textNode.textContent?.toLowerCase() || ''
      if (!text.includes(query)) continue

      // Find all match offsets in this single text node, process in reverse
      const offsets: number[] = []
      let idx = text.indexOf(query)
      while (idx !== -1) {
        offsets.push(idx)
        idx = text.indexOf(query, idx + 1)
      }

      // Apply in reverse so earlier offsets remain valid
      for (let i = offsets.length - 1; i >= 0; i--) {
        try {
          const range = document.createRange()
          range.setStart(textNode, offsets[i])
          range.setEnd(textNode, offsets[i] + docxSearchQuery.length)
          const highlight = document.createElement('mark')
          highlight.className = 'docx-search-highlight'
          highlight.style.cssText = 'background: #fbbf24; color: #1a1a1a; border-radius: 2px; padding: 0 1px;'
          range.surroundContents(highlight)
        } catch { /* skip if range is invalid */ }
      }
      highlighted = true
    }

    // Scroll to first match
    if (highlighted) {
      const first = docxContainerRef.current.querySelector('.docx-search-highlight')
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [docxSearchQuery, preview])

  // DOCX keyboard shortcut for search
  useEffect(() => {
    if (preview.type !== 'docx') return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setDocxSearchOpen(p => !p)
        setTimeout(() => docxSearchInputRef.current?.focus(), 50)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [preview.type])

  const scrollToHeading = useCallback((idx: number) => {
    if (!docxContainerRef.current) return
    const headings = docxContainerRef.current.querySelectorAll('h1, h2, h3, h4')
    const el = headings[idx]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  function openInFinder() {
    window.electronAPI.showItemInFolder(upload.stored_name)
  }

  // Route to dedicated viewers
  if (preview.type === 'xlsx') {
    return <SpreadsheetEditor upload={upload} onBack={onBack} />
  }
  if (preview.type === 'pptx') {
    return <PresentationViewer upload={upload} onBack={onBack} />
  }

  // DOCX viewer with search, zoom, outline
  if (preview.type === 'docx') {
    return (
      <div className="flex flex-col h-full bg-[#f5f5f5]">
        {/* Toolbar */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-black/[0.06] bg-surface-0">
          <button onClick={onBack} aria-label="Go back" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-6 h-6 rounded-md bg-blue-1/10 flex items-center justify-center shrink-0">
              <span className="text-[7px] font-bold text-blue-1 tracking-wider">DOC</span>
            </div>
            <span className="text-[11px] text-text-1 font-medium truncate">{upload.filename}</span>
          </div>

          {/* Zoom controls */}
          <div className="flex items-center gap-0.5 bg-black/[0.04] rounded-lg px-1">
            <button
              onClick={() => setDocxZoom(z => Math.max(50, z - 15))}
              aria-label="Zoom out"
              className="p-1 rounded text-text-3 hover:text-text-1 transition-colors cursor-pointer"
              title="Zoom out"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
            <button
              onClick={() => setDocxZoom(100)}
              className="text-[9px] font-medium text-text-2 px-1.5 py-0.5 rounded hover:bg-black/[0.04] cursor-pointer min-w-[36px] text-center"
              title="Reset zoom"
            >
              {docxZoom}%
            </button>
            <button
              onClick={() => setDocxZoom(z => Math.min(200, z + 15))}
              aria-label="Zoom in"
              className="p-1 rounded text-text-3 hover:text-text-1 transition-colors cursor-pointer"
              title="Zoom in"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {/* Outline toggle */}
          {docxOutline.length > 0 && (
            <button
              onClick={() => setDocxShowOutline(p => !p)}
              className={`p-1 rounded transition-colors cursor-pointer ${
                docxShowOutline ? 'bg-blue-1/10 text-blue-1' : 'text-text-3 hover:text-text-1 hover:bg-black/[0.06]'
              }`}
              aria-label="Table of contents"
              title="Table of contents"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h10" />
              </svg>
            </button>
          )}

          {/* Search toggle */}
          <button
            onClick={() => { setDocxSearchOpen(p => !p); setTimeout(() => docxSearchInputRef.current?.focus(), 50) }}
            className={`p-1 rounded transition-colors cursor-pointer ${
              docxSearchOpen ? 'bg-blue-1/10 text-blue-1' : 'text-text-3 hover:text-text-1 hover:bg-black/[0.06]'
            }`}
            aria-label="Search in document"
            title="Search (Cmd+F)"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>

          <button onClick={() => setRefreshKey(k => k + 1)} aria-label="Refresh" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer" title="Refresh">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button onClick={openInFinder} aria-label="Open in Finder" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer" title="Open in Finder">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
        </div>

        {/* Search bar */}
        {docxSearchOpen && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-black/[0.06] bg-surface-0">
            <svg className="w-3.5 h-3.5 text-text-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={docxSearchInputRef}
              className="flex-1 text-[11px] bg-white border border-black/[0.08] rounded-md px-2 py-1 outline-none focus:border-blue-1/50 focus:ring-1 focus:ring-blue-1/20"
              placeholder="Search in document..."
              value={docxSearchQuery}
              onChange={(e) => setDocxSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDocxSearchOpen(false)
                  setDocxSearchQuery('')
                }
              }}
            />
            {docxSearchQuery && (
              <button
                onClick={() => setDocxSearchQuery('')}
                aria-label="Clear search"
                className="p-0.5 rounded hover:bg-black/[0.06] text-text-3 cursor-pointer"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Content area with optional outline sidebar */}
        <div className="flex-1 flex overflow-hidden">
          {/* Outline sidebar */}
          {docxShowOutline && docxOutline.length > 0 && (
            <div className="w-[180px] shrink-0 overflow-y-auto border-r border-black/[0.06] bg-surface-0 py-2 px-2">
              <div className="text-[9px] uppercase tracking-wider text-text-3/50 font-semibold px-2 mb-2">Contents</div>
              {docxOutline.map((heading) => (
                <button
                  key={heading.idx}
                  onClick={() => scrollToHeading(heading.idx)}
                  className="w-full text-left px-2 py-1 rounded-md text-[10px] text-text-2 hover:bg-black/[0.04] hover:text-text-1 transition-colors cursor-pointer truncate leading-relaxed"
                  style={{ paddingLeft: `${(heading.level - 1) * 12 + 8}px` }}
                  title={heading.text}
                >
                  {heading.text}
                </button>
              ))}
            </div>
          )}

          {/* Document content */}
          <div ref={docxScrollRef} className="flex-1 overflow-auto">
            <div
              ref={docxContainerRef}
              className="docx-preview-container mx-auto"
              style={{
                transform: `scale(${docxZoom / 100})`,
                transformOrigin: 'top center',
                maxWidth: `${680 * (100 / docxZoom)}px`,
              }}
            />
          </div>
        </div>

        <style>{`
          .docx-preview-container .docx-wrapper { background: transparent !important; padding: 0 !important; }
          .docx-preview-container .docx-wrapper > section.docx {
            box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06) !important;
            margin: 16px auto !important;
            padding: 24px 28px !important;
            width: 100% !important;
            min-height: auto !important;
            font-size: 12px !important;
            background: white !important;
            border-radius: 6px !important;
          }
          .docx-preview-container .docx-wrapper > section.docx p { font-size: 12px !important; line-height: 1.6 !important; }
          .docx-preview-container .docx-wrapper > section.docx li { font-size: 12px !important; line-height: 1.6 !important; }
          .docx-preview-container .docx-wrapper > section.docx h1 { font-size: 20px !important; font-weight: 700 !important; margin-top: 1.2em !important; }
          .docx-preview-container .docx-wrapper > section.docx h2 { font-size: 16px !important; font-weight: 600 !important; margin-top: 1em !important; }
          .docx-preview-container .docx-wrapper > section.docx h3 { font-size: 14px !important; font-weight: 600 !important; }
          .docx-preview-container .docx-wrapper > section.docx table { border-collapse: collapse !important; }
          .docx-preview-container .docx-wrapper > section.docx td,
          .docx-preview-container .docx-wrapper > section.docx th { border: 1px solid #e0e0e0 !important; padding: 4px 8px !important; }
        `}</style>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-black/[0.06]">
        <button onClick={onBack} aria-label="Go back" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-[11px] text-text-1 font-medium truncate flex-1">{upload.filename}</span>
        <button onClick={() => setRefreshKey(k => k + 1)} aria-label="Refresh preview" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer" title="Refresh preview">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        <button onClick={openInFinder} aria-label="Open in Finder" className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer" title="Open in Finder">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {preview.type === 'loading' && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-8 h-8 rounded-xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center">
              <svg className="w-4 h-4 text-text-3/40 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <span className="text-[10px] text-text-3/60">Loading preview</span>
          </div>
        )}

        {preview.type === 'error' && (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
            <div className="w-10 h-10 rounded-xl bg-red-1/8 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-1/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span className="text-[11px] text-text-2 text-center leading-relaxed">{preview.message}</span>
            <button onClick={openInFinder} className="text-[10px] font-medium px-4 py-1.5 rounded-lg bg-black/[0.05] text-text-2 hover:bg-black/[0.08] transition-colors cursor-pointer">
              Open in Finder
            </button>
          </div>
        )}

        {preview.type === 'image' && (
          <img src={preview.blobUrl} alt={upload.filename} className="max-w-full rounded-lg" />
        )}

        {preview.type === 'pdf' && (
          <webview
            src={`file://${preview.filePath}`}
            className="w-full h-full"
            allowpopups
          />
        )}

        {preview.type === 'html' && (
          <div className="workbook-content max-w-[680px] mx-auto" dangerouslySetInnerHTML={{ __html: preview.content }} />
        )}

        {preview.type === 'text' && (
          <pre className="text-[11px] text-text-2 font-mono whitespace-pre-wrap break-words leading-relaxed">
            {preview.content}
          </pre>
        )}
      </div>
    </div>
  )
}
