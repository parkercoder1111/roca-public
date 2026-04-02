import React, { useEffect, useRef, useState, useCallback } from 'react'
import { TerminalSession } from '../terminal/TerminalSession'
import { uploadFiles } from '../uploadFiles'
import { parseSlashCommand, parseBrowseIntent, parseStopBrowseIntent, formatHelpText } from '../lib/slashCommands'
import { shouldSpeakLine, isToolLine, STATUS_BAR_RE, THINKING_RE } from '../lib/voiceFilters'
import type { Task } from '@shared/types'
import { ASSISTANT_TASK_ID } from '@shared/constants'
import { SOURCE_COLORS as SHARED_SOURCE_COLORS, SOURCE_LABELS_FULL } from '../lib/sourceMeta'

interface Props {
  task: Task
  onNotesChange: () => void
  isActive?: boolean
  autoCommand?: string | null
  onAutoCommandConsumed?: () => void
  pendingVoiceText?: string | null
  onVoiceTextConsumed?: () => void
  onClaudeResponse?: (text: string) => void
  onUploadsChanged?: () => void
  onSlashCommand?: (command: string, args: string) => void
  onLinkClick?: (url: string) => void
  onRegisterWriter?: (writer: ((text: string) => void) | null) => void
}

const VOICE_RESPONSE_IDLE_FALLBACK_MS = 6000

const TERMINAL_SOURCE_COLORS = SHARED_SOURCE_COLORS
const TERMINAL_SOURCE_LABELS = SOURCE_LABELS_FULL

function collectTerminalLines(terminal: TerminalSession['terminal']): string[] {
  const buf = terminal.buffer.active
  const allLines: string[] = []
  const totalRows = buf.baseY + terminal.rows
  for (let i = 0; i < totalRows; i++) {
    const line = buf.getLine(i)
    if (line) allLines.push(line.translateToString(true).trimEnd())
  }
  return allLines
}

function findVoiceTurnStartIndex(allLines: string[], sent: string): number {
  if (!sent || sent.length <= 5) return 0
  const needle = sent.substring(0, Math.min(30, sent.length))
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (allLines[i].includes(needle)) {
      // Skip past ALL lines that are part of the sent text.
      // Long voice messages wrap across multiple terminal lines —
      // without this, wrapped lines leak into the "response" and get spoken back.
      let endIdx = i + 1
      const sentNorm = sent.toLowerCase().replace(/\s+/g, ' ')
      while (endIdx < allLines.length) {
        const lineTrimmed = allLines[endIdx].trim()
        if (!lineTrimmed) { endIdx++; continue }
        // If this line's content appears in the sent text, it's part of the user's input
        const lineNorm = lineTrimmed.toLowerCase().replace(/\s+/g, ' ')
        if (lineNorm.length >= 3 && sentNorm.includes(lineNorm)) {
          endIdx++
        } else {
          break
        }
      }
      return endIdx
    }
  }
  return 0
}

function hasClaudePromptMarkers(responseLines: string[]): boolean {
  const tail = responseLines.slice(-12).join('\n')
  return (
    /shift\+tab to cycle/i.test(tail) ||
    /bypass permissions/i.test(tail) ||
    /Cooked for\s+\d+/i.test(tail) ||
    /\b(?:Opus|Sonnet|Haiku)\b.*context/i.test(tail) ||
    /Press up to edit/i.test(tail) ||
    /❯\s*$/m.test(tail)
  )
}

