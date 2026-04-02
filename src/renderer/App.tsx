import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import WeeklyView from './components/WeeklyView'
import RightPanel, { type PanelTab } from './components/RightPanel'
import TopNav, { type NavTab } from './components/TopNav'
import FilePathView from './components/FilePathView'
import ProjectsView from './components/ProjectsView'
import FeedbackModal from './components/FeedbackModal'
import type { Task, TaskStatus, Folder, DelegateCache, DelegateMessage, DelegateExecution } from '@shared/types'
import { ASSISTANT_TASK_ID, ACTIVE_STATUSES } from '@shared/constants'
import { currentIsoWeek, isoWeeksInYear } from './lib/formatDate'

export { ASSISTANT_TASK_ID }

export const ASSISTANT_TASK: Task = {
  id: ASSISTANT_TASK_ID,
  title: 'ROCA Assistant',
  source: 'assistant',
  source_id: null,
  priority: 'medium',
  status: 'open' as TaskStatus,
  due_date: null,
  company_name: null,
  deal_name: null,
  notes: null,
  week: '',
  created_at: '',
  completed_at: null,
  triaged_at: null,
  scheduled_at: null,
  folder_id: null,
  project_id: null,
  sort_order: 0,
}

export interface WeekData {
  id: number
  week: string
  challenges: string
  meetings_held: number
  created_at: string
}

