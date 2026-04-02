import React, { useState, useRef, useCallback } from 'react'
import type { Upload } from '@shared/types'
import FilePreview from './FilePreview'
import { uploadFiles } from '../uploadFiles'
import { formatDate } from '../lib/formatDate'

interface Props {
  taskId: number
  uploads: Upload[]
  onUploadAdded: () => void
  onClose: () => void
}

const TYPE_ICONS: Record<string, { color: string; ext: string }> = {
  image: { color: 'bg-purple-1/10 text-purple-1', ext: 'IMG' },
  pdf:   { color: 'bg-red-1/10 text-red-1', ext: 'PDF' },
  docx:  { color: 'bg-blue-1/10 text-blue-1', ext: 'DOC' },
  xlsx:  { color: 'bg-green-1/10 text-green-1', ext: 'XLS' },
  csv:   { color: 'bg-green-1/10 text-green-1', ext: 'CSV' },
  ppt:   { color: 'bg-amber-400/10 text-amber-400', ext: 'PPT' },
  text:  { color: 'bg-black/[0.04] text-text-3', ext: 'TXT' },
}

const LIST_WIDTH = 280
const PREVIEW_WIDTH = 500
const MIN_WIDTH = 240
const MAX_WIDTH = 2000

function getFileCategory(upload: Upload): string {
  const mime = upload.mime_type || ''
  const name = upload.filename.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (name.endsWith('.docx') || mime.includes('wordprocessingml')) return 'docx'
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || mime.includes('spreadsheetml') || mime.includes('ms-excel')) return 'xlsx'
  if (name.endsWith('.csv') || mime === 'text/csv') return 'csv'
  if (name.match(/\.pptx?$/) || mime === 'application/vnd.ms-powerpoint' || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'ppt'
  return 'text'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileIcon({ category }: { category: string }) {
  const config = TYPE_ICONS[category] || TYPE_ICONS.text
  return (
    <div className={`w-8 h-8 rounded-lg ${config.color} flex items-center justify-center shrink-0`}>
      <span className="text-[8px] font-bold tracking-wider">{config.ext}</span>
    </div>
  )
}

export default function FileSidebar({ taskId, uploads, onUploadAdded, onClose }: Props) {
  const [previewUpload, setPreviewUpload] = useState<Upload | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('roca:fileSidebarWidth')
    return saved ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parseInt(saved, 10))) : LIST_WIDTH
  })
  const listWidthRef = useRef(width)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounter = useRef(0)
  const isResizing = useRef(false)
  const widthRef = useRef(width)
  widthRef.current = width
  const isPreviewModeRef = useRef(false)
  isPreviewModeRef.current = previewUpload !== null

  // Resize drag handle
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = widthRef.current

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      // Dragging left = wider sidebar (sidebar is on the right)
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - e.clientX)))
      setWidth(newWidth)
    }
    const onMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem('roca:fileSidebarWidth', String(widthRef.current))
      // Only save as list width when not in preview mode
      if (!isPreviewModeRef.current) {
        listWidthRef.current = widthRef.current
      }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  function handleOpenPreview(upload: Upload) {
    setPreviewUpload(upload)
    listWidthRef.current = width  // always save current before expanding
    if (width < PREVIEW_WIDTH) setWidth(PREVIEW_WIDTH)
  }

  function handleClosePreview() {
    setPreviewUpload(null)
    setWidth(listWidthRef.current)
  }

  async function handleAddFiles(files: FileList | File[]) {
    try {
      await uploadFiles(taskId, Array.from(files))
      onUploadAdded()
    } catch (err) {
      console.error('[FileSidebar] upload failed:', err)
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) {
      handleAddFiles(e.target.files)
      e.target.value = ''
    }
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current++
    setIsDragOver(true)
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragOver(false) }
  }
  function handleDragOver(e: React.DragEvent) { e.preventDefault() }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)
    if (e.dataTransfer.files.length) handleAddFiles(e.dataTransfer.files)
  }

  async function handleDelete(uploadId: number, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await window.electronAPI.deleteUpload(uploadId)
      onUploadAdded()
    } catch (err) {
      console.error('Failed to delete upload:', err)
    }
  }

  // Preview mode
  if (previewUpload) {
    return (
      <div className="relative shrink-0 bg-surface-0 border-l border-black/[0.06] flex flex-col h-full" style={{ width }}>
        {/* Resize drag handle (left edge) */}
        <div
          className="absolute top-0 left-0 w-[4px] h-full cursor-col-resize hover:bg-purple-1/20 transition-colors z-10"
          onMouseDown={handleResizeStart}
        />
        <FilePreview upload={previewUpload} onBack={handleClosePreview} />
      </div>
    )
  }

  // List mode
  return (
    <div
      className="relative shrink-0 bg-surface-0 border-l border-black/[0.06] flex flex-col h-full"
      style={{ width }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Resize drag handle (left edge) */}
      <div
        className="absolute top-0 left-0 w-[4px] h-full cursor-col-resize hover:bg-purple-1/20 transition-colors z-10"
        onMouseDown={handleResizeStart}
      />

      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-black/[0.06]">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-text-1 tracking-[-0.01em]">Files</span>
          {uploads.length > 0 && (
            <span className="text-[9px] font-medium text-text-3 bg-black/[0.05] px-1.5 py-0.5 rounded-full leading-none">{uploads.length}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            aria-label="Add file"
            className="p-1.5 rounded-md hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
            title="Add file"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            onClick={onClose}
            aria-label="Close files sidebar"
            title="Close files sidebar"
            className="p-1.5 rounded-md hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {uploads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4">
            <div className="w-12 h-12 rounded-2xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center mb-4">
              <svg className="w-5 h-5 text-text-3/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </div>
            <span className="text-[11px] font-medium text-text-2 mb-1">No files yet</span>
            <span className="text-[10px] text-text-3/60 text-center leading-relaxed">
              Drag and drop files here, or click + to browse
            </span>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mt-4 px-4 py-1.5 rounded-lg text-[10px] font-medium bg-black/[0.05] hover:bg-black/[0.08] text-text-2 transition-colors cursor-pointer"
            >
              Browse files
            </button>
          </div>
        ) : (
          <div className="space-y-0.5">
            {uploads.map(upload => {
              const cat = getFileCategory(upload)
              return (
                <div
                  key={upload.id}
                  className="flex items-center hover:bg-black/[0.03] group-focus-within:bg-black/[0.03] rounded-xl group transition-colors duration-150"
                >
                  <button
                    onClick={() => handleOpenPreview(upload)}
                    aria-label={upload.filename}
                    className="flex items-center gap-3 px-2.5 py-2.5 flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <FileIcon category={cat} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium text-text-1 truncate leading-tight">{upload.filename}</div>
                      <div className="text-[9px] text-text-3/60 mt-0.5">
                        {formatSize(upload.size)}
                        {upload.created_at ? ` \u00b7 ${formatDate(upload.created_at)}` : ''}
                      </div>
                    </div>
                  </button>
                  <button
                    onClick={(e) => handleDelete(upload.id, e)}
                    aria-label={`Delete ${upload.filename}`}
                    className="p-1 mr-2 rounded-md text-text-3/40 hover:text-red-1 hover:bg-red-1/10 transition-all cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                    title="Delete file"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-purple-1/5 backdrop-blur-sm border-2 border-dashed border-purple-1/30 flex flex-col items-center justify-center z-10 pointer-events-none">
          <div className="w-10 h-10 rounded-xl bg-purple-1/10 flex items-center justify-center mb-3">
            <svg className="w-5 h-5 text-purple-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <span className="text-[11px] text-purple-1 font-medium">Drop files here</span>
        </div>
      )}
    </div>
  )
}
