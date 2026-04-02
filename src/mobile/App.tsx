import React, { useState, useEffect, useCallback } from 'react'
import { connect, disconnect, isConnected, setConnectionCallback, api, on } from './api'
import TaskList from './components/TaskList'
import TerminalView from './components/TerminalView'

// ═══════════════════════════════════════════
//  ROCA Remote — Mobile App (iOS Light)
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

type Screen = 'connect' | 'tasks' | 'terminal'

export default function App() {
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

  // Connection state callback
  useEffect(() => {
    setConnectionCallback((c) => {
      setConnected(c)
    })
  }, [screen])

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
    } catch (e: any) {
      setConnectError(e.message || 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  const loadTasks = useCallback(async () => {
    try {
      const w = await api.getCurrentWeek()
      setWeek(w)
      const [foldersData, unfoldered] = await Promise.all([
        api.getFolders({ week: w }),
        api.getOpenUnfoldered({ week: w }),
      ])
      setFolders(foldersData || [])
      setUnfolderedTasks(unfoldered || [])
    } catch (e) {
      console.error('Failed to load tasks:', e)
    }
  }, [])

  const openTerminal = (task: Task) => {
    setSelectedTask(task)
    setScreen('terminal')
  }

  const goBack = () => {
    setSelectedTask(null)
    setScreen('tasks')
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
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)' }}>
            <input
              type="text"
              placeholder="Host (e.g. app.p-roca.com)"
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
            className="w-full rounded-xl py-3.5 text-[16px] font-semibold text-white transition-all disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
          >
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
          {connectError && (
            <p className="text-sm text-center" style={{ color: 'var(--red)' }}>{connectError}</p>
          )}
        </div>
      </div>
    )
  }

  // ── Terminal Screen ──
  if (screen === 'terminal' && selectedTask) {
    return (
      <TerminalView
        task={selectedTask}
        onBack={goBack}
        ptyStatus={ptyStatuses[`task-${selectedTask.id}`] || null}
      />
    )
  }

  // ── Task List Screen ──
  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Connection lost overlay */}
      {!connected && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(242, 242, 247, 0.95)' }}>
          <div className="text-center px-8">
            <div className="text-base mb-4" style={{ color: 'var(--text-primary)' }}>Connection lost</div>
            <div className="text-sm mb-6" style={{ color: 'var(--text-tertiary)' }}>Attempting to reconnect...</div>
            <button
              onClick={() => { disconnect(); setScreen('connect') }}
              className="rounded-xl px-6 py-3 text-sm font-semibold text-white"
              style={{ background: 'var(--accent)' }}
            >
              Reconnect
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-2 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '0.33px solid var(--separator)' }}>
        <div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>ROCA</h1>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{week}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <button
            onClick={() => { disconnect(); setScreen('connect') }}
            className="text-[12px] font-medium"
            style={{ color: 'var(--accent)' }}
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
          onSelectTask={openTerminal}
          onRefresh={loadTasks}
        />
      </div>
    </div>
  )
}