declare global {
  interface Window {
    electronAPI: {
      // Environment
      getEnv: (key: string) => Promise<string | null>
      debugWrite?: (content: string) => Promise<void>
      voiceLogSession: (entry: {
        event: string; state: string; taskId: number | null; tab: string;
        error?: string; spokenText?: string; transcript?: string;
      }) => Promise<boolean>

      // Tasks
      getTasks: (opts?: { week?: string; source?: string }) => Promise<Task[]>
      createTask: (task: { title: string; priority?: string; notes?: string }) => Promise<{ id: number }>
      toggleTask: (taskId: number) => Promise<Task>
      duplicateTask: (taskId: number) => Promise<{ id: number | null }>
      getTask: (taskId: number) => Promise<Task>
      updateNotes: (taskId: number, notes: string) => Promise<{ ok: boolean }>
      updateTaskFields: (taskId: number, fields: Record<string, unknown>) => Promise<{ ok: boolean }>
      updateTaskStatus: (taskId: number, status: string) => Promise<{ ok: boolean }>
      reorderTasks: (taskIds: number[]) => Promise<{ ok: boolean }>
      scheduleTask: (taskId: number, scheduledAt: string | null) => Promise<{ ok: boolean }>
      makeRecurring: (taskId: number) => Promise<number>
      unmakeRecurring: (taskId: number) => Promise<{ ok: boolean }>
      isRecurring: (title: string) => Promise<boolean>
      populateTaskFlags: (tasks: Task[]) => Promise<Task[]>

      // Completed / Week
      getCompletedInWeek: (week?: string) => Promise<Task[]>
      getWeekData: (week?: string) => Promise<WeekData>
      updateChallenges: (week: string, text: string) => Promise<{ ok: boolean }>
      updateMeetings: (week: string, count: number) => Promise<{ ok: boolean }>

      // Sync
      syncAll: () => Promise<{ count: number }>


      // Delegate cache
      getDelegateCache: (taskId: number) => Promise<DelegateCache | null>
      saveDelegateCache: (
        taskId: number, plan: string, context: string,
        cost: number, turns: number, error: string | null, sessionId?: string | null
      ) => Promise<{ ok: boolean }>
      clearDelegateCache: (taskId: number) => Promise<{ ok: boolean }>

      // Delegate executions
      createExecution: (taskId: number) => Promise<DelegateExecution>
      updateExecution: (execId: number, status: string, output?: string | null, cost?: number) => Promise<{ ok: boolean }>
      getExecution: (execId: number) => Promise<DelegateExecution>
      getLatestExecution: (taskId: number) => Promise<DelegateExecution | null>

      // Delegate messages
      addDelegateMessage: (taskId: number, role: string, content: string, cost?: number, turns?: number) => Promise<{ id: number }>
      getDelegateMessages: (taskId: number) => Promise<DelegateMessage[]>
      clearDelegateMessages: (taskId: number) => Promise<{ ok: boolean }>
      getDelegateMessageCount: (taskId: number, role?: string) => Promise<number>

      // Delegate AI
      delegateAnalyze: (taskId: number, userContext?: string) => Promise<any>
      delegateRefine: (taskId: number, feedback: string) => Promise<any>
      delegateExecute: (taskId: number) => Promise<any>
      delegateLearn: (taskId: number) => Promise<any>

      // Folders
      getFolders: (opts?: { week?: string; source?: string; priority?: string }) => Promise<Folder[]>
      createFolder: (name: string, color?: string) => Promise<{ id: number }>
      renameFolder: (folderId: number, name: string) => Promise<{ ok: boolean }>
      toggleFolderCollapse: (folderId: number) => Promise<{ ok: boolean }>
      deleteFolder: (folderId: number) => Promise<{ ok: boolean }>
      setTaskFolder: (taskId: number, folderId?: number | null) => Promise<{ ok: boolean }>
      updateFolderColor: (folderId: number, color: string) => Promise<{ ok: boolean }>
      reorderFolders: (folderIds: number[]) => Promise<{ ok: boolean }>
      getFolderColors: () => Promise<string[]>

      // Inbox
      getInboxTasks: (week?: string) => Promise<Task[]>
      getInboxCount: (week?: string) => Promise<number>
      triageTask: (taskId: number) => Promise<{ ok: boolean }>

      // Organize
      organizePreview: (week?: string) => Promise<any>
      organizeApply: (week?: string) => Promise<any>

      // Journal
      getJournal: () => Promise<{ journal?: string; prompt?: string }>

      // Warp
      openWarp: (script?: string) => Promise<{ ok: boolean }>

      // App updates
      restartApp: () => Promise<void>
      fullRestartApp: () => Promise<void>
      onUpdateAvailable: (callback: () => void) => () => void
      onRebuilding: (callback: () => void) => () => void
      onNavigateTask: (callback: (taskId: number) => void) => () => void
      onBrowserOpen: (callback: (data: { taskId?: number; url: string }) => void) => () => void

      // PTY
      startPty: (taskId: string, cwd?: string) => Promise<{ ok: boolean; id: string; existing: boolean; tmuxReattached?: boolean; savedScrollback?: string; contextPath?: string }>
      getPtyScrollback: (id: string) => Promise<string>
      getPtyStatuses: () => Promise<Record<string, string>>
      writePty: (id: string, data: string) => void
      resizePty: (id: string, cols: number, rows: number) => void
      killPty: (id: string) => Promise<{ ok: boolean }>
      pasteImage: () => Promise<{ ok: boolean; path: string | null }>
      uploadFile: (taskId: number, fileData: { buffer: Uint8Array; filename: string; mimeType: string }) => Promise<any>
      getUploadsForTask: (taskId: number) => Promise<any[]>
      deleteUpload: (uploadId: number) => Promise<{ ok: boolean }>
      serveUpload: (filename: string) => Promise<Uint8Array<ArrayBuffer> | null>
      serveUploadPath: (storedName: string) => Promise<{ path: string } | null>
      parseExcelStyled: (storedName: string) => Promise<{ sheets?: { name: string; html: string }[]; error?: string }>
      convertUploadToPdf: (storedName: string) => Promise<{ path?: string; error?: string } | null>
      convertDocxToHtml: (storedName: string) => Promise<{ html?: string; error?: string }>
      showItemInFolder: (storedName: string) => Promise<void>
      onPtyData: (id: string, callback: (data: string) => void) => () => void
      onPtyExit: (id: string, callback: (exitCode: number) => void) => () => void

      // Chrome Extensions
      loadExtension: (extensionPath: string) => Promise<{ ok: boolean; id?: string; name?: string; error?: string }>
      listExtensions: () => Promise<{ id: string; name: string; path: string }[]>
      removeExtension: (extensionId: string) => Promise<{ ok: boolean; error?: string }>

      // Browser
      createBrowserSession: (taskId: number, mode: string) => Promise<any>
      destroyBrowserSession: (taskId: number) => Promise<{ ok: boolean }>
      getBrowserSession: (taskId: number) => Promise<any>
      browserRegisterWebContents: (taskId: number, webContentsId: number) => Promise<{ ok: boolean }>
      browserNavigate: (taskId: number, url: string) => Promise<{ ok: boolean }>
      browserNavAction: (taskId: number, action: string, url?: string) => Promise<{ ok: boolean }>
      browserSendInstruction: (taskId: number, instruction: string) => Promise<{ ok: boolean; error?: string }>
      browserStopClaude: (taskId: number) => Promise<{ ok: boolean }>
      browserSaveTabs: (taskId: number, tabs: { url: string; title: string }[], activeIndex: number) => Promise<{ ok: boolean }>
      browserLoadTabs: (taskId: number) => Promise<{ tabs: { url: string; title: string }[]; activeIndex: number } | null>
      browserDeleteTabs: (taskId: number) => Promise<{ ok: boolean }>
      onBrowserStatus: (taskId: number, callback: (status: any) => void) => () => void
      onBrowserThought: (taskId: number, callback: (thought: string) => void) => () => void

      // Popout
      popoutOpen: (opts: { taskId: number; tab: string; taskTitle?: string }) => Promise<{ ok: boolean }>
      popoutClose: (opts: { taskId: number; tab: string }) => Promise<{ ok: boolean }>
      popoutGetParams: () => Promise<{ popout: boolean; taskId: number | null; tab: string | null }>
      onPopoutClosed: (callback: (data: { taskId: number; tab: string }) => void) => () => void

      // Projects
      projectsList: () => Promise<any[]>
      projectsAdd: (repoPath: string) => Promise<{ ok: boolean; id: string }>
      projectsRemove: (id: string) => Promise<{ ok: boolean }>
      projectsGitStatus: (id: string) => Promise<{ branch: string; status: string }>
      projectsGitLog: (id: string) => Promise<{ commits: string[] }>
      projectsGetTasks: (projectId: string) => Promise<Task[]>
      projectsSetTaskProject: (taskId: number, projectId: string | null) => Promise<{ ok: boolean }>

      // Tools / Integrations
      getTools: () => Promise<any[]>
      createTool: (tool: {
        name: string; description?: string; category?: string;
        connection_type?: string; status?: string; config?: string;
        icon?: string; capabilities?: string; account?: string; details?: string;
      }) => Promise<{ id: number }>
      updateTool: (toolId: number, fields: Record<string, unknown>) => Promise<{ ok: boolean }>
      deleteTool: (toolId: number) => Promise<{ ok: boolean }>

      // Alignment
      getAlignment: () => Promise<string>
      saveAlignment: (content: string) => Promise<{ ok: boolean }>

      // Skills
      listSkills: () => Promise<{ name: string; path: string; dir: string; content: string }[]>
      getSkill: (skillPath: string) => Promise<string>
      saveSkill: (skillPath: string, content: string) => Promise<{ ok: boolean }>

      // Task context
      generateTaskContext: (taskId: number) => Promise<{ path: string }>

      // Agents
      agentsList: () => Promise<{
        name: string; label: string; running: boolean;
        pid: number | null; lastExitCode: number | null;
        schedule: string | null; stateFile: string | null;
        alertOwner: boolean; outputDir: string | null
      }[]>
      agentsState: (agentName: string) => Promise<Record<string, unknown> | null>
      agentsLogs: (agentLabel: string, lines?: number) => Promise<string>
      agentsStart: (agentLabel: string) => Promise<{ ok: boolean; error?: string }>
      agentsStop: (agentLabel: string) => Promise<{ ok: boolean; error?: string }>
      agentsOpenOutput: (agentLabel: string) => Promise<{ ok: boolean }>
      agentsFiles: (agentName: string) => Promise<Array<{ label: string; path: string; type: 'file' | 'dir'; category: string }>>
      agentsReadFile: (filePath: string) => Promise<{ ok: boolean; content: string; size: number }>
      toolsFiles: (toolName: string) => Promise<Array<{ label: string; path: string; type: 'file' | 'dir'; category: string }>>

      // FilePath
      filePathGetRoot: () => Promise<{ projectRoot: string; rocaDir: string }>
      filePathListDir: (dirPath: string) => Promise<{ name: string; path: string; isDirectory: boolean; size?: number; modifiedAt?: string; childCount?: number }[]>
      filePathReadFile: (filePath: string) => Promise<{ ok: boolean; content: string; size: number }>
      filePathSaveFile: (filePath: string, content: string) => Promise<{ ok: boolean }>

    }
    /** CRM base URL for deep links (set from env var at startup) */
    __CLARIFY_BASE_URL?: string
  }
}


