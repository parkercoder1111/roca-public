import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api, on } from '../api'
import '@xterm/xterm/css/xterm.css'

interface Task {
  id: number
  title: string
  status: string
  priority: string
  company_name: string | null
}

interface Props {
  task: Task
  onBack: () => void
  ptyStatus: string | null
}

export default function TerminalView({ task, onBack, ptyStatus }: Props) {
  const [isConnected, setIsConnected] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const termContainerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState('')
  const [uploads, setUploads] = useState<{ stored_name: string; filename: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [showPhotos, setShowPhotos] = useState(false)
  const ptyId = `task-${task.id}`

  // Initialize xterm.js
  useEffect(() => {
    if (!termContainerRef.current) return

    const term = new Terminal({
      theme: {
        background: '#F2F2F7',
        foreground: '#1D1D1F',
        cursor: '#BF5AF2',
        cursorAccent: '#F2F2F7',
        selectionBackground: 'rgba(191, 90, 242, 0.2)',
        selectionForeground: '#1D1D1F',
        black: '#1D1D1F',
        red: '#FF3B30',
        green: '#34C759',
        yellow: '#FF9500',
        blue: '#007AFF',
        magenta: '#BF5AF2',
        cyan: '#5AC8FA',
        white: '#F2F2F7',
        brightBlack: '#8E8E93',
        brightRed: '#FF6961',
        brightGreen: '#4CD964',
        brightYellow: '#FFCC00',
        brightBlue: '#5AC8FA',
        brightMagenta: '#DA70D6',
        brightCyan: '#70D7FF',
        brightWhite: '#FFFFFF',
      },
      fontSize: 12,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termContainerRef.current)

    // Fit after a brief delay to ensure container has dimensions
    setTimeout(() => fit.fit(), 50)

    termRef.current = term
    fitRef.current = fit

    // Handle terminal input → send to PTY
    term.onData((data) => {
      api.writePty(ptyId, data)
    })

    // Resize handler
    const resizeObserver = new ResizeObserver(() => {
      try { fit.fit() } catch {}
    })
    resizeObserver.observe(termContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [ptyId])

  // Connect to PTY
  const connectPty = useCallback(async () => {
    setIsStarting(true)
    try {
      const result = await api.startPty(String(task.id))
      if (!result.ok) return
      await api.subscribePty(ptyId)
      const scrollback = await api.getPtyScrollback(ptyId)
      if (scrollback && termRef.current) {
        termRef.current.write(scrollback)
      }
      setIsConnected(true)
    } catch (e) {
      console.error('Failed to connect PTY:', e)
    } finally {
      setIsStarting(false)
    }
  }, [task.id, ptyId])

  // Listen for PTY data events
  useEffect(() => {
    const unsubData = on('pty:data', (data: { ptyId: string; data: string }) => {
      if (data.ptyId === ptyId && termRef.current) {
        termRef.current.write(data.data)
      }
    })
    const unsubExit = on('pty:exit', (data: { ptyId: string; exitCode: number }) => {
      if (data.ptyId === ptyId) {
        termRef.current?.write(`\r\n[Process exited with code ${data.exitCode}]\r\n`)
        setIsConnected(false)
      }
    })
    return () => { unsubData(); unsubExit() }
  }, [ptyId])

  // Poll scrollback as fallback (for Cloudflare tunnel)
  const scrollbackLenRef = useRef(0)
  useEffect(() => {
    if (!isConnected) return
    const poll = setInterval(async () => {
      try {
        const scrollback = await api.getPtyScrollback(ptyId)
        if (scrollback && scrollback.length > scrollbackLenRef.current) {
          const newData = scrollback.substring(scrollbackLenRef.current)
          scrollbackLenRef.current = scrollback.length
          if (newData.length > 0 && termRef.current) {
            termRef.current.write(newData)
          }
        }
      } catch {}
    }, 2000)
    return () => clearInterval(poll)
  }, [isConnected, ptyId])

  // Set initial scrollback length
  useEffect(() => {
    connectPty()
    return () => {
      api.unsubscribePty(ptyId).catch(() => {})
    }
  }, [connectPty, ptyId])

  // Load existing uploads
  useEffect(() => {
    api.getUploadsForTask(task.id).then((existing: any[]) => {
      setUploads(existing.filter((u: any) => {
        const ext = u.stored_name?.split('.').pop()?.toLowerCase()
        return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext || '')
      }).map((u: any) => ({ stored_name: u.stored_name, filename: u.filename })))
    }).catch(() => {})
  }, [task.id])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const results = await Promise.all(
        Array.from(files).map(file => api.uploadFile(task.id, file))
      )
      const successful = results.filter((r: any) => r.ok)
      if (successful.length > 0) {
        setUploads(prev => [...prev, ...successful.map((r: any) => ({ stored_name: r.stored_name, filename: r.filename }))])
        setShowPhotos(true)
      }
    } catch (err) {
      console.error('Upload failed:', err)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const sendInput = () => {
    if (!input && !isConnected) return
    api.writePty(ptyId, input + '\r')
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const statusLabel = ptyStatus === 'running' ? 'Running' : ptyStatus === 'needs_input' ? 'Needs Input' : null

  return (
    <div className="mv">
      {/* Header */}
      <div className="mv-header">
        <button onClick={onBack} className="mv-back">
          <svg width="10" height="16" fill="none" viewBox="0 0 10 16">
            <path d="M9 1L2 8l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Tasks
        </button>
        <div className="mv-title-area">
          <div className="mv-title">{task.title}</div>
        </div>
        <div className="mv-header-actions">
          {statusLabel && (
            <span className={`mv-status ${ptyStatus === 'running' ? 'mv-status-run' : 'mv-status-input'}`}>
              {statusLabel}
            </span>
          )}
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="mv-icon-btn">
            {uploading ? (
              <div className="mv-spinner" />
            ) : (
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"/>
                <path d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"/>
              </svg>
            )}
            {uploads.length > 0 && <span className="mv-badge">{uploads.length}</span>}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileSelect} style={{display:'none'}} />
          <div className={`mv-dot ${isConnected ? 'on' : ''}`} />
        </div>
      </div>

      {/* Photos */}
      {uploads.length > 0 && showPhotos && (
        <div className="mv-photos">
          {uploads.map(u => (
            <img key={u.stored_name} src={api.getUploadUrl(u.stored_name)} alt={u.filename} className="mv-photo" />
          ))}
        </div>
      )}
      {uploads.length > 0 && (
        <button onClick={() => setShowPhotos(p => !p)} className="mv-photos-toggle">
          {showPhotos ? 'Hide' : 'Show'} {uploads.length} photo{uploads.length !== 1 ? 's' : ''}
        </button>
      )}

      {/* Terminal */}
      <div
        ref={termContainerRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          background: '#F2F2F7',
          padding: '4px 0',
        }}
      />

      {/* Input */}
      <div className="mv-input-bar">
        {!isConnected && !isStarting ? (
          <button onClick={connectPty} className="mv-start-btn">Start Terminal</button>
        ) : (
          <div className="mv-compose">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInput() } }}
              placeholder="Message..."
              rows={1}
              className="mv-textarea"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <button onClick={sendInput} className="mv-send" disabled={!input.trim()}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 14.5l13-6.5-13-6.5v5l9 1.5-9 1.5z"/>
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
