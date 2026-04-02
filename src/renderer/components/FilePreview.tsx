import React, { useState, useEffect, useRef } from 'react'
import type { Upload } from '@shared/types'

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
  | { type: 'xlsx'; sheets: { name: string; html: string }[] }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }

// Sanitize HTML from untrusted sources (XLSX) — strips scripts and event handlers
function sanitizeHtml(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style[type="text/javascript"]').forEach(el => el.remove())
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name)
      if (attr.name === 'href' && attr.value.toLowerCase().trimStart().startsWith('javascript:')) el.removeAttribute(attr.name)
      if (attr.name === 'src' && attr.value.toLowerCase().trimStart().startsWith('javascript:')) el.removeAttribute(attr.name)
    })
  })
  return doc.body?.innerHTML || ''
}

export default function FilePreview({ upload, onBack }: Props) {
  const [preview, setPreview] = useState<PreviewState>({ type: 'loading' })
  const [activeSheet, setActiveSheet] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const blobUrlRef = useRef<string | null>(null)
  const docxContainerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setPreview({ type: 'loading' })
    setActiveSheet(0)

    // Revoke previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }

    async function load() {
      try {
        const mime = upload.mime_type || ''
        const name = upload.filename.toLowerCase()

        // Images
        if (mime.startsWith('image/')) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          const blob = new Blob([data], { type: mime })
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          setPreview({ type: 'image', blobUrl: url })
          return
        }

        // PDF
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

        // DOCX — render with docx-preview (faithful formatting)
        if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          || name.endsWith('.docx')) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          const buffer = data.buffer ? data.buffer : data
          setPreview({ type: 'docx', data: buffer })
          return
        }

        // PPT/PPTX
        if (mime === 'application/vnd.ms-powerpoint'
          || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          || name.match(/\.pptx?$/)) {
          const pdfResult = await window.electronAPI.convertUploadToPdf(upload.stored_name)
          if (cancelled) return
          if (pdfResult?.path) {
            setPreview({ type: 'pdf', filePath: pdfResult.path })
            return
          }
          setPreview({ type: 'error', message: pdfResult?.error || 'Could not convert presentation' })
          return
        }

        // XLSX / XLS
        if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          || mime === 'application/vnd.ms-excel'
          || name.endsWith('.xlsx') || name.endsWith('.xls')) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          try {
            const XLSX = await import('xlsx')
            const raw = data.buffer ? new Uint8Array(data.buffer) : new Uint8Array(data)
            const wb = XLSX.read(raw, { type: 'array', cellStyles: false, cellFormula: false })
            const sheets = wb.SheetNames
              .filter(n => wb.Sheets[n])
              .map(n => {
                try {
                  return {
                    name: n,
                    html: sanitizeHtml(XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' })),
                  }
                } catch {
                  return { name: n, html: `<p style="color:#999">Could not render sheet "${n}"</p>` }
                }
              })
            if (cancelled) return
            setPreview({ type: 'xlsx', sheets })
          } catch (xlsxErr: any) {
            if (!cancelled) {
              setPreview({ type: 'error', message: `Excel parse error: ${xlsxErr.message || 'unknown'}` })
            }
          }
          return
        }

        // CSV
        if (mime === 'text/csv' || name.endsWith('.csv')) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          const text = new TextDecoder().decode(data.buffer || data)
          const rows = text.split('\n').filter(r => r.trim()).map(r => r.split(','))
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
          let html = '<table>'
          rows.forEach((row, i) => {
            html += '<tr>'
            row.forEach(cell => {
              const safe = esc(cell.trim())
              html += i === 0 ? `<th>${safe}</th>` : `<td>${safe}</td>`
            })
            html += '</tr>'
          })
          html += '</table>'
          setPreview({ type: 'html', content: html })
          return
        }

        // Text / Code
        if (mime.startsWith('text/') || mime === 'application/json'
          || name.match(/\.(md|txt|json|js|ts|py|sh|yaml|yml|toml|cfg|ini|log)$/)) {
          const data = await window.electronAPI.serveUpload(upload.stored_name)
          if (cancelled || !data) return
          setPreview({ type: 'text', content: new TextDecoder().decode(data.buffer || data) })
          return
        }

        setPreview({ type: 'error', message: `Preview not available for ${mime || upload.filename}` })
      } catch (err: any) {
        if (!cancelled) {
          setPreview({ type: 'error', message: err.message || 'Failed to load preview' })
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

  // Render DOCX into container using docx-preview
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
      } as any)
    }

    render().catch((err) => {
      if (!cancelled) {
        setPreview({ type: 'error', message: err.message || 'DOCX render failed' })
      }
    })

    return () => { cancelled = true }
  }, [preview])

  function openInFinder() {
    window.electronAPI.showItemInFolder(upload.stored_name)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-black/[0.06]">
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-[11px] text-text-1 font-medium truncate flex-1">{upload.filename}</span>
        <button
          onClick={() => setRefreshKey(k => k + 1)}
          className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
          title="Refresh preview"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        <button
          onClick={openInFinder}
          className="p-1 rounded hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
          title="Open in Finder"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
      </div>
      <style>{`
        .workbook-content { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; background: #fff; }
        .workbook-content table { border-collapse: collapse; table-layout: auto; }
        .workbook-content th, .workbook-content td {
          border: 1px solid #d4d4d4;
          padding: 1px 5px;
          text-align: left;
          font-size: 11px;
          line-height: 18px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 200px;
          font-family: 'Calibri', -apple-system, sans-serif;
          color: #1a1a1a;
        }
        .workbook-content tr:first-child td,
        .workbook-content tr:first-child th,
        .workbook-content thead th {
          background: #e8e8e8;
          font-weight: 600;
          color: #333;
          font-size: 10px;
          text-align: center;
          position: sticky;
          top: 0;
          z-index: 1;
        }
        .workbook-content td:first-child {
          background: #f0f0f0;
          font-weight: 500;
          color: #444;
          min-width: 40px;
          text-align: left;
          position: sticky;
          left: 0;
          z-index: 0;
        }
        .workbook-content tr:first-child td:first-child {
          z-index: 2;
        }
        .workbook-content tr:hover td {
          background-color: #e8f0fe;
        }
        .workbook-content tr:hover td:first-child {
          background-color: #d6e4f7;
        }
        .workbook-content td:empty { background: #fafafa; }
        .docx-preview-container .docx-wrapper { background: transparent !important; padding: 0 !important; }
        .docx-preview-container .docx-wrapper > section.docx { box-shadow: none !important; margin: 0 !important; padding: 16px 20px !important; width: 100% !important; min-height: auto !important; font-size: 12px !important; }
        .docx-preview-container .docx-wrapper > section.docx p { font-size: 12px !important; line-height: 1.5 !important; }
        .docx-preview-container .docx-wrapper > section.docx li { font-size: 12px !important; line-height: 1.5 !important; }
        .docx-preview-container .docx-wrapper > section.docx h1 { font-size: 18px !important; }
        .docx-preview-container .docx-wrapper > section.docx h2 { font-size: 15px !important; }
        .docx-preview-container .docx-wrapper > section.docx h3 { font-size: 13px !important; }
      `}</style>

      {/* Content */}
      <div className={`flex-1 overflow-auto ${preview.type === 'xlsx' ? 'p-0' : 'p-4'}`}>
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
            <button
              onClick={openInFinder}
              className="text-[10px] font-medium px-4 py-1.5 rounded-lg bg-black/[0.05] text-text-2 hover:bg-black/[0.08] transition-colors cursor-pointer"
            >
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
            {...{ allowpopups: '' } as any}
          />
        )}

        {preview.type === 'docx' && (
          <div ref={docxContainerRef} className="docx-preview-container" />
        )}

        {preview.type === 'xlsx' && (
          <div className="flex flex-col h-full bg-white">
            <div
              className="workbook-content overflow-auto flex-1"
              dangerouslySetInnerHTML={{ __html: preview.sheets[activeSheet]?.html || '' }}
            />
            {preview.sheets.length > 1 && (
              <div className="shrink-0 flex border-t border-[#b0b0b0] bg-[#e8e8e8] overflow-x-auto">
                {preview.sheets.map((sheet, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveSheet(i)}
                    className={`px-3 py-1.5 text-[10px] font-medium cursor-pointer border-r border-[#c0c0c0] whitespace-nowrap ${
                      i === activeSheet
                        ? 'bg-white text-[#1a1a1a] border-b-2 border-b-[#217346]'
                        : 'text-[#555] hover:bg-[#f0f0f0]'
                    }`}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {preview.type === 'html' && (
          <div
            className="workbook-content max-w-[680px] mx-auto"
            dangerouslySetInnerHTML={{ __html: preview.content }}
          />
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
