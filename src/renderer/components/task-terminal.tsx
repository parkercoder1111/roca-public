import React, { useEffect, useRef, useState, useCallback } from 'react'
import { TerminalSession } from '../terminal/terminal-session'
import { uploadFiles } from '../upload-files'
import { parseSlashCommand, parseBrowseIntent, parseStopBrowseIntent, formatHelpText } from '../lib/slash-commands'
import type { Task } from '@shared/types'
import { ASSISTANT_TASK_ID } from '@shared/constants'
import { useViewMode } from '../lib/view-mode'
import { OpticalView } from './optical-view'

type ElectronFile = File & { readonly path?: string }

interface Props {
  task: Task
  isActive?: boolean
  autoCommand?: string | null
  onAutoCommandConsumed?: () => void
  onUploadsChanged?: () => void
  onSlashCommand?: (command: string, args: string) => void
  onLinkClick?: (url: string) => void
  onRegisterWriter?: (writer: ((text: string) => void) | null) => void
  // Scope the pty session to a tab id so multiple tabs (on the same task or
  // assistant) each get their own tmux-backed session. Empty/undefined =
  // legacy default (no suffix), preserving prior session ids.
  assistantTabId?: string
  // Mirror tabs override the computed pty id so multiple xterm views can
  // share the same tmux session. When set, no auto-launch fires (the
  // source's Claude is already running).
  overridePtyId?: string
  // Host the underlying shell should run on. Undefined / 'local' = Mac;
  // remote ids (e.g. 'main', 'altura') trigger mosh in the main process.
  // Mirror tabs ignore this — they attach to the source's existing pty.
  host?: string
}