// Initialize CRM base URL from env (set via main process IPC)
// This runs once at module load and makes the URL available for deep links.
try {
  window.electronAPI?.getEnv?.('CLARIFY_APP_URL').then((url: string | null) => {
    if (url) window.__CLARIFY_BASE_URL = url
  })
} catch { /* ignore — env not available */ }

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [completedTasks, setCompletedTasks] = useState<Task[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(() => {
    const saved = localStorage.getItem('roca:selectedTaskId')
    if (!saved) return null
    const parsed = parseInt(saved)
    return isNaN(parsed) ? null : parsed
  })
  const [week, setWeek] = useState(currentIsoWeek())
  const [weekData, setWeekData] = useState<WeekData | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [organizeError, setOrganizeError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const saved = localStorage.getItem('roca:activeTab')
    // Migrate old tab names to new ones
    if (saved === 'journal' || saved === 'tools' || saved === 'agents') return 'filepath'
    const VALID_TABS: NavTab[] = ['week', 'filepath']
    return VALID_TABS.includes(saved as NavTab) ? (saved as NavTab) : 'week'
  })
  const [projectsPanelOpen, setProjectsPanelOpen] = useState(false)
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderColors, setFolderColors] = useState<string[]>([])
  const [feedbackModal, setFeedbackModal] = useState<{ type: 'feature' | 'bug' } | null>(null)
  // Fire-once tab trigger: set to 'terminal' in handleFeedbackSubmit, RightPanel switches then
  // calls onTabChanged() which resets it to 'notes'. This is intentionally event-via-state.
  const [rightPanelTab, setRightPanelTab] = useState<PanelTab>('notes')
  const [pendingAutoCommand, setPendingAutoCommand] = useState<string | null>(null)
  const [pendingVoiceText, setPendingVoiceText] = useState<string | null>(null)
  const [lastClaudeResponse, setLastClaudeResponse] = useState<string | null>(null)
  const [projectSelectedTask, setProjectSelectedTask] = useState<Task | null>(null)
  const projectSelectedTaskRef = useRef<Task | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [ptyStatuses, setPtyStatuses] = useState<Record<string, string>>({})
  const [assistantActive, setAssistantActive] = useState(false)

  // Cmd+Shift+A toggles ROCA Assistant
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setAssistantActive(prev => {
          if (!prev) {
            setSelectedTaskId(null)
            setProjectSelectedTask(null)
            setActiveTab('week')
          }
          return !prev
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Listen for navigate-task from main process (RPC)
  useEffect(() => {
    const cleanup = window.electronAPI.onNavigateTask((taskId: number) => {
      setSelectedTaskId(taskId)
      setAssistantActive(false)
      setProjectSelectedTask(null)
      setActiveTab('week')
    })
    return cleanup
  }, [])

  // Persist UI state to localStorage so it survives hot-reloads
  useEffect(() => {
    if (selectedTaskId != null) {
      localStorage.setItem('roca:selectedTaskId', String(selectedTaskId))
    } else {
      localStorage.removeItem('roca:selectedTaskId')
    }
  }, [selectedTaskId])

  useEffect(() => {
    localStorage.setItem('roca:activeTab', activeTab)
  }, [activeTab])

  // Resizable left panel
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    const saved = localStorage.getItem('roca:leftPanelWidth')
    return saved ? parseInt(saved, 10) : 460
  })
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(() => {
    return localStorage.getItem('roca:leftPanelCollapsed') === 'true'
  })

  useEffect(() => {
    localStorage.setItem('roca:leftPanelWidth', String(leftPanelWidth))
  }, [leftPanelWidth])

  useEffect(() => {
    localStorage.setItem('roca:leftPanelCollapsed', String(leftPanelCollapsed))
  }, [leftPanelCollapsed])
  const isResizing = useRef(false)
  const leftPanelWidthRef = useRef(leftPanelWidth)
  leftPanelWidthRef.current = leftPanelWidth
  const LEFT_MIN = 300
  const LEFT_MAX = 600

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = leftPanelWidthRef.current

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = Math.min(LEFT_MAX, Math.max(LEFT_MIN, startWidth + (e.clientX - startX)))
      setLeftPanelWidth(newWidth)
    }
    const onMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const handleResizeDoubleClick = useCallback(() => {
    setLeftPanelCollapsed(prev => !prev)
  }, [])
  const loadData = useCallback(async () => {
    const opts: { week: string; source?: string } = { week }
    if (sourceFilter) opts.source = sourceFilter
    try {
      const [taskList, completed, wd, foldersData, colors] = await Promise.all([
        window.electronAPI.getTasks(opts),
        window.electronAPI.getCompletedInWeek(week),
        window.electronAPI.getWeekData(week),
        window.electronAPI.getFolders(opts).catch(() => []),
        window.electronAPI.getFolderColors().catch(() => []),
      ])
      // Populate task flags (is_recurring, has_cache) in bulk
      let flaggedTasks: Task[]
      try {
        flaggedTasks = await window.electronAPI.populateTaskFlags(taskList)
      } catch {
        flaggedTasks = taskList
      }
      setTasks(flaggedTasks)
      setCompletedTasks(completed)
      setWeekData(wd)
      setFolders(foldersData)
      setFolderColors(colors)
    } catch (err) {
      console.error('[ROCA] loadData failed:', err)
    }
  }, [week, sourceFilter])

  useEffect(() => { loadData() }, [loadData])

  // Stable ref to latest loadData — lets folder callbacks remain stable across week changes
  const loadDataRef = useRef(loadData)
  useEffect(() => { loadDataRef.current = loadData }, [loadData])

  // Poll PTY statuses every 2s to show Running/Needs Input on task rows
  // Only update state when statuses actually change to avoid unnecessary re-renders
  const lastStatusJsonRef = useRef('')
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const statuses = await window.electronAPI.getPtyStatuses()
        if (!mounted) return
        const json = JSON.stringify(statuses)
        if (json !== lastStatusJsonRef.current) {
          lastStatusJsonRef.current = json
          setPtyStatuses(statuses)
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  const handleCreateTask = useCallback(async (title: string, priority: string) => {
    const { id } = await window.electronAPI.createTask({ title, priority })
    await loadData()
    setSelectedTaskId(id as number)
  }, [loadData])

  const handleDuplicateTask = useCallback(async (taskId: number) => {
    try {
      const { id } = await window.electronAPI.duplicateTask(taskId)
      if (!id) return

      const cw = currentIsoWeek()
      const needsWeekChange = week !== cw
      const needsFilterClear = sourceFilter !== null

      if (needsWeekChange) setWeek(cw)
      if (needsFilterClear) setSourceFilter(null)

      // If view params didn't change, reload explicitly to pick up the new task.
      // Otherwise loadData fires automatically via useEffect when week/filter change.
      if (!needsWeekChange && !needsFilterClear) {
        await loadData()
      }

      setSelectedTaskId(id)
      setRightPanelTab('terminal')
    } catch (err) {
      console.error('[ROCA] duplicate failed:', err)
    }
  }, [loadData, week, sourceFilter])

  const handleToggleTask = useCallback(async (taskId: number) => {
    const task = await window.electronAPI.toggleTask(taskId)
    await loadData()
    // Navigate home when task is completed (terminal is killed server-side)
    if (task && task.status === 'done') {
      setSelectedTaskId(null)
    }
  }, [loadData])

  const handleSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setSyncError(null)
    try {
      await window.electronAPI.syncAll()
      await loadData()
    } catch (err) {
      console.error('[Sync] Failed:', err)
      setSyncError('Sync failed. Try again.')
    } finally {
      setSyncing(false)
    }
  }, [syncing, loadData])

  const handleToggleUrgent = useCallback(async (taskId: number) => {
    const task = tasks.find(t => t.id === taskId)
    const newPriority = task?.priority === 'urgent' ? 'high' : 'urgent'
    await window.electronAPI.updateTaskFields(taskId, { priority: newPriority })
    await loadData()
  }, [tasks, loadData])

  const handleSaveChallenges = useCallback(async (text: string) => {
    await window.electronAPI.updateChallenges(week, text)
  }, [week])

  const handleOrganize = useCallback(async () => {
    if (organizing) return
    setOrganizing(true)
    setOrganizeError(null)
    try {
      const result = await window.electronAPI.organizeApply(week)
      if (result?.error) {
        console.error('[Organize] Backend error:', result.error)
        setOrganizeError(`Organize error: ${result.error}`)
        return
      }
      await loadData()
    } catch (err: any) {
      console.error('[Organize] Failed:', err)
      setOrganizeError(`Organize failed: ${err?.message || 'unknown error'}`)
    } finally {
      setOrganizing(false)
    }
  }, [organizing, week, loadData])


  const handleToggleRecurring = useCallback(async (taskId: number, isRecurring: boolean) => {
    if (isRecurring) {
      await window.electronAPI.unmakeRecurring(taskId)
    } else {
      await window.electronAPI.makeRecurring(taskId)
    }
    await loadData()
  }, [loadData])

  const handleStatusChange = useCallback(async (taskId: number, status: string) => {
    await window.electronAPI.updateTaskStatus(taskId, status)
    await loadData()
  }, [loadData])

  const handlePriorityChange = useCallback(async (taskId: number, priority: string) => {
    await window.electronAPI.updateTaskFields(taskId, { priority })
    await loadData()
  }, [loadData])

  const handleTitleChange = useCallback(async (taskId: number, title: string) => {
    await window.electronAPI.updateTaskFields(taskId, { title })
    await loadData()
  }, [loadData])

  const navigateWeek = useCallback((delta: number) => {
    const [yearStr, wkStr] = week.split('-W')
    let wk = parseInt(wkStr) + delta
    let year = parseInt(yearStr)
    // ISO years can have 52 or 53 weeks — use shared isoWeeksInYear from formatDate
    if (wk < 1) { year--; wk = isoWeeksInYear(year) }
    else if (wk > isoWeeksInYear(year)) { year++; wk = 1 }
    setWeekData(null)  // clear stale challenges before async loadData
    // Don't clear tasks/completedTasks/folders — let loadData replace them atomically
    // to avoid a blank flash that makes the UI look broken
    setWeek(`${year}-W${String(wk).padStart(2, '0')}`)
  }, [week])

  const handleSelectTask = useCallback((id: number) => {
    setSelectedTaskId(id)
    setProjectSelectedTask(null)
    setAssistantActive(false)
  }, [])

  const handleSelectProjectTask = useCallback((task: Task) => {
    setProjectSelectedTask(task)
    setSelectedTaskId(null)
    setAssistantActive(false)
  }, [])

  const handleTabChange = useCallback((tab: NavTab) => {
    setActiveTab(tab)
    // Don't clear selectedTaskId — preserve task selection across tab switches
    // so terminal sessions survive when switching to inbox/journal and back
  }, [])

  const handleVoiceTranscript = useCallback((text: string) => setPendingVoiceText(text), [])

  // Folder handlers — stable references (deps-free via loadDataRef) so FolderItem memo is effective
  const handleCreateFolder = useCallback(async () => {
    await window.electronAPI.createFolder('New Folder')
    await loadDataRef.current()
  }, [])
  const handleRenameFolder = useCallback(async (folderId: number, name: string) => {
    await window.electronAPI.renameFolder(folderId, name)
    await loadDataRef.current()
  }, [])
  const handleToggleFolderCollapse = useCallback(async (folderId: number) => {
    await window.electronAPI.toggleFolderCollapse(folderId)
    await loadDataRef.current()
  }, [])
  const handleDeleteFolder = useCallback(async (folderId: number) => {
    await window.electronAPI.deleteFolder(folderId)
    await loadDataRef.current()
  }, [])
  const handleSetTaskFolder = useCallback(async (taskId: number, folderId: number | null) => {
    await window.electronAPI.setTaskFolder(taskId, folderId)
    await loadDataRef.current()
  }, [])
  const handleUpdateFolderColor = useCallback(async (folderId: number, color: string) => {
    await window.electronAPI.updateFolderColor(folderId, color)
    await loadDataRef.current()
  }, [])
  const handleReorderFolders = useCallback(async (folderIds: number[]) => {
    await window.electronAPI.reorderFolders(folderIds)
    await loadDataRef.current()
  }, [])
  const handleReorderTasks = useCallback(async (taskIds: number[]) => {
    await window.electronAPI.reorderTasks(taskIds)
    await loadDataRef.current()
  }, [])

  const handleFeedbackSubmit = useCallback(async (description: string, type: 'feature' | 'bug', relatedTaskId: number | null, imageFiles?: File[]) => {
    // 1. Ensure a "Development" folder exists
    let devFolder = folders.find(f => f.name === 'Development')
    let devFolderId: number
    if (!devFolder) {
      const result = await window.electronAPI.createFolder('Development', '#30D158')
      devFolderId = result.id
    } else {
      devFolderId = devFolder.id
    }

    // 2. Create the task, linking to selected project if on projects tab
    const prefix = type === 'feature' ? '[Feature]' : '[Bug]'
    const title = `${prefix} ${description.slice(0, 100)}`
    let notes = `## ${type === 'feature' ? 'Feature Request' : 'Bug Report'}\n\n${description}`
      + (relatedTaskId ? `\n\n---\n**Related task ID:** ${relatedTaskId}` : '')

    const { id: taskId } = await window.electronAPI.createTask({
      title,
      priority: type === 'bug' ? 'high' : 'medium',
      notes,
    })

    // 2b. Upload attached images and append to notes
    if (imageFiles?.length) {
      const uploadResults: string[] = []
      for (const file of imageFiles) {
        try {
          const arrayBuffer = await file.arrayBuffer()
          const result = await window.electronAPI.uploadFile(taskId as number, {
            buffer: new Uint8Array(arrayBuffer),
            filename: file.name,
            mimeType: file.type,
          })
          if (result?.ok && result.storedName) {
            uploadResults.push(`![${file.name}](/uploads/${result.storedName})`)
          }
        } catch (err) {
          console.error('[Feedback] Failed to upload image:', err)
        }
      }
      if (uploadResults.length) {
        notes += `\n\n### Attachments\n${uploadResults.join('\n')}`
        await window.electronAPI.updateNotes(taskId as number, notes)
      }
    }

    // 3. Assign to Development folder and project
    try {
      await window.electronAPI.setTaskFolder(taskId as number, devFolderId)
      if (selectedProjectId) {
        await window.electronAPI.projectsSetTaskProject(taskId as number, selectedProjectId)
      }
    } catch (err) {
      console.warn('[Feedback] Failed to assign folder/project:', err)
    }

    // 4. Reload data first so the new task is in the tasks array before selection
    await loadData()

    // 5. Select task & switch to terminal — doAutoLaunch in TaskTerminal
    //    will generate context on its own, no need to block here
    if (selectedProjectId) {
      const task = await window.electronAPI.getTask(taskId as number)
      setProjectSelectedTask(task as Task)
      setSelectedTaskId(null)
    } else {
      setSelectedTaskId(taskId as number)
    }
    // Don't set pendingAutoCommand — let TaskTerminal's default doAutoLaunch
    // pipe the full context file (notes + uploaded images) to Claude
    setRightPanelTab('terminal')
  }, [folders, selectedProjectId, loadData])

  const handleSlashCommand = useCallback(async (command: string, args: string) => {
    const currentTask = selectedTaskId ?? projectSelectedTask?.id
    switch (command) {
      case 'voice':
        // Voice mode is now self-contained — click the mic button
        break
      case 'sync':
        handleSync()
        break
      case 'new':
        if (args.trim()) {
          handleCreateTask(args.trim(), 'medium')
        }
        break
      case 'done':
        if (currentTask) handleToggleTask(currentTask)
        break
      case 'status':
        if (currentTask && args.trim()) {
          await handleStatusChange(currentTask, args.trim().replace(/\s+/g, '_'))
        }
        break
      case 'priority':
        if (currentTask && args.trim()) {
          await handlePriorityChange(currentTask, args.trim().toLowerCase())
        }
        break
      case 'week':
        if (args === 'next') navigateWeek(1)
        else if (args === 'prev') navigateWeek(-1)
        else if (args === 'current' || !args) { setWeekData(null); setWeek(currentIsoWeek()) }
        break
      case 'tab': {
        // Map legacy tab names to current ones
        const tabArg = args.trim()
        const tabTarget = ['journal', 'tools', 'agents'].includes(tabArg) ? 'filepath' : tabArg
        if (['week', 'filepath'].includes(tabTarget)) {
          handleTabChange(tabTarget as NavTab)
        }
        break
      }
      case 'agents':
        handleTabChange('filepath')
        break
      case 'agent': {
        const parts = args.split(/\s+/)
        const action = parts[0]?.toLowerCase()
        const name = parts.slice(1).join(' ')
        if (action === 'start' && name) {
          const agents = await window.electronAPI.agentsList()
          const match = agents.find((a: any) => a.name.toLowerCase() === name.toLowerCase()
            || a.label?.toLowerCase() === name.toLowerCase())
          if (match) window.electronAPI.agentsStart(match.label)
        } else if (action === 'stop' && name) {
          const agents = await window.electronAPI.agentsList()
          const match = agents.find((a: any) => a.name.toLowerCase() === name.toLowerCase()
            || a.label?.toLowerCase() === name.toLowerCase())
          if (match) window.electronAPI.agentsStop(match.label)
        }
        break
      }
      case 'popout':
        if (currentTask) {
          window.electronAPI.popoutOpen({ taskId: currentTask, tab: rightPanelTab })
        }
        break
      case 'duplicate':
        if (currentTask) handleDuplicateTask(currentTask)
        break
      // notes, files, terminal, browser, clear, help — handled in RightPanel/TaskTerminal
    }
  }, [selectedTaskId, projectSelectedTask, rightPanelTab, handleSync, handleCreateTask, handleToggleTask, handleStatusChange, handlePriorityChange, handleDuplicateTask, navigateWeek, handleTabChange])

  // Keep ref in sync so RightPanel callbacks don't need projectSelectedTask in their dep arrays
  useEffect(() => { projectSelectedTaskRef.current = projectSelectedTask }, [projectSelectedTask])

  // Stable callbacks for RightPanel — prevents unnecessary terminal re-renders on every App state change
  const handleRightPanelDataChange = useCallback(async () => {
    await loadData()
    if (projectSelectedTaskRef.current) {
      const refreshed = await window.electronAPI.getTask(projectSelectedTaskRef.current.id)
      if (refreshed) setProjectSelectedTask(refreshed as Task)
    }
  }, [loadData])

  const handleRightPanelComplete = useCallback(async (taskId: number) => {
    const task = await window.electronAPI.toggleTask(taskId)
    await loadData()
    // Navigate home when task is completed (terminal is killed server-side)
    if (task && task.status === 'done') {
      setSelectedTaskId(null)
      if (projectSelectedTaskRef.current) {
        setProjectSelectedTask(null)
      }
    } else if (projectSelectedTaskRef.current) {
      const refreshed = await window.electronAPI.getTask(taskId)
      if (refreshed) setProjectSelectedTask(refreshed as Task)
    }
  }, [loadData])

  const handleRightPanelStatusChange = useCallback(async (taskId: number, status: string) => {
    await window.electronAPI.updateTaskStatus(taskId, status)
    await loadData()
    if (projectSelectedTaskRef.current) {
      const refreshed = await window.electronAPI.getTask(taskId)
      if (refreshed) setProjectSelectedTask(refreshed as Task)
    }
  }, [loadData])

  const handleRightPanelPriorityChange = useCallback(async (taskId: number, priority: string) => {
    await window.electronAPI.updateTaskFields(taskId, { priority })
    await loadData()
    if (projectSelectedTaskRef.current) {
      const refreshed = await window.electronAPI.getTask(taskId)
      if (refreshed) setProjectSelectedTask(refreshed as Task)
    }
  }, [loadData])

  const handleRightPanelTitleChange = useCallback(async (taskId: number, title: string) => {
    await window.electronAPI.updateTaskFields(taskId, { title })
    await loadData()
    if (projectSelectedTaskRef.current) {
      const refreshed = await window.electronAPI.getTask(taskId)
      if (refreshed) setProjectSelectedTask(refreshed as Task)
    }
  }, [loadData])

  const handleAssistant = useCallback(() => {
    setAssistantActive(true)
    setSelectedTaskId(null)
    setProjectSelectedTask(null)
  }, [])

  const handleGoToCurrentWeek = useCallback(() => {
    setWeekData(null)
    setWeek(currentIsoWeek())
  }, [])

  const selectedTask = useMemo(
    () => tasks.find(t => t.id === selectedTaskId) || completedTasks.find(t => t.id === selectedTaskId) || null,
    [tasks, completedTasks, selectedTaskId]
  )
  const openTasks = useMemo(
    () => tasks.filter(t => ACTIVE_STATUSES.includes(t.status)),
    [tasks]
  )

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-text-1">
      <div className="relative shrink-0">
        <TopNav
          activeTab={activeTab}
          week={week}
          onTabChange={handleTabChange}
          onFeedback={(type) => setFeedbackModal({ type })}
        />
      </div>
      {feedbackModal && (
        <FeedbackModal
          type={feedbackModal.type}
          currentTask={selectedTask ? { id: selectedTask.id, title: selectedTask.title } : null}
          onSubmit={handleFeedbackSubmit}
          onClose={() => setFeedbackModal(null)}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* Week view stays mounted (hidden) so RightPanel & terminals survive tab switches */}
        <div className={`flex flex-1 overflow-hidden ${activeTab === 'week' ? '' : 'hidden'}`}>
          {/* Collapsible left panel — unified div for smooth width transition */}
          <div
            className={`relative shrink-0 flex flex-col overflow-hidden transition-[width] duration-200 ease-in-out ${leftPanelCollapsed ? 'border-r border-black/[0.06]' : ''}`}
            style={{ width: leftPanelCollapsed ? 40 : leftPanelWidth }}
          >
            {/* Expand button overlay — visible only when collapsed */}
            <div className={`absolute inset-0 z-10 flex flex-col items-center py-4 transition-opacity duration-150 ${
              leftPanelCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}>
              <button
                onClick={() => setLeftPanelCollapsed(false)}
                className="p-1.5 rounded-md hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors"
                title="Expand panel"
                aria-label="Expand task list panel"
                aria-expanded={!leftPanelCollapsed}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
            {/* Panel content — fades out when collapsed */}
            <div
              className={`flex-1 overflow-hidden transition-opacity duration-150 ${leftPanelCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
              aria-hidden={leftPanelCollapsed || undefined}
            >
              <WeeklyView
                week={week}
                weekData={weekData}
                objectives={openTasks}
                results={completedTasks}
                folders={folders}
                folderColors={folderColors}
                selectedTaskId={selectedTaskId}
                sourceFilter={sourceFilter}
                syncing={syncing}
                onSelectTask={handleSelectTask}
                onCreateTask={handleCreateTask}
                onToggleTask={handleToggleTask}
                onToggleUrgent={handleToggleUrgent}
                onSync={handleSync}
                syncError={syncError}
                onOrganize={handleOrganize}
                organizeError={organizeError}
                organizing={organizing}
                onNavigateWeek={navigateWeek}
                onGoToCurrentWeek={handleGoToCurrentWeek}
                onSetSourceFilter={setSourceFilter}
                onSaveChallenges={handleSaveChallenges}
                onToggleRecurring={handleToggleRecurring}
                onCreateFolder={handleCreateFolder}
                onRenameFolder={handleRenameFolder}
                onToggleFolderCollapse={handleToggleFolderCollapse}
                onDeleteFolder={handleDeleteFolder}
                onSetTaskFolder={handleSetTaskFolder}
                onUpdateFolderColor={handleUpdateFolderColor}
                onReorderFolders={handleReorderFolders}
                onReorderTasks={handleReorderTasks}
                ptyStatuses={ptyStatuses}
                onAssistant={handleAssistant}
                assistantActive={assistantActive}
              />
            </div>
            {/* Projects panel — bottom left */}
            <div className={`border-t border-black/[0.06] shrink-0 transition-all overflow-hidden ${projectsPanelOpen ? 'max-h-[280px]' : 'max-h-[32px]'} ${leftPanelCollapsed ? 'opacity-0 pointer-events-none' : ''}`}>
              <ProjectsView
                selectedTaskId={projectSelectedTask?.id ?? null}
                onSelectTask={handleSelectProjectTask}
                onSelectProject={(id) => setSelectedProjectId(id)}
                collapsed={!projectsPanelOpen}
                onToggleCollapse={() => setProjectsPanelOpen(prev => !prev)}
              />
            </div>
            {/* Drag handle — only interactive when expanded */}
            <div
              className={`absolute top-0 right-0 w-[4px] h-full cursor-col-resize hover:bg-purple-1/20 transition-colors z-10 ${leftPanelCollapsed ? 'pointer-events-none' : ''}`}
              onMouseDown={handleResizeStart}
              onDoubleClick={handleResizeDoubleClick}
            />
          </div>
          <main className="flex-1 flex flex-col overflow-hidden">
            {(selectedTask || projectSelectedTask || assistantActive) ? (
              <RightPanel
                task={assistantActive ? ASSISTANT_TASK : (selectedTask || projectSelectedTask)!}
                initialTab={assistantActive ? 'terminal' : rightPanelTab}
                onClaudeResponse={(text) => setLastClaudeResponse(text)}
                voiceTextToSpeak={lastClaudeResponse ?? undefined}
                onVoiceTextToSpeakConsumed={() => setLastClaudeResponse(null)}
                onVoiceTranscript={handleVoiceTranscript}
                onDataChange={handleRightPanelDataChange}
                onToggleRecurring={handleToggleRecurring}
                onComplete={handleRightPanelComplete}
                onStatusChange={handleRightPanelStatusChange}
                onPriorityChange={handleRightPanelPriorityChange}
                onTitleChange={handleRightPanelTitleChange}
                onTabChanged={() => setRightPanelTab('notes')}
                autoCommand={pendingAutoCommand}
                onAutoCommandConsumed={() => setPendingAutoCommand(null)}
                pendingVoiceText={pendingVoiceText}
                onVoiceTextConsumed={() => setPendingVoiceText(null)}
                onSlashCommand={handleSlashCommand}
                onDuplicateTask={handleDuplicateTask}
                onCollapseTaskList={() => setLeftPanelCollapsed(prev => !prev)}
                taskListCollapsed={leftPanelCollapsed}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center select-none">
                  <div className="w-12 h-12 rounded-2xl bg-black/[0.04] border border-black/[0.06] flex items-center justify-center mx-auto mb-4">
                    <svg className="w-5 h-5 text-text-3/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  </div>
                  <p className="text-[12px] font-medium text-text-2 mb-1">No task selected</p>
                  <p className="text-[11px] text-text-3">Pick a task from the list, or press Cmd+Shift+A for the assistant.</p>
                </div>
              </div>
            )}
          </main>
        </div>
        <div className={`flex-1 overflow-hidden ${activeTab === 'filepath' ? 'flex' : 'hidden'}`}>
          <FilePathView />
        </div>
      </div>
    </div>
  )
}
