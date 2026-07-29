import React, { useState, useEffect, useCallback, useRef } from 'react'
import { connect, disconnect, isConnected, setConnectionCallback, api, on } from './api'
import { TaskList } from './components/task-list'
import { TaskDetail } from './components/task-detail'
import { CreateTask } from './components/create-task'
import { TerminalView } from './components/terminal-view'

// ═══════════════════════════════════════════
//  ROCA Remote — Mobile App (iOS)
// ═══════════════════════════════════════════

interface Task {
  id: number
  title: string
  status: string
  priority: string
  source: string
  company_name: string | null
  deal_name: string | null
  due_date: string | null
  notes: string | null
  folder_id: number | null
  week: string
  scheduled_at?: string | null
  triaged_at?: string | null
}

interface Folder {
  id: number
  name: string
  color: string
  tasks?: Task[]
}

type Screen = 'connect' | 'tasks' | 'detail' | 'terminal' | 'create'

export function App() {
  const [screen, setScreen] = useState<Screen>('connect')
  const [connected, setConnected] = useState(false)
  const [host, setHost] = useState(localStorage.getItem('roca-host') || '')
  const [token, setToken] = useState(localStorage.getItem('roca-token') || '')
  const [connectError, setConnectError] = useState('')
  const [connecting, setConnecting] = useState(false)

  const [folders, setFolders] = useState<Folder[]>([])
  const [unfolderedTasks, setUnfolderedTasks] = useState<Task[]>([])
  const [ptyStatuses, setPtyStatuses] = useState<Record<string, string>>({})
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [week, setWeek] = useState('')
  const [inboxCount, setInboxCount] = useState(0)

  // Connection state callback
  useEffect(() => {
    setConnectionCallback((c) => {
      setConnected(c)
    })
  }, [])

  // Auto-connect if saved credentials
  useEffect(() => {
    const savedHost = localStorage.getItem('roca-host')
    const savedToken = localStorage.getItem('roca-token')
    if (savedHost && savedToken) {
      const currentHost = location.hostname.includes('.') && !location.hostname.match(/^\d/)
        ? location.host
        : savedHost
      setHost(currentHost)
      setToken(savedToken)
      handleConnect(currentHost, savedToken)
    }
  }, [])

  // Auto-fill host from current URL if it's a tunnel
  useEffect(() => {
    if (!host && location.hostname.includes('.') && !location.hostname.match(/^\d/)) {
      setHost(location.host)
    }
  }, [])

  // Listen for PTY status updates
  useEffect(() => {
    const unsub = on('pty:statuses', (data: Record<string, string>) => {
      setPtyStatuses(data)
    })
    return unsub
  }, [])

  const handleConnect = async (h?: string, t?: string) => {
    const useHost = h || host
    const useToken = t || token
    if (!useHost || !useToken) return

    setConnecting(true)
    setConnectError('')
    try {
      await connect(useHost, useToken)
      setScreen('tasks')
      loadTasks()
    } catch (e: unknown) {
      setConnectError(e instanceof Error ? e.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  const [loading, setLoading] = useState(false)
  const lastLoadRef = useRef(0)

  const loadTasks = useCallback(async (force = false) => {
    // Debounce: don't reload within 500ms
    const now = Date.now()
    if (!force && now - lastLoadRef.current < 500) return
    lastLoadRef.current = now

    setLoading(true)
    try {
      const w = await api.getCurrentWeek()
      setWeek(w)
      const [foldersData, unfoldered, inbox] = await Promise.all([
        api.getFolders({ week: w }),
        api.getOpenUnfoldered({ week: w }),
        api.getInboxCount(w).catch(() => 0),
      ])
      setFolders(foldersData || [])
      setUnfolderedTasks(unfoldered || [])
      setInboxCount(inbox || 0)
    } catch (e) {
      console.error('Failed to load tasks:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const openDetail = (task: Task) => {
    setSelectedTask(task)
    setScreen('detail')
  }

  const openTerminal = (task?: Task) => {
    if (task) setSelectedTask(task)
    setScreen('terminal')
  }

  const goBack = () => {
    setSelectedTask(null)
    setScreen('tasks')
    loadTasks()
  }

  const goBackFromTerminal = () => {
    if (selectedTask) {
      setScreen('detail')
    } else {
      setScreen('tasks')
    }
    loadTasks()
  }

  // ── Connect Screen ──
  if (screen === 'connect') {
    return (
      <div className="h-screen flex flex-col items-center justify-center px-8" style={{ background: 'var(--bg-primary)' }}>
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center mb-4 shadow-lg">
          <span className="text-white text-2xl font-bold">R</span>
        </div>
        <div className="text-2xl font-bold mb-1 tracking-tight" style={{ color: 'var(--text-primary)' }}>ROCA</div>
        <p className="text-sm mb-8" style={{ color: 'var(--text-tertiary)' }}>Connect to your Mac</p>

        <div className="w-full max-w-xs space-y-3">
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', boxShadow: '0 0.5px 2px rgba(0,0,0,0.06)' }}>
            <input
              type="text"
              placeholder="Host"
              value={host}
              onChange={e => setHost(e.target.value)}
              className="w-full px-4 py-3.5 text-[16px] outline-none"
              style={{ background: 'transparent', color: 'var(--text-primary)', borderBottom: '0.33px solid var(--separator)' }}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <input
              type="text"
              placeholder="Token"
              value={token}
              onChange={e => setToken(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter' && host && token) handleConnect() }}
              className="w-full px-4 py-3.5 text-[16px] tracking-[0.3em] text-center font-mono outline-none"
              style={{ background: 'transparent', color: 'var(--text-primary)' }}
              autoCapitalize="characters"
              autoCorrect="off"
              maxLength={6}
            />
          </div>
          <button
            onClick={() => handleConnect()}
            disabled={connecting || !host || !token}
            className="w-full rounded-xl py-3.5 text-[16px] font-semibold text-white disabled:opacity-40"
            style={{ background: 'var(--accent)', transition: 'opacity 0.15s' }}
          >
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
          {connectError && (
            <p className="text-sm text-center mt-2" style={{ color: 'var(--red)' }}>{connectError}</p>
          )}
        </div>
      </div>
    )
  }

  // ── Create Task Screen ──
  if (screen === 'create') {
    return (
      <CreateTask
        week={week}
        folders={folders.map(f => ({ id: f.id, name: f.name, color: f.color }))}
        onBack={() => setScreen('tasks')}
        onCreated={() => { setScreen('tasks'); loadTasks() }}
      />
    )
  }

  // ── Task Detail Screen ──
  if (screen === 'detail' && selectedTask) {
    return (
      <TaskDetail
        task={selectedTask}
        folders={folders.map(f => ({ id: f.id, name: f.name, color: f.color }))}
        onBack={goBack}
        onOpenTerminal={() => openTerminal()}
        onTaskUpdated={loadTasks}
      />
    )
  }

  // ── Terminal Screen ──
  if (screen === 'terminal' && selectedTask) {
    return (
      <TerminalView
        task={selectedTask}
        onBack={goBackFromTerminal}
        ptyStatus={ptyStatuses[`task-${selectedTask.id}`] || null}
      />
    )
  }

  // ── Task List Screen ──
  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Connection lost overlay — semi-transparent with retry */}
      {!connected && (
        <div className="absolute inset-0 z-50 flex items-end justify-center pb-32" style={{ background: 'rgba(242, 242, 247, 0.85)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
          <div className="text-center px-8">
            <div className="mv-spinner mx-auto mb-4" style={{ width: 24, height: 24 }} />
            <div className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Connection lost</div>
            <div className="text-sm mb-6 mv-reconnecting" style={{ color: 'var(--text-tertiary)' }}>Reconnecting...</div>
            <button
              onClick={() => { disconnect(); setScreen('connect') }}
              className="rounded-xl px-8 py-3 text-sm font-semibold"
              style={{ background: 'rgba(0,0,0,0.06)', color: 'var(--text-secondary)', border: 'none' }}
            >
              Back to Connect
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="shrink-0 px-4 pb-2 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '0.33px solid var(--separator)', paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>ROCA</h1>
            {loading && <div className="mv-spinner" style={{ width: 14, height: 14, borderWidth: 1.5 }} />}
          </div>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{week}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Create task button */}
          <button
            onClick={() => setScreen('create')}
            aria-label="Create task"
            style={{ width: 30, height: 30, borderRadius: 15, background: 'var(--accent)', border: 'none', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 300, lineHeight: 1 }}
          >
            +
          </button>
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <button
            onClick={() => { disconnect(); setScreen('connect') }}
            className="text-[12px] font-medium"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto pb-20" style={{ WebkitOverflowScrolling: 'touch' }}>
        <TaskList
          folders={folders}
          unfolderedTasks={unfolderedTasks}
          ptyStatuses={ptyStatuses}
          inboxCount={inboxCount}
          onSelectTask={openDetail}
          onRefresh={loadTasks}
        />
      </div>
    </div>
  )
}
