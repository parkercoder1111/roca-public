import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Environment ──
  getEnv: (key: string) => ipcRenderer.invoke('env:get', key),
  debugWrite: (content: string) => ipcRenderer.invoke('debug:write', content),
  voiceLogSession: (entry: {
    event: string; state: string; taskId: number | null; tab: string;
    error?: string; spokenText?: string; transcript?: string;
  }) => ipcRenderer.invoke('voice:log-session', entry),

  // ── Tasks ──
  getTasks: (opts?: { week?: string; status?: string; source?: string; priority?: string }) =>
    ipcRenderer.invoke('db:tasks:list', opts),
  getTask: (taskId: number) => ipcRenderer.invoke('db:tasks:get', taskId),
  createTask: (task: {
    title: string; source?: string; source_id?: string;
    priority?: string; due_date?: string;
    company_name?: string; deal_name?: string;
    notes?: string; week?: string
  }) => ipcRenderer.invoke('db:tasks:create', task),
  toggleTask: (taskId: number) => ipcRenderer.invoke('db:tasks:toggle', taskId),
  duplicateTask: (taskId: number) => ipcRenderer.invoke('db:tasks:duplicate', taskId) as Promise<{ id: number | null }>,
  updateNotes: (taskId: number, notes: string) =>
    ipcRenderer.invoke('db:tasks:update-notes', taskId, notes),
  updateTaskFields: (taskId: number, fields: Record<string, unknown>) =>
    ipcRenderer.invoke('db:tasks:update-fields', taskId, fields),
  updateTaskStatus: (taskId: number, status: string) =>
    ipcRenderer.invoke('db:tasks:update-status', taskId, status),
  reorderTasks: (taskIds: number[]) =>
    ipcRenderer.invoke('db:tasks:reorder', taskIds),
  toggleUrgent: (taskId: number) =>
    ipcRenderer.invoke('db:tasks:toggle-urgent', taskId),
  setTaskInProgress: (taskId: number) =>
    ipcRenderer.invoke('db:tasks:set-in-progress', taskId),
  scheduleTask: (taskId: number, scheduledAt: string | null) =>
    ipcRenderer.invoke('db:tasks:schedule', taskId, scheduledAt),
  getOpenUnfoldered: (opts?: { week?: string; source?: string; priority?: string }) =>
    ipcRenderer.invoke('db:tasks:open-unfoldered', opts),
  populateTaskFlags: (tasks: any[]) =>
    ipcRenderer.invoke('db:tasks:populate-flags', tasks),

  // ── Completed ──
  getCompletedInWeek: (week?: string) => ipcRenderer.invoke('db:completed-in-week', week),

  // ── Recurring ──
  makeRecurring: (taskId: number) => ipcRenderer.invoke('db:tasks:make-recurring', taskId),
  unmakeRecurring: (taskId: number) => ipcRenderer.invoke('db:tasks:unmake-recurring', taskId),
  isRecurring: (title: string) => ipcRenderer.invoke('db:tasks:is-recurring', title),
  getRecurringTasks: () => ipcRenderer.invoke('db:recurring:list'),
  addRecurringTask: (title: string, priority?: string, company_name?: string, deal_name?: string, notes?: string) =>
    ipcRenderer.invoke('db:recurring:add', title, priority, company_name, deal_name, notes),
  removeRecurringTask: (recurringId: number) => ipcRenderer.invoke('db:recurring:remove', recurringId),
  spawnRecurring: (week?: string) => ipcRenderer.invoke('db:recurring:spawn', week),

  // ── Week ──
  getWeekData: (week?: string) => ipcRenderer.invoke('db:week:get', week),
  updateChallenges: (week: string, text: string) =>
    ipcRenderer.invoke('db:week:challenges', week, text),
  updateMeetings: (week: string, count: number) =>
    ipcRenderer.invoke('db:week:meetings', week, count),
  getCurrentWeek: () => ipcRenderer.invoke('db:week:current'),

  // ── Inbox ──
  getInboxTasks: (week?: string) => ipcRenderer.invoke('db:inbox:list', week),
  getInboxCount: (week?: string) => ipcRenderer.invoke('db:inbox:count', week),
  triageTask: (taskId: number) => ipcRenderer.invoke('db:inbox:triage', taskId),

  // ── Folders ──
  getFolders: (opts?: { week?: string; source?: string; priority?: string }) =>
    ipcRenderer.invoke('db:folders:list', opts),
  createFolder: (name: string, color?: string) =>
    ipcRenderer.invoke('db:folders:create', name, color),
  renameFolder: (folderId: number, name: string) =>
    ipcRenderer.invoke('db:folders:rename', folderId, name),
  toggleFolderCollapse: (folderId: number) =>
    ipcRenderer.invoke('db:folders:toggle-collapse', folderId),
  deleteFolder: (folderId: number) =>
    ipcRenderer.invoke('db:folders:delete', folderId),
  setTaskFolder: (taskId: number, folderId?: number | null) =>
    ipcRenderer.invoke('db:folders:set-task-folder', taskId, folderId),
  updateFolderColor: (folderId: number, color: string) =>
    ipcRenderer.invoke('db:folders:update-color', folderId, color),
  reorderFolders: (folderIds: number[]) =>
    ipcRenderer.invoke('db:folders:reorder', folderIds),
  getFolderColors: () => ipcRenderer.invoke('db:folders:colors'),

  // ── Delegate cache ──
  getDelegateCache: (taskId: number) => ipcRenderer.invoke('db:delegate:get-cache', taskId),
  saveDelegateCache: (
    taskId: number, plan: string, context: string,
    cost: number, turns: number, error: string | null, sessionId?: string | null
  ) => ipcRenderer.invoke('db:delegate:save-cache', taskId, plan, context, cost, turns, error, sessionId),
  clearDelegateCache: (taskId: number) => ipcRenderer.invoke('db:delegate:clear-cache', taskId),

  // ── Delegate executions ──
  createExecution: (taskId: number) => ipcRenderer.invoke('db:delegate:create-execution', taskId),
  updateExecution: (execId: number, status: string, output?: string | null, cost?: number) =>
    ipcRenderer.invoke('db:delegate:update-execution', execId, status, output, cost),
  getExecution: (execId: number) => ipcRenderer.invoke('db:delegate:get-execution', execId),
  getLatestExecution: (taskId: number) => ipcRenderer.invoke('db:delegate:latest-execution', taskId),

  // ── Delegate messages ──
  addDelegateMessage: (taskId: number, role: string, content: string, cost?: number, turns?: number) =>
    ipcRenderer.invoke('db:delegate:add-message', taskId, role, content, cost, turns),
  getDelegateMessages: (taskId: number) => ipcRenderer.invoke('db:delegate:get-messages', taskId),
  clearDelegateMessages: (taskId: number) => ipcRenderer.invoke('db:delegate:clear-messages', taskId),
  getDelegateMessageCount: (taskId: number, role?: string) =>
    ipcRenderer.invoke('db:delegate:message-count', taskId, role),

  // ── Delegate AI ──
  delegateAnalyze: (taskId: number, userContext?: string) =>
    ipcRenderer.invoke('delegate:analyze', taskId, userContext) as Promise<any>,
  delegateRefine: (taskId: number, feedback: string) =>
    ipcRenderer.invoke('delegate:refine', taskId, feedback) as Promise<any>,
  delegateExecute: (taskId: number) =>
    ipcRenderer.invoke('delegate:execute', taskId) as Promise<any>,
  delegateLearn: (taskId: number) =>
    ipcRenderer.invoke('delegate:learn', taskId) as Promise<any>,

  // ── Uploads ──
  uploadFile: (taskId: number, fileData: { buffer: Uint8Array; filename: string; mimeType: string }) =>
    ipcRenderer.invoke('db:uploads:save', taskId, fileData),
  getUploadsForTask: (taskId: number) => ipcRenderer.invoke('db:uploads:for-task', taskId),
  getUploadsForMessage: (messageId: number) => ipcRenderer.invoke('db:uploads:for-message', messageId),
  getPendingUploads: (taskId: number) => ipcRenderer.invoke('db:uploads:pending', taskId),
  linkUploadsToMessage: (taskId: number, messageId: number) =>
    ipcRenderer.invoke('db:uploads:link-to-message', taskId, messageId),
  serveUpload: (filename: string) => ipcRenderer.invoke('db:uploads:serve', filename),
  deleteUpload: (uploadId: number) => ipcRenderer.invoke('db:uploads:delete', uploadId),
  serveUploadPath: (storedName: string) => ipcRenderer.invoke('db:uploads:serve-path', storedName),
  parseExcelStyled: (storedName: string) => ipcRenderer.invoke('db:uploads:parse-excel', storedName) as Promise<{ sheets?: { name: string; html: string }[]; error?: string }>,
  convertUploadToPdf: (storedName: string) => ipcRenderer.invoke('db:uploads:convert-pdf', storedName),
  convertDocxToHtml: (storedName: string) => ipcRenderer.invoke('docx:to-html', storedName) as Promise<{ html?: string; error?: string }>,
  showItemInFolder: (storedName: string) => ipcRenderer.invoke('shell:show-item', storedName),

  // ── Scheduled ──
  getScheduledDueTasks: () => ipcRenderer.invoke('db:scheduled:due'),
  clearScheduledAt: (taskId: number) => ipcRenderer.invoke('db:scheduled:clear', taskId),

  // ── Sync ──
  syncAll: () => ipcRenderer.invoke('sync:all'),
  reconcileAll: () => ipcRenderer.invoke('sync:reconcile'),

  // ── Organize ──
  organizePreview: (week?: string) => ipcRenderer.invoke('organize:preview', week),
  organizeApply: (week?: string) => ipcRenderer.invoke('organize:apply', week),


  // ── Transcript ──
  processTranscript: (meetingId: string, meetingName: string, transcriptText: string, meetingDate?: string) =>
    ipcRenderer.invoke('sync:process-transcript', meetingId, meetingName, transcriptText, meetingDate),

  // ── Journal ──
  getJournal: () => ipcRenderer.invoke('journal:get'),

  // ── Voice notes webhook ──
  ingestVoiceNoteWebhook: (payload: any) => ipcRenderer.invoke('webhook:voice-notes', payload),

  // ── Constants ──
  getStatusLabels: () => ipcRenderer.invoke('constants:status-labels'),
  getActiveStatuses: () => ipcRenderer.invoke('constants:active-statuses'),

  // ── Health ──
  health: () => ipcRenderer.invoke('health'),

  // ── App updates ──
  restartApp: () => ipcRenderer.invoke('app:restart'),
  fullRestartApp: () => ipcRenderer.invoke('app:full-restart'),
  onUpdateAvailable: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:update-available', listener)
    return () => { ipcRenderer.removeListener('app:update-available', listener) }
  },
  onRebuilding: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:rebuilding', listener)
    return () => { ipcRenderer.removeListener('app:rebuilding', listener) }
  },
  onNavigateTask: (callback: (taskId: number) => void) => {
    const listener = (_: any, taskId: number) => callback(taskId)
    ipcRenderer.on('app:navigate-task', listener)
    return () => { ipcRenderer.removeListener('app:navigate-task', listener) }
  },
  onBrowserOpen: (callback: (data: { taskId?: number; url: string }) => void) => {
    const listener = (_: any, data: { taskId?: number; url: string }) => callback(data)
    ipcRenderer.on('app:browser-open', listener)
    return () => { ipcRenderer.removeListener('app:browser-open', listener) }
  },

  // ── Warp ──
  openWarp: (script?: string) => ipcRenderer.invoke('open:warp', script),

  // ── Clipboard ──
  pasteImage: () => ipcRenderer.invoke('clipboard:paste-image') as Promise<{ ok: boolean; path: string | null }>,

  // ── PTY ──
  startPty: (taskId: string, cwd?: string) => ipcRenderer.invoke('pty:start', taskId, cwd) as Promise<{ ok: boolean; id: string; existing: boolean; tmuxReattached?: boolean; savedScrollback?: string; contextPath?: string }>,
  getPtyScrollback: (id: string) => ipcRenderer.invoke('pty:scrollback', id) as Promise<string>,
  getPtyStatuses: () => ipcRenderer.invoke('pty:statuses') as Promise<Record<string, string>>,
  writePty: (id: string, data: string) => ipcRenderer.send('pty:input', { id, data }),
  resizePty: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id: string) => ipcRenderer.invoke('pty:kill', id),

  // ── PTY events ──
  onPtyData: (id: string, callback: (data: string) => void) => {
    const channel = `pty:data:${id}`
    const listener = (_: any, data: string) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
  onPtyExit: (id: string, callback: (exitCode: number) => void) => {
    const channel = `pty:exit:${id}`
    const listener = (_: any, exitCode: number) => callback(exitCode)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },

  // ── Browser ──
  createBrowserSession: (taskId: number, mode: string) =>
    ipcRenderer.invoke('browser:create', taskId, mode),
  destroyBrowserSession: (taskId: number) =>
    ipcRenderer.invoke('browser:destroy', taskId),
  getBrowserSession: (taskId: number) =>
    ipcRenderer.invoke('browser:get', taskId),
  browserRegisterWebContents: (taskId: number, webContentsId: number) =>
    ipcRenderer.invoke('browser:register-webcontents', taskId, webContentsId),
  browserNavigate: (taskId: number, url: string) =>
    ipcRenderer.invoke('browser:navigate', taskId, url),
  browserNavAction: (taskId: number, action: string, url?: string) =>
    ipcRenderer.invoke('browser:nav-action', taskId, action, url),
  browserSendInstruction: (taskId: number, instruction: string) =>
    ipcRenderer.invoke('browser:send-instruction', taskId, instruction),
  browserStopClaude: (taskId: number) =>
    ipcRenderer.invoke('browser:stop-claude', taskId),
  browserSaveTabs: (taskId: number, tabs: { url: string; title: string }[], activeIndex: number) =>
    ipcRenderer.invoke('browser:save-tabs', taskId, tabs, activeIndex) as Promise<{ ok: boolean }>,
  browserLoadTabs: (taskId: number) =>
    ipcRenderer.invoke('browser:load-tabs', taskId) as Promise<{ tabs: { url: string; title: string }[]; activeIndex: number } | null>,
  browserDeleteTabs: (taskId: number) =>
    ipcRenderer.invoke('browser:delete-tabs', taskId) as Promise<{ ok: boolean }>,

  // ── Browser events ──
  onBrowserStatus: (taskId: number, callback: (status: any) => void) => {
    const channel = `browser:status:${taskId}`
    const listener = (_: any, status: any) => callback(status)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
  onBrowserThought: (taskId: number, callback: (thought: string) => void) => {
    const channel = `browser:thought:${taskId}`
    const listener = (_: any, thought: string) => callback(thought)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },

  // ── Projects ──
  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectsAdd: (repoPath: string) => ipcRenderer.invoke('projects:add', repoPath),
  projectsRemove: (id: string) => ipcRenderer.invoke('projects:remove', id),
  projectsGitStatus: (id: string) => ipcRenderer.invoke('projects:git-status', id),
  projectsGitLog: (id: string) => ipcRenderer.invoke('projects:git-log', id),
  projectsGetTasks: (projectId: string) => ipcRenderer.invoke('projects:get-tasks', projectId),
  projectsSetTaskProject: (taskId: number, projectId: string | null) => ipcRenderer.invoke('projects:set-task-project', taskId, projectId),

  // ── Tools / Integrations ──
  getTools: () => ipcRenderer.invoke('tools:list'),
  createTool: (tool: {
    name: string; description?: string; category?: string;
    connection_type?: string; status?: string; config?: string;
    icon?: string; capabilities?: string; account?: string; details?: string;
  }) => ipcRenderer.invoke('tools:create', tool),
  updateTool: (toolId: number, fields: Record<string, unknown>) =>
    ipcRenderer.invoke('tools:update', toolId, fields),
  deleteTool: (toolId: number) => ipcRenderer.invoke('tools:delete', toolId),

  // ── Alignment ──
  getAlignment: () => ipcRenderer.invoke('alignment:get'),
  saveAlignment: (content: string) => ipcRenderer.invoke('alignment:save', content),

  // ── Skills ──
  listSkills: () => ipcRenderer.invoke('skills:list') as Promise<{ name: string; path: string; dir: string; content: string }[]>,
  getSkill: (skillPath: string) => ipcRenderer.invoke('skills:get', skillPath) as Promise<string>,
  saveSkill: (skillPath: string, content: string) => ipcRenderer.invoke('skills:save', skillPath, content) as Promise<{ ok: boolean }>,

  // ── Task Context ──
  generateTaskContext: (taskId: number) => ipcRenderer.invoke('task-context:generate', taskId),

  // ── Reflection & Proactive ──
  triggerReflection: () => ipcRenderer.invoke('roca:reflect') as Promise<{ ok: boolean; error?: string }>,
  triggerProactive: (mode?: string) => ipcRenderer.invoke('roca:proactive', mode) as Promise<{ ok: boolean; error?: string }>,

  // ── Remote ──
  getRemoteInfo: () => ipcRenderer.invoke('remote:info') as Promise<{ token: string; port: number; localIp: string }>,

  // ── Popout ──
  popoutOpen: (opts: { taskId: number; tab: string; taskTitle?: string }) =>
    ipcRenderer.invoke('popout:open', opts),
  popoutClose: (opts: { taskId: number; tab: string }) =>
    ipcRenderer.invoke('popout:close', opts),
  popoutGetParams: () => ipcRenderer.invoke('popout:get-params') as Promise<{ popout: boolean; taskId: number | null; tab: string | null }>,
  onPopoutClosed: (callback: (data: { taskId: number; tab: string }) => void) => {
    const listener = (_: any, data: { taskId: number; tab: string }) => callback(data)
    ipcRenderer.on('popout:closed', listener)
    return () => { ipcRenderer.removeListener('popout:closed', listener) }
  },

  // ── Chrome Extensions ──
  loadExtension: (extensionPath: string) =>
    ipcRenderer.invoke('extensions:load', extensionPath),
  listExtensions: () =>
    ipcRenderer.invoke('extensions:list'),
  removeExtension: (extensionId: string) =>
    ipcRenderer.invoke('extensions:remove', extensionId),

  // ── FilePath ──
  filePathGetRoot: () => ipcRenderer.invoke('filepath:get-root') as Promise<{ projectRoot: string; rocaDir: string }>,
  filePathListDir: (dirPath: string) => ipcRenderer.invoke('filepath:list-dir', dirPath) as Promise<{ name: string; path: string; isDirectory: boolean; size?: number; modifiedAt?: string; childCount?: number }[]>,
  filePathReadFile: (filePath: string) => ipcRenderer.invoke('filepath:read-file', filePath) as Promise<{ ok: boolean; content: string; size: number }>,
  filePathSaveFile: (filePath: string, content: string) => ipcRenderer.invoke('filepath:save-file', filePath, content) as Promise<{ ok: boolean }>,

  // ── Agents ──
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsState: (agentName: string) => ipcRenderer.invoke('agents:state', agentName),
  agentsLogs: (agentLabel: string, lines?: number) => ipcRenderer.invoke('agents:logs', agentLabel, lines),
  agentsStart: (agentLabel: string) => ipcRenderer.invoke('agents:start', agentLabel),
  agentsStop: (agentLabel: string) => ipcRenderer.invoke('agents:stop', agentLabel),
  agentsOpenOutput: (agentLabel: string) => ipcRenderer.invoke('agents:open-output', agentLabel),
  agentsFiles: (agentName: string) => ipcRenderer.invoke('agents:files', agentName),
  agentsReadFile: (filePath: string) => ipcRenderer.invoke('agents:read-file', filePath),
  toolsFiles: (toolName: string) => ipcRenderer.invoke('tools:files', toolName),

})
