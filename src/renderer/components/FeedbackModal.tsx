import React, { useState, useRef, useEffect, useCallback } from 'react'

interface AttachedImage {
  file: File
  preview: string // object URL for thumbnail
  id: number
}

interface Props {
  type: 'feature' | 'bug'
  currentTask: { id: number; title: string } | null
  onSubmit: (description: string, type: 'feature' | 'bug', relatedTaskId: number | null, images: File[]) => void
  onClose: () => void
}

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export default function FeedbackModal({ type, currentTask, onSubmit, onClose }: Props) {
  const [description, setDescription] = useState('')
  const [images, setImages] = useState<AttachedImage[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [closing, setClosing] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const attachErrorTimer = useRef<ReturnType<typeof setTimeout>>()
  const dragCounter = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // Ref so the cleanup closure always sees the latest images array
  const imagesRef = useRef(images)
  imagesRef.current = images

  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Focus trap: keep Tab/Shift+Tab inside the modal
  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return
    const focusable = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const els = Array.from(modal.querySelectorAll<HTMLElement>(focusable)).filter(el => !el.closest('.hidden'))
      if (!els.length) return
      const first = els[0]
      const last = els[els.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Clean up object URLs and pending timers on unmount
  useEffect(() => {
    return () => {
      imagesRef.current.forEach(img => URL.revokeObjectURL(img.preview))
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (attachErrorTimer.current) clearTimeout(attachErrorTimer.current)
    }
  }, [])

  const addFiles = useCallback((files: FileList | File[]) => {
    const rejected: string[] = []
    setImages(prev => {
      const combined = [...prev]
      for (const file of Array.from(files)) {
        if (!ACCEPTED_TYPES.includes(file.type)) { rejected.push(`${file.name} (unsupported type)`); continue }
        if (file.size > MAX_FILE_SIZE) { rejected.push(`${file.name} (too large, max 10 MB)`); continue }
        if (combined.length >= 5) break // max 5 images
        combined.push({ file, preview: URL.createObjectURL(file), id: Date.now() + Math.random() })
      }
      return combined.length === prev.length && rejected.length === 0 ? prev : combined
    })
    if (rejected.length > 0) {
      if (attachErrorTimer.current) clearTimeout(attachErrorTimer.current)
      setAttachError(`Rejected: ${rejected[0]}`)
      attachErrorTimer.current = setTimeout(() => setAttachError(null), 3000)
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setImages(prev => {
      const next = [...prev]
      URL.revokeObjectURL(next[index].preview)
      next.splice(index, 1)
      return next
    })
  }, [])

  // Drag & drop — use counter to avoid flicker when cursor moves to child elements
  // dragEnter fires once per element entry; dragOver fires on every mousemove frame
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    setDragOver(true)
  }, [])
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false) }
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }, [addFiles])

  // Paste from clipboard
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const pastedFiles: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && ACCEPTED_TYPES.includes(item.type)) {
        const file = item.getAsFile()
        if (file) pastedFiles.push(file)
      }
    }
    if (pastedFiles.length) {
      e.preventDefault()
      addFiles(pastedFiles)
    }
  }, [addFiles])

  function handleClose() {
    setClosing(true)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(onClose, 180)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!description.trim()) return
    onSubmit(description.trim(), type, currentTask?.id ?? null, images.map(i => i.file))
    setDescription('')
    handleClose()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') handleClose()
    if (e.key === 'Enter' && e.metaKey) handleSubmit(e)
  }

  const isFeature = type === 'feature'

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onKeyDown={handleKeyDown}>
      <div className={`absolute inset-0 bg-black/30 backdrop-blur-sm ${closing ? 'backdrop-exit pointer-events-none' : 'backdrop-enter'}`} onClick={handleClose} />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-modal-title"
        className={`relative w-[520px] bg-surface-1 border rounded-2xl shadow-2xl shadow-black/10 overflow-hidden transition-colors ${closing ? 'modal-exit' : 'modal-enter'} ${
          dragOver ? 'border-purple-1/50' : 'border-black/[0.08]'
        }`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
              isFeature ? 'bg-purple-2' : 'bg-red-2'
            }`}>
              {isFeature ? (
                <svg className="w-3.5 h-3.5 text-purple-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-red-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              )}
            </div>
            <h2 id="feedback-modal-title" className="text-[13px] font-semibold text-text-1">
              {isFeature ? 'Request a Feature' : 'Report a Bug'}
            </h2>
          </div>
          {currentTask && (
            <p className="text-[10px] text-text-3 mt-2 ml-[38px]">
              Related to: <span className="text-text-2">{currentTask.title}</span>
            </p>
          )}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 pb-5">
          <textarea
            ref={textareaRef}
            value={description}
            onChange={e => setDescription(e.target.value)}
            onPaste={handlePaste}
            placeholder={isFeature
              ? "Describe the feature you'd like..."
              : "What's broken? What did you expect to happen?"
            }
            rows={5}
            className="w-full bg-black/[0.03] border border-black/[0.06] rounded-xl px-4 py-3 text-[12px] text-text-1 placeholder-text-3/40 focus:outline-none focus:border-purple-1/30 resize-none leading-relaxed"
          />

          {/* Image attachments */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {images.map((img, i) => (
                <div key={img.id} className="relative group">
                  <img
                    src={img.preview}
                    alt={img.file.name}
                    className="w-16 h-16 object-cover rounded-lg border border-black/[0.08]"
                  />
                  <button
                    type="button"
                    tabIndex={0}
                    aria-label={`Remove ${img.file.name}`}
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-1 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                  >
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Drag overlay hint */}
          {dragOver && (
            <div className="mt-3 py-4 border-2 border-dashed border-purple-1/40 rounded-xl flex items-center justify-center">
              <p className="text-[11px] text-purple-1">Drop images here</p>
            </div>
          )}

          {attachError && (
            <p role="alert" className="mt-2 text-[10px] text-red-1">{attachError}</p>
          )}

          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center gap-3">
              <span className="text-[9px] text-text-3">Cmd+Enter to submit</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 text-[9px] text-text-3 hover:text-text-2 transition-colors cursor-pointer"
                title="Attach images (or paste/drag & drop)"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                {images.length > 0 ? `${images.length}/5` : 'Attach'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }}
              />
            </div>
            <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-3 py-1.5 rounded-lg text-[10px] font-medium text-text-3 hover:text-text-2 hover:bg-black/[0.04] transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!description.trim()}
                  className={`px-4 py-1.5 rounded-lg text-[10px] font-semibold text-white transition-all cursor-pointer disabled:opacity-40 ${
                    isFeature
                      ? 'bg-purple-1 hover:bg-purple-1/90 shadow-lg shadow-purple-1/20'
                      : 'bg-red-1 hover:bg-red-1/90 shadow-lg shadow-red-1/20'
                  }`}
                >
                  {isFeature ? 'Create & Open Session' : 'Report & Open Session'}
                </button>
              </div>
          </div>
        </form>
      </div>
    </div>
  )
}