function buildVoiceDebugSnapshot(params: {
  taskId: number
  sent: string
  status: string
  hasObservedResponse: boolean
  hasPrompt: boolean
  idleForMs: number
  idleFallbackReady: boolean
  spokenCount: number
  responseLines: string[]
  rawLength: number
  stage: string
  reason?: string
}) {
  const tail = params.responseLines.slice(-8)
  return [
    `[voice-debug] ${new Date().toISOString()}`,
    `stage=${params.stage}`,
    `taskId=${params.taskId}`,
    `status=${params.status || 'none'}`,
    `hasObservedResponse=${params.hasObservedResponse}`,
    `hasPrompt=${params.hasPrompt}`,
    `idleForMs=${params.idleForMs}`,
    `idleFallbackReady=${params.idleFallbackReady}`,
    `spokenCount=${params.spokenCount}`,
    `rawLength=${params.rawLength}`,
    params.reason ? `reason=${params.reason}` : '',
    `sent=${params.sent.substring(0, 200)}`,
    '--- RESPONSE TAIL ---',
    ...tail.map((line, i) => `T[${i}] ${line.substring(0, 220)}`),
  ].filter(Boolean).join('\n')
}

// shouldSpeakLine and isToolLine imported from ../lib/voiceFilters

function extractSpokenSummary(allLines: string[], sent: string, raw?: string): { text: string; response: string[]; spokenLines: string[] } {
  const startIdx = findVoiceTurnStartIndex(allLines, sent)
  const response = allLines.slice(startIdx)

  // PRIMARY: Use raw PTY data to find where tool output ends.
  // Claude Code uses ⎿ for tool output and ⏺ for tool calls — these survive
  // in the raw buffer even though translateToString may strip them.
  // Take everything after the last ⎿-containing line as the conversational text.
  //
  // IMPORTANT: Claude Code's status bar also contains ⎿ (e.g. "⎿ bypass permissions...").
  // We must skip status bar markers and find the last REAL tool output marker.
  if (raw) {
    // Strip ANSI from raw once for marker-context checks
    const rawClean = raw
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b\[[\d;]*m/g, '')

    // Search backwards for the last ⎿/⏺ that is NOT part of the status bar
    let lastMarker = -1
    for (let searchPos = rawClean.length; searchPos > 0;) {
      const toolOut = rawClean.lastIndexOf('⎿', searchPos - 1)
      const toolCall = rawClean.lastIndexOf('⏺', searchPos - 1)
      const candidate = Math.max(toolOut, toolCall)
      if (candidate < 0) break
      // Extract the line containing this marker to check for status bar patterns
      const lineStart = rawClean.lastIndexOf('\n', candidate) + 1
      const lineEnd = rawClean.indexOf('\n', candidate)
      const markerLine = rawClean.substring(lineStart, lineEnd >= 0 ? lineEnd : rawClean.length)
      if (!STATUS_BAR_RE.test(markerLine) && !THINKING_RE.test(markerLine.trim())) {
        lastMarker = candidate
        break
      }
      searchPos = candidate
    }

    if (lastMarker >= 0) {
      // Find the next newline after the marker — text starts on the line after
      const nextNewline = rawClean.indexOf('\n', lastMarker)
      const textPortion = nextNewline >= 0 ? rawClean.substring(nextNewline + 1) : ''
      const rawLines = textPortion.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean)
      const seen = new Set<string>()
      const spokenLines = rawLines.filter(line => {
        if (seen.has(line)) return false
        seen.add(line)
        return shouldSpeakLine(line)
      })
      if (spokenLines.length > 0) {
        const text = spokenLines.join(' ').replace(/\s+/g, ' ').trim()
        return { text, response, spokenLines }
      }
    }
  }

  // FALLBACK: No raw data or no tool markers — use terminal lines directly
  const deduped = response.map(line => line.trim()).filter(Boolean)
  const reversed: string[] = []
  let nonSpokenGap = 0
  for (let i = deduped.length - 1; i >= 0; i--) {
    const line = deduped[i]
    // Thinking indicators (Frosting, Cogitated, etc.) appear BETWEEN tool output
    // and conversational text — skip them as gaps, don't break on them.
    if (isToolLine(line) && !THINKING_RE.test(line)) break
    if (shouldSpeakLine(line)) {
      reversed.push(line)
      nonSpokenGap = 0
    } else {
      nonSpokenGap++
      if (nonSpokenGap >= 5 && reversed.length > 0) break
    }
  }
  const seen = new Set<string>()
  const spokenLines = reversed.reverse().filter(line => {
    if (seen.has(line)) return false
    seen.add(line)
    return true
  })

  const text = spokenLines.join(' ').replace(/\s+/g, ' ').trim() || 'Done.'
  return { text, response, spokenLines }
}