function TaskTerminalInner({ task, isActive = true, autoCommand, onAutoCommandConsumed, onUploadsChanged, onSlashCommand, onLinkClick, onRegisterWriter, assistantTabId, overridePtyId, host }: Props) {
  const isAssistant = task.id === ASSISTANT_TASK_ID
  const isMirror = !!overridePtyId
  // '' = default tab uses legacy session id (no suffix); other tabs get a per-tab session
  const tabSuffix = assistantTabId ? `-${assistantTabId}` : ''
  const ptyId = overridePtyId ?? (isAssistant ? `task-assistant${tabSuffix}` : `task-${task.id}${tabSuffix}`)
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  // Visual previews for images pasted into the terminal. Terminal only sees the
  // file path string — these thumbnails sit on top so the queued image actually
  // looks like an image. Cleared when the user submits or aborts the line.
  const [pendingPastes, setPendingPastes] = useState<{ id: number; path: string; dataUrl: string }[]>([])
  const pendingPastesRef = useRef(pendingPastes)
  pendingPastesRef.current = pendingPastes
  const pasteIdRef = useRef(0)
  const clearPendingPastes = useCallback(() => {
    if (pendingPastesRef.current.length) setPendingPastes([])
  }, [])
  const dismissPendingPaste = useCallback((id: number) => {
    setPendingPastes(prev => prev.filter(p => p.id !== id))
  }, [])
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  // Pending scrollback to replay when terminal becomes visible
  const pendingScrollbackRef = useRef<string | null>(null)
  // Track auto-command to run on fresh PTY
  const autoCommandRef = useRef<string | null>(null)
  const onAutoCommandConsumedRef = useRef<(() => void) | undefined>(undefined)
  autoCommandRef.current = autoCommand ?? null
  onAutoCommandConsumedRef.current = onAutoCommandConsumed
  // Deferred auto-launch: wait for terminal tab to be active before sending command
  const needsAutoLaunchRef = useRef(false)
  const shellReadyRef = useRef(false)
  // Context file path returned from pty:start (for piping to Claude)
  const contextPathRef = useRef<string | null>(null)
  // Whether main flagged this task for permission bypass (Development-folder or
  // [Bug]/[Feature] tasks). Returned from pty:start; consumed by doAutoLaunch.
  const bypassPermissionsRef = useRef(false)
  const taskTitleRef = useRef(task.title)
  taskTitleRef.current = task.title
  // Remote tabs need a different auto-launch because (a) the context file
  // lives on the local machine and `cat 'localpath'` fails on the remote host,
  // and (b) claude runs as root on the remote host and rejects
  // --dangerously-skip-permissions.
  const isRemoteHostRef = useRef(!!host && host !== 'local')
  isRemoteHostRef.current = !!host && host !== 'local'
  // Data buffer for PTY output arriving while terminal is hidden (prevents garbled rendering)
  const pendingDataRef = useRef<string | null>(null)
  const connectGenRef = useRef(0)

  // Auto-launch Claude: pipe context file if available, otherwise fall back to title
  const doAutoLaunch = useCallback(async (id: string) => {
    if (!needsAutoLaunchRef.current) return
    needsAutoLaunchRef.current = false
    let cmd: string
    // Development-folder tasks and [Bug]/[Feature] throwaway sessions are
    // fast-moving dev work — launch them with permissions bypassed so they
    // never stall on a prompt mid-fix. Main decides the task-type policy
    // (bypassPermissions from pty:start); we gate it on a local host here,
    // since claude-as-root on a remote host rejects
    // --dangerously-skip-permissions (the remote branch below uses acceptEdits).
    const bypass = !isRemoteHostRef.current && bypassPermissionsRef.current
    const perm = bypass ? ' --dangerously-skip-permissions' : ''
    if (autoCommandRef.current) {
      cmd = autoCommandRef.current
    } else if (isRemoteHostRef.current) {
      // Remote tabs (mosh tmux on a remote host): the local-side context file
      // isn't reachable and claude-as-root refuses --dangerously-skip-permissions,
      // so launch bare with acceptEdits (closest to skip-perms that works
      // for root — auto-accepts edits, prompts on other tool uses).
      const escapedTitle = taskTitleRef.current.replace(/'/g, "'\\''")
      cmd = isAssistant
        ? `claude --permission-mode acceptEdits`
        : `claude --permission-mode acceptEdits '${escapedTitle}'`
    } else if (task.forked_session_id) {
      // Forked task — resume the cloned conversation as an independent session.
      // --fork-session ensures Claude assigns a fresh ID so source and fork don't
      // overwrite each other's JSONL.
      cmd = `claude --resume ${task.forked_session_id} --fork-session${perm}`
    } else if (isAssistant && contextPathRef.current) {
      const escaped = contextPathRef.current.replace(/'/g, "'\\''")
      cmd = `cat '${escaped}' | claude${perm}`
    } else if (contextPathRef.current) {
      // Pipe full task context (including previous session summaries) to Claude
      const escaped = contextPathRef.current.replace(/'/g, "'\\''")
      cmd = `cat '${escaped}' | claude${perm} "Help me with this task"`
    } else if (isAssistant) {
      cmd = `claude${perm}`
    } else {
      // Single-quote wrapping is safe against all shell metacharacters
      const escapedTitle = taskTitleRef.current.replace(/'/g, "'\\''")
      cmd = `claude${perm} '${escapedTitle}'`
    }
    const cb = onAutoCommandConsumedRef.current
    window.electronAPI.writePty(id, cmd + '\r')
    cb?.()
  }, [task.id, task.forked_session_id, isAssistant])

  const onSlashCommandInternalRef = useRef(onSlashCommand)
  onSlashCommandInternalRef.current = onSlashCommand
  const onLinkClickRef = useRef(onLinkClick)
  onLinkClickRef.current = onLinkClick

  // When terminal becomes active/visible, flush any pending scrollback,
  // refit, and trigger deferred auto-launch if needed.
  // IMPORTANT: fit() is called exactly once AFTER all pending data is written
  // to prevent resize race conditions that scramble text during scroll.
  useEffect(() => {
    if (isActive && sessionRef.current) {
      const session = sessionRef.current
      // Output that piled up while hidden gets bulk-replayed below. For a
      // full-screen TUI (Claude Code) that byte stream is cursor-addressed
      // against the alt-screen, so replaying it in one shot can land the
      // screen out of sync — typically with the input line clipped past the
      // bottom of the (scrollback-less) alt-screen. Note it so we can repaint.
      const replayedWhileHidden = !!(pendingScrollbackRef.current || pendingDataRef.current)
      // Replay deferred scrollback if any
      if (pendingScrollbackRef.current) {
        session.terminal.clear()
        session.write(pendingScrollbackRef.current)
        pendingScrollbackRef.current = null
      }
      // Flush data that arrived while terminal was hidden
      if (pendingDataRef.current) {
        session.write(pendingDataRef.current)
        pendingDataRef.current = null
      }
      // Single fit() after all data is written — prevents double-resize scrambling
      try { session.fit() } catch {}
      // After a replay, nudge the pty size so the TUI repaints a clean frame
      // for the current viewport — a resize round-trip is the only signal that
      // makes Claude Code redraw its whole alt-screen. Without it the clipped
      // input stays unreachable until a full reload: scrolling and typing both
      // look dead because the alt-screen can't scroll and the prompt sits below
      // the bottom edge.
      if (replayedWhileHidden) {
        const { cols, rows } = session.terminal
        if (cols > 0 && rows > 1) {
          window.electronAPI.resizePty(ptyId, cols, rows - 1)
          setTimeout(() => {
            if (sessionRef.current === session) window.electronAPI.resizePty(ptyId, cols, rows)
          }, 50)
        }
      }
      // Returning to a hidden tab otherwise never refocuses the terminal
      // (focus is set once at connect), so keystrokes needed a manual click.
      session.focus()
      // Auto-launch Claude if we haven't launched yet.
      if (needsAutoLaunchRef.current) {
        doAutoLaunch(ptyId)
      }
    }
  }, [isActive, doAutoLaunch, task.id, ptyId])

  // Track if this is a real unmount vs React strict mode double-mount
  const mountedRef = useRef(true)

  useEffect(() => {
    if (!containerRef.current) return
    mountedRef.current = true
    const gen = ++connectGenRef.current

    const container = containerRef.current
    const session = new TerminalSession(container, {
      onLinkClick: (url) => onLinkClickRef.current?.(url),
    })
    sessionRef.current = session
    // Register a writer function so browser thoughts can be piped into this terminal
    onRegisterWriter?.((text: string) => session.write(text))
    let removeDataListener: (() => void) | null = null
    let removeExitListener: (() => void) | null = null
    let idleTimer: NodeJS.Timeout | null = null
    let shellReadyTimer: NodeJS.Timeout | null = null

    async function connect() {
      // startPty reconnects to existing PTY if one is running (doesn't kill it).
      // Mirror tabs pass their overridePtyId directly so they attach to the
      // source's existing tmux session — same Claude, two views.
      // Fork tabs pass the source's cwd so `claude --resume <id>` finds the
      // JSONL (the server's DB-based cwd lookup only works for forked tasks,
      // not for fork tabs whose underlying task row isn't itself a fork).
      const ptyTaskId = isMirror
        ? ptyId.replace(/^task-/, '')
        : (isAssistant ? `assistant${tabSuffix}` : `${String(task.id)}${tabSuffix}`)
      const cwd = !isMirror && task.forked_source_cwd ? task.forked_source_cwd : undefined
      // Mirror tabs attach to the source's existing pty — host is whatever the
      // source was spawned with, don't try to re-route here.
      const ptyHost = isMirror ? undefined : host
      const result = await window.electronAPI.startPty(ptyTaskId, cwd, ptyHost)
      if (!result.ok || !mountedRef.current || gen !== connectGenRef.current) return

      // Store context path + permission-bypass flag for auto-launch
      if (result.contextPath) {
        contextPathRef.current = result.contextPath
      }
      bypassPermissionsRef.current = !!result.bypassPermissions

      setIsConnected(true)

      // Determine scrollback to replay:
      // - Reconnecting to live PTY → get in-memory scrollback
      // - Tmux reattach → tmux replays its own scrollback, no action needed
      // - New PTY after app restart → use saved scrollback from disk
      let scrollback: string | null = null
      if (result.existing) {
        scrollback = await window.electronAPI.getPtyScrollback(ptyId)
      } else if (!result.tmuxReattached && result.savedScrollback) {
        // App was restarted without tmux — replay saved scrollback before new shell prompt
        scrollback = result.savedScrollback
      }

      if (scrollback && mountedRef.current) {
        // Check if container is visible (has real dimensions)
        const el = containerRef.current
        const isVisible = el && el.offsetWidth > 0 && el.offsetHeight > 0
        if (isVisible) {
          session.write(scrollback)
        } else {
          // Container is hidden — defer scrollback until terminal becomes visible
          // Writing to a zero-dimension xterm produces garbled output
          pendingScrollbackRef.current = scrollback
        }
      }

      // Auto-launch Claude for truly new PTYs only.
      // Skip if: reconnecting to live PTY (existing), reattaching to tmux session
      // (Claude is still alive inside tmux), or this is a mirror tab attaching
      // to a source's pty (the source already has Claude running).
      if (!isMirror && !result.existing && !result.tmuxReattached) {
        needsAutoLaunchRef.current = true
        shellReadyRef.current = false

        shellReadyTimer = setTimeout(() => {
          if (!mountedRef.current) return
          shellReadyRef.current = true
          if (isActiveRef.current && needsAutoLaunchRef.current) {
            doAutoLaunch(ptyId)
          }
        }, 500)
      }

      // If reconnecting to existing PTY but have a pending auto-command, run it
      if ((result.existing || result.tmuxReattached) && autoCommandRef.current) {
        window.electronAPI.writePty(ptyId, autoCommandRef.current + '\r')
        onAutoCommandConsumedRef.current?.()
      }

      // Track output bursts to detect when a long-running command finishes
      let burstBytes = 0
      let lastNotifiedAt = 0
      const BURST_THRESHOLD = 1024 // 1KB of output = "significant" command
      const IDLE_MS = 5000
      const NOTIFY_COOLDOWN_MS = 30000 // Don't spam notifications

      removeDataListener = window.electronAPI.onPtyData(ptyId, data => {
        if (!mountedRef.current) return
        // Only render to xterm when visible; buffer when hidden to avoid garbled output
        if (isActiveRef.current) {
          if (pendingDataRef.current) {
            session.write(pendingDataRef.current)
            pendingDataRef.current = null
          }
          session.write(data)
        } else {
          pendingDataRef.current = (pendingDataRef.current || '') + data
          if (pendingDataRef.current!.length > 2 * 1024 * 1024) {
            pendingDataRef.current = pendingDataRef.current!.slice(-2 * 1024 * 1024)
          }
        }
        burstBytes += data.length
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (burstBytes >= BURST_THRESHOLD && !isActiveRef.current) {
            const now = Date.now()
            if (now - lastNotifiedAt > NOTIFY_COOLDOWN_MS) {
              lastNotifiedAt = now
            }
          }
          burstBytes = 0
        }, IDLE_MS)
      })
      removeExitListener = window.electronAPI.onPtyExit(ptyId, exitCode => {
        if (idleTimer) clearTimeout(idleTimer)
        if (mountedRef.current) {
          session.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`)
          setIsConnected(false)
          if (!isActiveRef.current) {
            // macOS notifications disabled
          }
        }
      })
      // Slash command interception: track line input, intercept on Enter
      let lineBuffer = ''
      session.onData(data => {
        if (data === '\r' || data === '\n' || data === '\x03' || data === '\x15') {
          // Submission or line clear — drop the pasted-image previews
          clearPendingPastes()
        }
        if (data === '\r' || data === '\n') {
          const parsed = parseSlashCommand(lineBuffer)
          if (parsed) {
            // Known ROCA command — suppress Enter, clear input from shell, handle it
            window.electronAPI.writePty(ptyId, '\x15') // Ctrl+U clears line in shell/CLI
            if (parsed.command === 'clear') {
              setTimeout(() => window.electronAPI.writePty(ptyId, '\x0c'), 30) // Ctrl+L
            } else if (parsed.command === 'help') {
              setTimeout(() => {
                session.write(`\r\n\x1b[90m  ROCA commands:\x1b[0m\r\n${formatHelpText()}\r\n`)
                window.electronAPI.writePty(ptyId, '\r') // fresh prompt
              }, 30)
            }
            onSlashCommandInternalRef.current?.(parsed.command, parsed.args)
            lineBuffer = ''
            return
          }
          // Natural language browser intent — "open browser", "browse to X", "go to domain.com"
          const browseIntent = parseBrowseIntent(lineBuffer)
          if (browseIntent !== null) {
            window.electronAPI.writePty(ptyId, '\x15') // clear line from shell
            onSlashCommandInternalRef.current?.('browse', browseIntent)
            lineBuffer = ''
            return
          }
          // "stop browsing" / "close browser"
          if (parseStopBrowseIntent(lineBuffer)) {
            window.electronAPI.writePty(ptyId, '\x15')
            onSlashCommandInternalRef.current?.('browser', '') // toggles browser panel off
            lineBuffer = ''
            return
          }
          lineBuffer = ''
        } else if (data === '\x7f') {
          lineBuffer = lineBuffer.slice(0, -1)
        } else if (data === '\x03') {
          lineBuffer = '' // Ctrl+C resets
        } else if (data === '\x15') {
          lineBuffer = '' // Ctrl+U clears line
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          lineBuffer += data
        } else if (data.length > 1 && !data.startsWith('\x1b')) {
          lineBuffer += data // pasted text
        }
        window.electronAPI.writePty(ptyId, data)
      })
      // Both source and mirror views drive resize so content actually reflows
      // to whatever's currently visible. Means tmux ends up at the smaller
      // size when both are open — the source view has empty space on the
      // right, but lines render correctly in both places.
      session.onResize((cols, rows) => window.electronAPI.resizePty(ptyId, cols, rows))

      // Intercept Cmd+V for image paste
      // preventDefault must be synchronous (before any await) to suppress the
      // browser's native paste and xterm's 'paste' event handler.
      // If no image is found, fall back to reading clipboard text manually.
      const pasteHandler = async (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
          e.preventDefault()
          e.stopPropagation()
          try {
            const result = await window.electronAPI.pasteImage()
            if (result.ok && result.path) {
              // Type the image path into the terminal (e.g. for Claude Code to pick up)
              window.electronAPI.writePty(ptyId, result.path)
              if (result.dataUrl) {
                const id = ++pasteIdRef.current
                setPendingPastes(prev => [...prev, { id, path: result.path!, dataUrl: result.dataUrl! }])
              }
            } else {
              // No image — paste text via xterm to preserve bracketed-paste-mode wrapping
              try {
                const text = await navigator.clipboard.readText()
                if (text) session.terminal.paste(text)
              } catch { /* clipboard read failed (e.g. permission denied) */ }
            }
          } catch (err) {
            console.error('[TaskTerminal] pasteImage failed:', err)
          }
        }
      }
      container.addEventListener('keydown', pasteHandler, { capture: true })
      session._pasteHandler = pasteHandler

      // No wheel interception — let xterm.js handle scroll natively.
      // Normal buffer: xterm scrolls its viewport.
      // Alt buffer with mouse tracking (Claude Code): xterm forwards as
      // mouse escape sequences (SGR button 64/65) which Claude Code handles.

      session.focus()
    }
    connect()

    return () => {
      mountedRef.current = false
      pendingScrollbackRef.current = null
      pendingDataRef.current = null
      if (shellReadyTimer) clearTimeout(shellReadyTimer)
      if (idleTimer) clearTimeout(idleTimer)
      removeDataListener?.()
      removeExitListener?.()
      if (session._pasteHandler && container) {
        container.removeEventListener('keydown', session._pasteHandler, { capture: true })
      }
      onRegisterWriter?.(null)
      session.dispose()
      // DON'T kill PTY — it persists in the main process so the user can
      // switch back to this task and reconnect to the same terminal session
    }
  }, [task.id])

  const handleTerminalDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files) as ElectronFile[]
    if (!files.length) return
    if (isConnected) {
      const paths = files.map(f => {
        const fp = f.path
        if (!fp) return f.name
        const safe = fp.replace(/'/g, "'\\''")
        return `'${safe}'`
      }).join(' ')
      window.electronAPI.writePty(ptyId, paths)
    }
    // Show inline thumbnails for any dropped image files so they read as
    // images instead of just paths in the terminal.
    for (const f of files) {
      if (!f.type.startsWith('image/') || !f.path) continue
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : null
        if (!dataUrl || !f.path) return
        const id = ++pasteIdRef.current
        setPendingPastes(prev => [...prev, { id, path: f.path!, dataUrl }])
      }
      reader.readAsDataURL(f)
    }
    if (!isAssistant) {
      uploadFiles(task.id, files).then(() => onUploadsChanged?.())
    }
  }, [isConnected, ptyId, isAssistant, task.id, onUploadsChanged])

  return (
    <div className="flex-1 flex flex-col">
      {/* Pasted-image previews — the terminal shows the raw path text;
          these thumbnails let the user actually see what they just attached. */}
      {pendingPastes.length > 0 && (
        <div className="px-4 py-2 border-b border-black/[0.06] bg-surface-0 flex flex-wrap gap-2 items-center">
          <span className="text-[9px] font-semibold text-text-3 uppercase tracking-wider mr-1">Attached</span>
          {pendingPastes.map(p => (
            <div
              key={p.id}
              className="group relative rounded-lg overflow-hidden ring-1 ring-black/[0.08] shadow-sm bg-black/[0.04]"
              style={{ width: 56, height: 56 }}
              title={p.path.split('/').pop() || 'pasted image'}
            >
              <img src={p.dataUrl} alt="Pasted image" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => dismissPendingPaste(p.id)}
                aria-label="Dismiss pasted image preview"
                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer hover:bg-black/80"
              >
                <svg className="w-2 h-2" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Terminal */}
      <div
        className="flex-1 relative"
        onDragOver={e => e.preventDefault()}
        onDrop={handleTerminalDrop}
      >
        <div ref={containerRef} role="application" aria-label={`Terminal for ${task.title}`} className="absolute inset-0" />
      </div>
    </div>
  )
}

// View-mode switcher wrapper. Mounts OpticalView when the global view-mode
// toggle is set to 'optical'; otherwise falls through to the legacy
// xterm-backed TaskTerminalInner. The wrapper exists so the view-mode hook
// can branch cleanly without violating rules-of-hooks inside the (many)
// hooks that live in TaskTerminalInner.
export function TaskTerminal(props: Props) {
  const [viewMode] = useViewMode()
  if (viewMode === 'optical') {
    const { task, assistantTabId, overridePtyId } = props
    const isAssistant = task.id === ASSISTANT_TASK_ID
    const tabSuffix = assistantTabId ? `-${assistantTabId}` : ''
    const ptyId = overridePtyId ?? (isAssistant ? `task-assistant${tabSuffix}` : `task-${task.id}${tabSuffix}`)
    const cwd = task.forked_source_cwd ?? ''
    return <OpticalView ptyId={ptyId} cwd={cwd} taskId={task.id} />
  }
  return <TaskTerminalInner {...props} />
}
