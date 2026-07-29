// src/renderer/components/optical-view/chat-input/upload-dropzone.tsx
//
// Drag-and-drop wrapper around the chat input. Files dropped here are sent
// through `uploadFiles(taskId, files)` (which writes them into the task's
// uploads dir via the electron IPC), and the resulting on-disk paths are
// handed back to the parent so they can be appended to the chat draft.
//
// The `counter` ref handles nested-element dragenter/dragleave events —
// otherwise the dragging ring would flicker as the cursor moves over child
// nodes inside the dropzone.
import React, { useRef, useState } from 'react'
import { uploadFiles } from '../../../upload-files'

interface Props {
  taskId: number
  onUploaded: (paths: string[]) => void
  children: React.ReactNode
  className?: string
}

export function UploadDropzone({ taskId, onUploaded, children, className }: Props) {
  const [dragging, setDragging] = useState(false)
  const counter = useRef(0)

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    counter.current = 0
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const results = await uploadFiles(taskId, files)
    const paths = results
      .map((r: { path?: string }) => r.path)
      .filter((p): p is string => !!p)
    if (paths.length) onUploaded(paths)
  }

  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); counter.current++; setDragging(true) }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { counter.current--; if (counter.current <= 0) setDragging(false) }}
      onDrop={onDrop}
      className={`${className ?? ''} ${dragging ? 'ring-2 ring-purple-1' : ''}`}
    >
      {children}
    </div>
  )
}