export default function TaskTerminal({ task, onNotesChange, isActive = true, autoCommand, onAutoCommandConsumed, pendingVoiceText, onVoiceTextConsumed, onClaudeResponse, onUploadsChanged, onSlashCommand, onLinkClick, onRegisterWriter }: Props) {
  const isAssistant = task.id === ASSISTANT_TASK_ID
  const ptyId = isAssistant ? 'task-assistant' : `task-${task.id}`
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<TerminalSession | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [connectKey, setConnectKey] = useState(0)
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const [notes, setNotes] = useState(task.notes || '')
  const [showNotes, setShowNotes] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)
  const notesTimer = useRef<NodeJS.Timeout>()
  const notesSavedTimer = useRef<NodeJS.Timeout>()
  const pendingNotesRef = useRef('')
  const quickNotesRef = useRef<HTMLTextAreaElement>(null)
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
  const taskTitleRef = useRef(task.title)
  taskTitleRef.current = task.title
  // Data buffer for PTY output arriving while terminal is hidden (prevents garbled rendering)
  const pendingDataRef = useRef<string | null>(null)
  const connectGenRef = useRef(0)

  // Auto-launch Claude: pipe context file if available, otherwise fall back to title
  const doAutoLaunch = useCallback(async (id: string) => {
    if (!needsAutoLaunchRef.current) return
    needsAutoLaunchRef.current = false
    let cmd: string
    if (autoCommandRef.current) {
      cmd = autoCommandRef.current
    } else if (isAssistant && contextPathRef.current) {
      const escaped = contextPathRef.current.replace(/'/g, "'\\''")
      cmd = `cat '${escaped}' | claude`
    } else if (contextPathRef.current) {
      // Pipe full task context (including previous session summaries) to Claude
      const escaped = contextPathRef.current.replace(/'/g, "'\\''")
      cmd = `cat '${escaped}' | claude "Help me with this task"`
    } else if (isAssistant) {
      cmd = `claude`
    } else {
      // Single-quote wrapping is safe against all shell metacharacters
      const escapedTitle = taskTitleRef.current.replace(/'/g, "'\\''")
      cmd = `claude '${escapedTitle}'`
    }
    const cb = onAutoCommandConsumedRef.current
    window.electronAPI.writePty(id, cmd + '\r')
    cb?.()
  }, [task.id, isAssistant])

  // Update notes state when task changes
  useEffect(() => { setNotes(task.notes || '') }, [task.id, task.notes])

  // Voice response detection — accumulate raw data, speak when Claude finishes (needs_input)
  const voiceBufferRef = useRef<{ raw: string; sent: string; pollInterval: ReturnType<typeof setInterval> | null; sawRunning: boolean; lastDataAt: number; lastSpokenHash: string; contentStableSince: number } | null>(null)
  const onClaudeResponseRef = useRef(onClaudeResponse)
  const lastVoiceDebugSignatureRef = useRef('')
  onClaudeResponseRef.current = onClaudeResponse
  const onVoiceTextConsumedRef = useRef(onVoiceTextConsumed)
  onVoiceTextConsumedRef.current = onVoiceTextConsumed
  const onSlashCommandInternalRef = useRef(onSlashCommand)
  onSlashCommandInternalRef.current = onSlashCommand
  const onLinkClickRef = useRef(onLinkClick)
  onLinkClickRef.current = onLinkClick

  // Clean up voice turn on unmount or task change only
  useEffect(() => {
    return () => {
      const vb = voiceBufferRef.current
      if (vb?.pollInterval) clearInterval(vb.pollInterval)
      voiceBufferRef.current = null
    }
  }, [task.id])

  // Inject voice transcript into the terminal and auto-submit
  useEffect(() => {
    if (!pendingVoiceText || !isActive) return

    if (voiceBufferRef.current?.pollInterval) clearInterval(voiceBufferRef.current.pollInterval)
    const vbNew = { raw: '', sent: pendingVoiceText.trim(), pollInterval: null as ReturnType<typeof setInterval> | null, sawRunning: false, lastDataAt: Date.now(), lastSpokenHash: '', contentStableSince: 0 }
    voiceBufferRef.current = vbNew
    lastVoiceDebugSignatureRef.current = ''

    try {
      window.electronAPI.debugWrite?.(
        buildVoiceDebugSnapshot({
          taskId: task.id,
          sent: vbNew.sent,
          status: 'submitted',
          hasObservedResponse: false,
          hasPrompt: false,
          idleForMs: 0,
          idleFallbackReady: false,
          spokenCount: 0,
          responseLines: [],
          rawLength: 0,
          stage: 'turn-start',
        })
      )
    } catch {}

    const finishVoiceTurn = (reason: string) => {
      if (voiceBufferRef.current !== vbNew) return
      if (vbNew.pollInterval) clearInterval(vbNew.pollInterval)
      vbNew.pollInterval = null
      voiceBufferRef.current = null

      const term = sessionRef.current?.terminal
      if (!term) {
        try {
          window.electronAPI.debugWrite?.(
            buildVoiceDebugSnapshot({
              taskId: task.id,
              sent: vbNew.sent,
              status: 'no-terminal',
              hasObservedResponse: vbNew.raw.trim().length > 0,
              hasPrompt: false,
              idleForMs: Date.now() - vbNew.lastDataAt,
              idleFallbackReady: false,
              spokenCount: 0,
              responseLines: vbNew.raw.split(/\r?\n/).filter(Boolean),
              rawLength: vbNew.raw.length,
              stage: 'finish-no-terminal',
              reason,
            })
          )
        } catch {}
        onClaudeResponseRef.current?.('Done.')
        return
      }

      const allLines = collectTerminalLines(term)
      const { text, response, spokenLines } = extractSpokenSummary(allLines, vbNew.sent, vbNew.raw)

      try {
        window.electronAPI.debugWrite?.([
              buildVoiceDebugSnapshot({
                taskId: task.id,
                sent: vbNew.sent,
                status: 'finished',
                hasObservedResponse: response.length > 0,
                hasPrompt: hasClaudePromptMarkers(response),
                idleForMs: Date.now() - vbNew.lastDataAt,
                idleFallbackReady: false,
                spokenCount: spokenLines.length,
                responseLines: response,
                rawLength: vbNew.raw.length,
                stage: 'finish',
                reason,
              }),
              '--- SPOKEN ---',
              ...spokenLines.map((l: string, i: number) => `S[${i}] ${l.substring(0, 120)}`),
              `FINAL: ${text.substring(0, 300)}`,
            ].join('\n'))
      } catch {}

      onClaudeResponseRef.current?.(text)
    }

    vbNew.pollInterval = setInterval(async () => {
      if (!voiceBufferRef.current || voiceBufferRef.current !== vbNew) return
      try {
        const statuses = await window.electronAPI.getPtyStatuses()
        const status = statuses[ptyId]
        if (status === 'running') vbNew.sawRunning = true

        const term = sessionRef.current?.terminal
        const allLines = term ? collectTerminalLines(term) : vbNew.raw.split(/\r?\n/)
        const responseLines = allLines.slice(findVoiceTurnStartIndex(allLines, vbNew.sent))
        const hasObservedResponse = responseLines.length > 0 || vbNew.raw.trim().length > 0
        const hasPrompt = hasClaudePromptMarkers(responseLines)
        const { spokenLines } = extractSpokenSummary(allLines, vbNew.sent, vbNew.raw)
        const idleForMs = Date.now() - vbNew.lastDataAt
        const idleFallbackReady = idleForMs >= VOICE_RESPONSE_IDLE_FALLBACK_MS && spokenLines.length >= 2
        const signature = [
          status || 'none',
          hasObservedResponse ? '1' : '0',
          hasPrompt ? '1' : '0',
          idleFallbackReady ? '1' : '0',
          spokenLines.length,
          responseLines.length,
        ].join('|')

        if (signature !== lastVoiceDebugSignatureRef.current) {
          lastVoiceDebugSignatureRef.current = signature
          try {
            window.electronAPI.debugWrite?.(
              buildVoiceDebugSnapshot({
                taskId: task.id,
                sent: vbNew.sent,
                status: status || 'none',
                hasObservedResponse,
                hasPrompt,
                idleForMs,
                idleFallbackReady,
                spokenCount: spokenLines.length,
                responseLines,
                rawLength: vbNew.raw.length,
                stage: 'poll',
              })
            )
          } catch {}
        }

        // Track when spoken content stabilizes (stops changing).
        // Claude Code's status bar always shows prompt markers, so hasPrompt alone
        // fires too early. Wait for content to stop changing for 3s AND PTY not running.
        // This prevents cutting off multi-paragraph responses during inter-paragraph pauses.
        const spokenHash = spokenLines.map(l => l.trim()).join('\n')
        if (spokenHash !== vbNew.lastSpokenHash) {
          vbNew.lastSpokenHash = spokenHash
          vbNew.contentStableSince = Date.now()
        }
        const contentStableMs = spokenLines.length > 0 && vbNew.contentStableSince
          ? Date.now() - vbNew.contentStableSince : 0
        const contentStableReady = contentStableMs >= 3000 && hasPrompt && spokenLines.length > 0 && status !== 'running'

        if (vbNew.sawRunning && hasObservedResponse && (
          status === 'needs_input' ||
          contentStableReady ||
          idleFallbackReady
        )) {
          const reason = status === 'needs_input'
            ? 'status-needs-input'
            : contentStableReady
              ? 'content-stable'
              : 'idle-fallback'
          finishVoiceTurn(reason)
        }
      } catch {}
    }, 500)

    window.electronAPI.writePty(ptyId, pendingVoiceText + '\r')
    onVoiceTextConsumedRef.current?.()

    // Cleanup: clear the interval if pendingVoiceText changes before finishVoiceTurn fires.
    // finishVoiceTurn sets pollInterval to null first, so clearInterval on null is a no-op.
    return () => {
      if (vbNew.pollInterval) clearInterval(vbNew.pollInterval)
    }
  }, [pendingVoiceText, isActive, task.id])

  const saveNotes = useCallback((text: string) => {
    pendingNotesRef.current = text
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(async () => {
      await window.electronAPI.updateNotes(task.id, text)
      pendingNotesRef.current = ''
      setNotesSaved(true)
      if (notesSavedTimer.current) clearTimeout(notesSavedTimer.current)
      notesSavedTimer.current = setTimeout(() => setNotesSaved(false), 1500)
    }, 1000)
  }, [task.id])

  // Flush pending notes on unmount/task-switch — prevents silent data loss when terminal pool evicts component
  useEffect(() => () => {
    if (notesTimer.current && pendingNotesRef.current) {
      clearTimeout(notesTimer.current)
      if (!isAssistant) window.electronAPI.updateNotes(task.id, pendingNotesRef.current).catch(() => {})
      pendingNotesRef.current = ''
    }
  }, [task.id])
  // Clear notesSaved timer on unmount to prevent setState on unmounted component
  useEffect(() => () => { if (notesSavedTimer.current) clearTimeout(notesSavedTimer.current) }, [])

  // Auto-grow quick-notes textarea to fit content
  useEffect(() => {
    const el = quickNotesRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [notes])

  // When terminal becomes active/visible, flush any pending scrollback,
  // refit, and trigger deferred auto-launch if needed.
  // IMPORTANT: fit() is called exactly once AFTER all pending data is written
  // to prevent resize race conditions that scramble text during scroll.
  useEffect(() => {
    if (isActive && sessionRef.current) {
      const session = sessionRef.current
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
      // Auto-launch Claude if we haven't launched yet.
      if (needsAutoLaunchRef.current) {
        doAutoLaunch(ptyId)
      }
    }
  }, [isActive, doAutoLaunch, task.id])

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
      // startPty reconnects to existing PTY if one is running (doesn't kill it)
      const result = await window.electronAPI.startPty(isAssistant ? 'assistant' : String(task.id))
      if (!result.ok || !mountedRef.current || gen !== connectGenRef.current) return

      // Store context path for auto-launch
      if (result.contextPath) {
        contextPathRef.current = result.contextPath
      }

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
      // Skip if: reconnecting to live PTY (existing) or reattaching to tmux session
      // (Claude is still alive inside tmux).
      if (!result.existing && !result.tmuxReattached) {
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

        // Voice: accumulate raw data with a 2MB cap to prevent unbounded memory growth.
        if (voiceBufferRef.current) {
          voiceBufferRef.current.raw += data
          if (voiceBufferRef.current.raw.length > 2 * 1024 * 1024) {
            voiceBufferRef.current.raw = voiceBufferRef.current.raw.slice(-2 * 1024 * 1024)
          }
          voiceBufferRef.current.sawRunning = true
          voiceBufferRef.current.lastDataAt = Date.now()
        }
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
      session.onResize((cols, rows) => window.electronAPI.resizePty(ptyId, cols, rows))

      // Intercept Cmd+V for image paste
      // preventDefault must be synchronous (before any await) to suppress the
      // browser's native paste and xterm's 'paste' event handler.
      // If no image is found, fall back to reading clipboard text manually.
      const pasteHandler = async (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
          e.preventDefault()
          e.stopPropagation()
          const result = await window.electronAPI.pasteImage()
          if (result.ok && result.path) {
            // Type the image path into the terminal (e.g. for Claude Code to pick up)
            window.electronAPI.writePty(ptyId, result.path)
          } else {
            // No image — paste text via xterm to preserve bracketed-paste-mode wrapping
            try {
              const text = await navigator.clipboard.readText()
              if (text) session.terminal.paste(text)
            } catch { /* clipboard read failed (e.g. permission denied) */ }
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
      session.dispose()
      // DON'T kill PTY — it persists in the main process so the user can
      // switch back to this task and reconnect to the same terminal session
    }
  }, [task.id, connectKey])

  const handleTerminalDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    if (isConnected) {
      const paths = files.map(f => {
        const fp = (f as any).path as string | undefined
        if (!fp) return f.name
        const safe = fp.replace(/'/g, "'\\''")
        return `'${safe}'`
      }).join(' ')
      window.electronAPI.writePty(ptyId, paths)
    }
    if (!isAssistant) {
      uploadFiles(task.id, files).then(() => onUploadsChanged?.())
    }
  }, [isConnected, ptyId, isAssistant, task.id, onUploadsChanged])

  const sourceColors = TERMINAL_SOURCE_COLORS

  return (
    <div className="flex-1 flex flex-col">
      {/* Task header */}
      <div className="border-b border-black/[0.06] bg-surface-0">
        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[13px] font-semibold truncate" title={task.title}>{task.title}</span>
            {task.company_name && (
              <>
                <span aria-hidden="true" className="text-text-3/30 mx-0.5 shrink-0">·</span>
                <span className="text-[11px] text-text-3 truncate">{task.company_name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isAssistant && (
              <button onClick={() => setShowNotes(!showNotes)}
                title="Toggle quick notes"
                aria-pressed={showNotes}
                aria-label="Toggle notes panel"
                className={`text-[10px] px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  showNotes ? 'bg-black/[0.06] text-text-1' : 'text-text-2 hover:text-text-1 hover:bg-black/[0.04]'
                }`}>
                Notes
              </button>
            )}
            <span
              role="status"
              title="Connection status"
              aria-label={isConnected ? 'Terminal connected' : 'Terminal disconnected'}
              className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-1' : 'bg-surface-4'}`}
            />
            {!isConnected && <button onClick={() => setConnectKey(k => k + 1)} title="Reconnect to terminal" aria-label="Reconnect to terminal" className="text-[10px] px-2 py-0.5 rounded bg-black/[0.04] text-text-3 hover:text-text-2 cursor-pointer transition-colors">Reconnect</button>}
          </div>
        </div>

        {/* Metadata pills — hidden for assistant tasks only */}
        {!isAssistant && <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          <span
            aria-label={`Priority: ${task.priority}`}
            className={`text-[9px] font-medium px-2 py-0.5 rounded-md ${
              task.priority === 'urgent' ? 'bg-red-2 text-red-1' :
              task.priority === 'high' ? 'bg-red-2 text-red-1' :
              task.priority === 'low' ? 'bg-black/[0.04] text-text-3' :
              'bg-black/[0.04] text-text-2'
            }`}>
            {task.priority === 'urgent' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-1 mr-1 animate-pulse" />}
            {task.priority === 'high' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-1 mr-1" />}
            {task.priority === 'urgent' ? 'Urgent!' : task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
          </span>
          <span
            aria-label={`Source: ${TERMINAL_SOURCE_LABELS[task.source] ?? task.source}`}
            className={`text-[9px] font-medium px-2 py-0.5 rounded-md ${sourceColors[task.source] || 'bg-black/[0.04] text-text-2'}`}>
            {TERMINAL_SOURCE_LABELS[task.source] ?? task.source.replace(/_/g, ' ')}
          </span>
          {task.due_date && (
            <span
              aria-label={`Due: ${new Date(task.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
              className="text-[9px] font-medium px-2 py-0.5 rounded-md bg-black/[0.04] text-text-2">
              Due {new Date(task.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
          {task.is_recurring && (
            <span aria-label="Recurring task" className="text-[9px] font-medium px-2 py-0.5 rounded-md bg-amber-400/10 text-amber-400">Recurring</span>
          )}
          {task.source === 'crm' && task.source_id && window.__CRM_BASE_URL && (
            <a href={`${window.__CRM_BASE_URL}/objects/task/records/${task.source_id}`}
              className="text-[9px] font-medium px-2 py-0.5 rounded-md bg-blue-2 text-blue-1 hover:bg-blue-2/80 transition-all"
              target="_blank" rel="noopener noreferrer">
              Open in CRM
            </a>
          )}
        </div>}

        {/* Notes panel (collapsible) */}
        {showNotes && (
          <div className="px-4 pb-3 border-t border-black/[0.06] pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[9px] font-semibold text-text-3 uppercase tracking-wider">Notes</span>
              {notesSaved && <span className="text-[9px] text-green-1 font-medium">Saved</span>}
            </div>
            <textarea ref={quickNotesRef} value={notes} rows={1}
              aria-label="Quick notes for this task"
              onChange={e => { setNotes(e.target.value); saveNotes(e.target.value) }}
              placeholder="Write notes, use **bold** or [link](url)..."
              className="w-full bg-transparent border-none rounded-lg px-0 py-0 text-[12px] text-text-1 placeholder-text-3/40 focus:outline-none resize-none leading-relaxed max-h-[120px] overflow-y-auto" />
          </div>
        )}
      </div>

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
