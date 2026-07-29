import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Window management (Chrome-style multi-window + tabs) ──
  // The window's stable registry ID is fetched once at renderer startup and
  // used to namespace localStorage keys + identify the window in cross-window
  // tab-drag IPC. Resolved lazily because the renderer asks via IPC after the
  // preload runs.
  windowGetId: () => ipcRenderer.invoke('window:get-id') as Promise<string | null>,
  windowOpenNew: () => ipcRenderer.invoke('window:open') as Promise<string | null>,
  windowClose: () => ipcRenderer.invoke('window:close') as Promise<{ ok: boolean }>,
  windowReportStripBounds: (rect: { x: number; y: number; width: number; height: number } | null) =>
    ipcRenderer.invoke('window:report-strip-bounds', rect) as Promise<{ ok: boolean }>,

  // ── Tab drag (cross-window, tear-off) ──
  // The source renderer calls `tabDragBegin` on dragstart with the tab's full
  // serialized state. Main starts polling the cursor and forwards hover/drop
  // events. `tabDragEnd` finalizes the drag.
  tabDragBegin: (payload: { tabId: string; serializedTab: unknown }) =>
    ipcRenderer.invoke('tab:drag-begin', payload) as Promise<{ ok: boolean; error?: string }>,
  tabDragEnd: (payload: { cancelled?: boolean }) =>
    ipcRenderer.invoke('tab:drag-end', payload) as Promise<{ ok: boolean; kind?: string }>,
  onTabDragHover: (callback: (info: { x: number } | null) => void) => {
    const listener = (_: unknown, info: { x: number } | null) => callback(info)
    ipcRenderer.on('tab:drag-hover', listener)
    return () => { ipcRenderer.removeListener('tab:drag-hover', listener) }
  },
  onTabDrop: (callback: (data: { serializedTab: unknown; dropX: number }) => void) => {
    const listener = (_: unknown, data: { serializedTab: unknown; dropX: number }) => callback(data)
    ipcRenderer.on('tab:drop', listener)
    return () => { ipcRenderer.removeListener('tab:drop', listener) }
  },
  onTabRemove: (callback: (data: { tabId: string }) => void) => {
    const listener = (_: unknown, data: { tabId: string }) => callback(data)
    ipcRenderer.on('tab:remove', listener)
    return () => { ipcRenderer.removeListener('tab:remove', listener) }
  },

  // ── Environment ──
  getEnv: (key: string) => ipcRenderer.invoke('env:get', key),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<boolean>,
  onOpenUrlInNewTab: (callback: (url: string) => void) => {
    const listener = (_: unknown, url: string) => callback(url)
    ipcRenderer.on('roca:open-url-in-new-tab', listener)
    return () => { ipcRenderer.removeListener('roca:open-url-in-new-tab', listener) }
  },
  debugWrite: (content: string) => ipcRenderer.invoke('debug:write', content),
  writeErrorLog: (content: string) => ipcRenderer.invoke('error:write-log', content),
  voiceLogSession: (entry: {
    event: string; state: string; taskId: number | null; tab: string;
    error?: string; spokenText?: string; transcript?: string;
  }) => ipcRenderer.invoke('voice:log-session', entry),

  // ── Tasks ──
  getTasks: (opts?: { week?: string; status?: string; source?: string; priority?: string }) =>
    ipcRenderer.invoke('db:tasks:list', opts),
  getTask: (taskId: number) => ipcRenderer.invoke('db:tasks:get', taskId),
  getTasksByIds: (ids: number[]) => ipcRenderer.invoke('db:tasks:by-ids', ids),
  createTask: (task: {
    title: string; source?: string; source_id?: string;
    priority?: string; due_date?: string;
    company_name?: string; deal_name?: string;
    notes?: string; week?: string
  }) => ipcRenderer.invoke('db:tasks:create', task),
  toggleTask: (taskId: number) => ipcRenderer.invoke('db:tasks:toggle', taskId),
  forkTask: (taskId: number) => ipcRenderer.invoke('db:tasks:fork', taskId) as Promise<{ id: number | null }>,
  forkTaskSession: (sourceTaskId: number) =>
    ipcRenderer.invoke('db:tasks:fork-session', sourceTaskId) as Promise<{
      ok: boolean
      sessionId?: string
      cwd?: string
      sourceTitle?: string
      sourceTaskId?: number
      error?: string
    }>,
  forkSessionByPty: (sourcePtyId: string) =>
    ipcRenderer.invoke('db:sessions:fork-by-pty', sourcePtyId) as Promise<{
      ok: boolean
      sessionId?: string
      cwd?: string
      error?: string
    }>,
  mirrorByPty: (sourcePtyId: string) =>
    ipcRenderer.invoke('db:tasks:mirror-by-pty', sourcePtyId) as Promise<{
      ok: boolean
      ptyId?: string
      error?: string
    }>,
  listMirrorCandidates: () =>
    ipcRenderer.invoke('db:tasks:list-mirror-candidates') as Promise<unknown[]>,
  mergeTasks: (sourceTaskId: number, destTaskId: number) =>
    ipcRenderer.invoke('db:tasks:merge', sourceTaskId, destTaskId) as Promise<{
      ok: boolean
      error?: string
      mergedTabPtyId?: string
      mergedTabTabSuffix?: string
      mergedTabLabel?: string
      tmuxRenamed?: boolean
    }>,
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
  readXlsxWorkbook: (storedName: string) => ipcRenderer.invoke('xlsx:read-workbook', storedName),
  writeXlsxCells: (storedName: string, changes: any[]) => ipcRenderer.invoke('xlsx:write-cells', storedName, changes),
  watchXlsxFile: (storedName: string) => ipcRenderer.invoke('xlsx:watch', storedName),
  unwatchXlsxFile: (storedName: string) => ipcRenderer.invoke('xlsx:unwatch', storedName),
  checkXlsxMtime: (storedName: string) => ipcRenderer.invoke('xlsx:check-mtime', storedName) as Promise<{ mtime: number }>,
  onXlsxFileChanged: (callback: (storedName: string) => void) => {
    const listener = (_: any, storedName: string) => callback(storedName)
    ipcRenderer.on('xlsx:file-changed', listener)
    return () => { ipcRenderer.removeListener('xlsx:file-changed', listener) }
  },
  convertUploadToPdf: (storedName: string) => ipcRenderer.invoke('db:uploads:convert-pdf', storedName),
  convertPptxToSlides: (storedName: string) => ipcRenderer.invoke('pptx:to-slides', storedName) as Promise<{ slides?: string[]; pdf?: string; count?: number; error?: string }>,
  getPptxNotes: (storedName: string) => ipcRenderer.invoke('pptx:get-notes', storedName) as Promise<{ notes: string[] }>,
  getPptxSlideCount: (storedName: string) => ipcRenderer.invoke('pptx:slide-count', storedName) as Promise<{ count: number }>,
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

  // ── Voice-notes webhook ──
  ingestVoiceNotesWebhook: (payload: any) => ipcRenderer.invoke('webhook:voice-notes', payload),

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
  onBootTaskSession: (callback: (taskId: number) => void) => {
    const listener = (_: any, taskId: number) => callback(taskId)
    ipcRenderer.on('app:boot-task-session', listener)
    return () => { ipcRenderer.removeListener('app:boot-task-session', listener) }
  },
  onAssistantNotify: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:assistant-notify', listener)
    return () => { ipcRenderer.removeListener('app:assistant-notify', listener) }
  },
  onAssistantToggle: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('global-shortcut:assistant-toggle', listener)
    return () => { ipcRenderer.removeListener('global-shortcut:assistant-toggle', listener) }
  },
  onTabCycle: (callback: (direction: 'prev' | 'next') => void) => {
    const listener = (_: any, direction: 'prev' | 'next') => callback(direction)
    ipcRenderer.on('global-shortcut:tab-cycle', listener)
    return () => { ipcRenderer.removeListener('global-shortcut:tab-cycle', listener) }
  },
  onBrowserOpen: (callback: (data: { taskId?: number; url: string }) => void) => {
    const listener = (_: any, data: { taskId?: number; url: string }) => callback(data)
    ipcRenderer.on('app:browser-open', listener)
    return () => { ipcRenderer.removeListener('app:browser-open', listener) }
  },
  onNavigateTab: (callback: (tab: string) => void) => {
    const listener = (_: any, tab: string) => callback(tab)
    ipcRenderer.on('app:navigate-tab', listener)
    return () => { ipcRenderer.removeListener('app:navigate-tab', listener) }
  },
  onPopupTab: (callback: (data: { url: string; partition: string }) => void) => {
    const listener = (_: any, data: { url: string; partition: string }) => callback(data)
    ipcRenderer.on('app:open-popup-tab', listener)
    return () => { ipcRenderer.removeListener('app:open-popup-tab', listener) }
  },

  // ── Warp ──
  openWarp: (script?: string) => ipcRenderer.invoke('open:warp', script),

  // ── Clipboard ──
  pasteImage: () => ipcRenderer.invoke('clipboard:paste-image') as Promise<{ ok: boolean; path: string | null; dataUrl: string | null }>,

  // ── SSH ──
  listSshHosts: () => ipcRenderer.invoke('ssh:list-hosts') as Promise<Array<{ alias: string; hostname?: string; user?: string }>>,
  openSshConfig: () => ipcRenderer.invoke('ssh:open-config') as Promise<{ ok: boolean; path: string; reason?: 'missing'; error?: string }>,

  // ── PTY ──
  startPty: (taskId: string, cwd?: string, host?: string) => ipcRenderer.invoke('pty:start', taskId, cwd, host) as Promise<{ ok: boolean; id: string; existing: boolean; tmuxReattached?: boolean; savedScrollback?: string; contextPath?: string; bypassPermissions?: boolean }>,
  getPtyScrollback: (id: string) => ipcRenderer.invoke('pty:scrollback', id) as Promise<string>,
  getPtyStatuses: () => ipcRenderer.invoke('pty:statuses') as Promise<Record<string, string>>,
  getLiveTaskIds: () => ipcRenderer.invoke('pty:live-task-ids') as Promise<number[]>,
  writePty: (id: string, data: string) => ipcRenderer.send('pty:input', { id, data }),
  resizePty: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id: string) => ipcRenderer.invoke('pty:kill', id),

  // ── Claude stream (optical view) ──
  scribe: {
    start: (title: string, calendarEventId?: string | null) =>
      ipcRenderer.invoke('scribe:start', { title, calendarEventId }) as Promise<{ id: number } | { error: string }>,
    stop: () => ipcRenderer.invoke('scribe:stop') as Promise<{ ok: boolean }>,
    status: () => ipcRenderer.invoke('scribe:status') as Promise<string>,
    list: () => ipcRenderer.invoke('scribe:list') as Promise<unknown[]>,
    get: (id: number) => ipcRenderer.invoke('scribe:get', id) as Promise<{ recording: unknown; segments: unknown[] }>,
    ask: (id: number, question: string) =>
      ipcRenderer.invoke('scribe:ask', { id, question }) as Promise<{ answer: string } | { error: string }>,
    followupEmail: (id: number) =>
      ipcRenderer.invoke('scribe:followup-email', id) as Promise<{ answer: string } | { error: string }>,
    upcoming: () => ipcRenderer.invoke('scribe:upcoming') as Promise<unknown[]>,
    rename: (id: number, title: string) =>
      ipcRenderer.invoke('scribe:rename', { id, title }) as Promise<{ ok: boolean }>,
    onMeetingStarting: (cb: (e: any) => void) => {
      const listener = (_: any, e: any) => cb(e)
      ipcRenderer.on('scribe:meeting-starting', listener)
      return () => { ipcRenderer.removeListener('scribe:meeting-starting', listener) }
    },
    onStatus: (cb: (p: { state: string }) => void) => {
      const listener = (_: any, p: { state: string }) => cb(p)
      ipcRenderer.on('scribe:status', listener)
      return () => { ipcRenderer.removeListener('scribe:status', listener) }
    },
    onSegment: (cb: (p: any) => void) => {
      const listener = (_: any, p: any) => cb(p)
      ipcRenderer.on('scribe:segment', listener)
      return () => { ipcRenderer.removeListener('scribe:segment', listener) }
    },
    onDone: (cb: (p: { recordingId: number }) => void) => {
      const listener = (_: any, p: { recordingId: number }) => cb(p)
      ipcRenderer.on('scribe:done', listener)
      return () => { ipcRenderer.removeListener('scribe:done', listener) }
    },
    onUpdated: (cb: (p: { recordingId: number }) => void) => {
      const listener = (_: any, p: { recordingId: number }) => cb(p)
      ipcRenderer.on('scribe:updated', listener)
      return () => { ipcRenderer.removeListener('scribe:updated', listener) }
    },
  },
  claudeStream: {
    start: (ptyId: string, cwd: string) => ipcRenderer.invoke('claude-stream:start', ptyId, cwd) as Promise<{ ok: boolean }>,
    send: (ptyId: string, text: string) => ipcRenderer.invoke('claude-stream:send', ptyId, text) as Promise<{ ok: boolean }>,
    stop: (ptyId: string) => ipcRenderer.invoke('claude-stream:stop', ptyId) as Promise<{ ok: boolean }>,
    usage: () => ipcRenderer.invoke('claude-stream:usage') as Promise<{ ok: boolean; data?: unknown; error?: string }>,
    setPermissionMode: (ptyId: string, mode: string) => ipcRenderer.invoke('claude-stream:set-permission-mode', ptyId, mode) as Promise<{ ok: boolean; mode: string }>,
    scheduleCreate: (ptyId: string, text: string, sendAtMs: number) => ipcRenderer.invoke('claude-schedule:create', ptyId, text, sendAtMs) as Promise<{ ok: boolean; item?: unknown }>,
    scheduleList: (ptyId: string) => ipcRenderer.invoke('claude-schedule:list', ptyId) as Promise<{ ok: boolean; items: unknown[] }>,
    scheduleCancel: (id: string) => ipcRenderer.invoke('claude-schedule:cancel', id) as Promise<{ ok: boolean }>,
    onEvent: (ptyId: string, cb: (event: unknown) => void) => {
      const channel = `claude-stream:event:${ptyId}`
      const listener = (_: any, event: unknown) => cb(event)
      ipcRenderer.on(channel, listener)
      return () => { ipcRenderer.removeListener(channel, listener) }
    },
    onEventBatch: (ptyId: string, cb: (events: unknown[]) => void) => {
      const channel = `claude-stream:batch:${ptyId}`
      const listener = (_: any, events: unknown[]) => cb(events)
      ipcRenderer.on(channel, listener)
      return () => { ipcRenderer.removeListener(channel, listener) }
    },
    onExit: (ptyId: string, cb: (code: number | null) => void) => {
      const channel = `claude-stream:exit:${ptyId}`
      const listener = (_: any, code: number | null) => cb(code)
      ipcRenderer.on(channel, listener)
      return () => { ipcRenderer.removeListener(channel, listener) }
    },
    onError: (ptyId: string, cb: (err: string) => void) => {
      const channel = `claude-stream:error:${ptyId}`
      const listener = (_: any, err: string) => cb(err)
      ipcRenderer.on(channel, listener)
      return () => { ipcRenderer.removeListener(channel, listener) }
    },
    onStderr: (ptyId: string, cb: (text: string) => void) => {
      const channel = `claude-stream:stderr:${ptyId}`
      const listener = (_: any, text: string) => cb(text)
      ipcRenderer.on(channel, listener)
      return () => { ipcRenderer.removeListener(channel, listener) }
    },
    onStatus: (ptyId: string, cb: (status: { state: string; sessionId?: string; cwd?: string; mirrored?: boolean }) => void) => {
      const channel = `claude-stream:status:${ptyId}`
      const listener = (_: any, status: { state: string; sessionId?: string; cwd?: string }) => cb(status)
      ipcRenderer.on(channel, listener)
      return () => { ipcRenderer.removeListener(channel, listener) }
    },
  },

  // ── Voice assistant (Cmd+Shift+S) — its own persistent Claude conversation ──
  voice: {
    ensureSession: () => ipcRenderer.invoke('voice:ensure-session') as Promise<{ sessionId: string; isNew: boolean; warn: boolean }>,
    send: (text: string) => ipcRenderer.invoke('voice:send', text) as Promise<{ ok: boolean; turnOrdinal: number }>,
    newConversation: () => ipcRenderer.invoke('voice:new-conversation') as Promise<{ sessionId: string }>,
    interrupt: () => ipcRenderer.invoke('voice:interrupt') as Promise<{ sessionId: string }>,
    getModel: () => ipcRenderer.invoke('voice:get-model') as Promise<{ model: string; label: string; models: Record<string, string> }>,
    setModel: (model: string) => ipcRenderer.invoke('voice:set-model', model) as Promise<{ ok: boolean; model: string; label: string }>,
    recover: () => ipcRenderer.invoke('voice:recover') as Promise<{ sessionId: string }>,
    recordExchange: (userText: string, replyText: string) => ipcRenderer.invoke('voice:record-exchange', userText, replyText) as Promise<{ ok: boolean }>,
    saveAttachments: (files: Array<{ name: string; type: string; buffer: Uint8Array }>) => ipcRenderer.invoke('voice:save-attachments', files) as Promise<{ paths: string[] }>,
    transcribeLocal: (wav: Uint8Array) => ipcRenderer.invoke('voice:transcribe-local', wav) as Promise<{ ok: boolean; text?: string; error?: string }>,
    ttsTrace: (entry: Record<string, unknown>) => ipcRenderer.invoke('voice:tts-trace', entry) as Promise<boolean>,
    onEvent: (cb: (event: unknown) => void) => {
      const listener = (_: any, event: unknown) => cb(event)
      ipcRenderer.on('claude-stream:event:voice', listener)
      return () => { ipcRenderer.removeListener('claude-stream:event:voice', listener) }
    },
    onExit: (cb: (code: number | null) => void) => {
      const listener = (_: any, code: number | null) => cb(code)
      ipcRenderer.on('claude-stream:exit:voice', listener)
      return () => { ipcRenderer.removeListener('claude-stream:exit:voice', listener) }
    },
    onError: (cb: (err: string) => void) => {
      const listener = (_: any, err: string) => cb(err)
      ipcRenderer.on('claude-stream:error:voice', listener)
      return () => { ipcRenderer.removeListener('claude-stream:error:voice', listener) }
    },
    onToggle: (cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on('global-shortcut:voice-toggle', listener)
      return () => { ipcRenderer.removeListener('global-shortcut:voice-toggle', listener) }
    },
  },

  // ── Sub-agent runs (Task/Agent calls surfaced in the files sidebar) ──
  agentRuns: {
    watch: (ptyId: string) => ipcRenderer.invoke('agent-runs:watch', ptyId) as Promise<{ ok: boolean }>,
    unwatch: (ptyId: string) => ipcRenderer.invoke('agent-runs:unwatch', ptyId) as Promise<{ ok: boolean }>,
    get: (ptyId: string) => ipcRenderer.invoke('agent-runs:get', ptyId) as Promise<unknown[]>,
    events: (ptyId: string, runId: string) => ipcRenderer.invoke('agent-runs:events', ptyId, runId) as Promise<unknown[]>,
    onUpdate: (ptyId: string, cb: (runs: unknown[]) => void) => {
      const channel = `agent-runs:update:${ptyId}`
      const listener = (_: any, runs: unknown[]) => cb(runs)
      ipcRenderer.on(channel, listener)
      return () => { ipcRenderer.removeListener(channel, listener) }
    },
  },

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
  browserFindInPage: (taskId: number, text: string, forward: boolean) =>
    ipcRenderer.invoke('browser:find-in-page', taskId, text, forward),
  browserStopFind: (taskId: number) =>
    ipcRenderer.invoke('browser:stop-find', taskId),
  browserToggleDevTools: (taskId: number) =>
    ipcRenderer.invoke('browser:toggle-devtools', taskId),
  browserZoom: (taskId: number, direction: 'in' | 'out' | 'reset') =>
    ipcRenderer.invoke('browser:zoom', taskId, direction),
  browserGetFavicon: (taskId: number) =>
    ipcRenderer.invoke('browser:get-favicon', taskId) as Promise<string | null>,

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
  onBrowserOpenTab: (taskId: number, callback: (url: string) => void) => {
    const channel = `browser:open-tab:${taskId}`
    const listener = (_: any, url: string) => callback(url)
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

  // ── Notes (North Stars + weekly notes) ──
  getAlignment: () => ipcRenderer.invoke('alignment:get'),
  saveAlignment: (content: string) => ipcRenderer.invoke('alignment:save', content),
  getWeeklyNotes: (week: string) => ipcRenderer.invoke('weeklyNotes:get', week),
  saveWeeklyNotes: (week: string, content: string) => ipcRenderer.invoke('weeklyNotes:save', week, content),

  // ── Notes (Apple-Notes-style: pinned / weekly / quarterly, many per scope) ──
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (scope: string, period: string | null, title: string) =>
    ipcRenderer.invoke('notes:create', { scope, period, title }),
  renameNote: (id: string, title: string) => ipcRenderer.invoke('notes:rename', { id, title }),
  deleteNote: (id: string) => ipcRenderer.invoke('notes:delete', { id }),
  getNoteBody: (id: string) => ipcRenderer.invoke('notes:getBody', { id }),
  saveNoteBody: (id: string, content: string) => ipcRenderer.invoke('notes:saveBody', { id, content }),

  // ── Skills ──
  listSkills: () => ipcRenderer.invoke('skills:list') as Promise<{ name: string; path: string; dir: string; content: string }[]>,
  getSkill: (skillPath: string) => ipcRenderer.invoke('skills:get', skillPath) as Promise<string>,
  saveSkill: (skillPath: string, content: string) => ipcRenderer.invoke('skills:save', skillPath, content) as Promise<{ ok: boolean }>,

  // ── Task Context ──
  generateTaskContext: (taskId: number) => ipcRenderer.invoke('task-context:generate', taskId),

  // ── Reflection & Proactive ──
  triggerReflection: () => ipcRenderer.invoke('roca:reflect') as Promise<{ ok: boolean; error?: string }>,
  triggerProactive: (mode?: string) => ipcRenderer.invoke('roca:proactive', mode) as Promise<{ ok: boolean; error?: string }>,

  // ── Active context (what the user is currently looking at — read by ROCA Assistant) ──
  writeActiveContext: (ctx: {
    tab: 'email' | 'week' | 'notes' | 'filepath' | 'slack' | 'scribe' | null
    email?: { threadId: string; subject: string; from: string; to: string; messageCount: number; latestMessageText: string }
    file?: { path: string }
    slack?: { channelId: string; channelName?: string; threadTs?: string }
  }) => ipcRenderer.invoke('roca:write-active-context', ctx) as Promise<void>,
  clearActiveContext: () => ipcRenderer.invoke('roca:clear-active-context') as Promise<void>,

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

  // ── Google Sheets ──
  sheetsOutreachData: () => ipcRenderer.invoke('sheets:outreach-data') as Promise<string[][] | null>,

  // ── Gmail ──
  gmailGetProfile: () =>
    ipcRenderer.invoke('gmail:get-profile') as Promise<{ displayName: string; email: string } | null>,
  gmailListMessages: (opts?: { maxResults?: number; pageToken?: string; query?: string; labelIds?: string[]; includeSpamTrash?: boolean }) =>
    ipcRenderer.invoke('gmail:list-messages', opts),
  gmailGetThread: (threadId: string) =>
    ipcRenderer.invoke('gmail:get-thread', threadId),
  gmailSend: (opts: { to: string; subject: string; body: string; cc?: string; bcc?: string; threadId?: string; inReplyTo?: string; references?: string }) =>
    ipcRenderer.invoke('gmail:send', opts),
  gmailReply: (messageId: string, body: string, headers?: { inReplyTo?: string; references?: string; replyTo?: string; from?: string; to?: string; cc?: string; subject?: string; threadId?: string }) =>
    ipcRenderer.invoke('gmail:reply', messageId, body, headers),
  gmailMarkThreadRead: (threadId: string) =>
    ipcRenderer.invoke('gmail:mark-thread-read', threadId),
  gmailArchive: (messageId: string) =>
    ipcRenderer.invoke('gmail:archive', messageId),
  gmailTrash: (messageId: string) =>
    ipcRenderer.invoke('gmail:trash', messageId),
  gmailArchiveThread: (threadId: string) =>
    ipcRenderer.invoke('gmail:archive-thread', threadId),
  gmailTrashThread: (threadId: string) =>
    ipcRenderer.invoke('gmail:trash-thread', threadId),
  gmailUntrashThread: (threadId: string) =>
    ipcRenderer.invoke('gmail:untrash-thread', threadId),
  gmailMoveThreadToInbox: (threadId: string) =>
    ipcRenderer.invoke('gmail:move-thread-to-inbox', threadId),
  gmailStarThread: (threadId: string, starred: boolean) =>
    ipcRenderer.invoke('gmail:star-thread', threadId, starred),
  gmailGetLabels: () =>
    ipcRenderer.invoke('gmail:get-labels') as Promise<Array<{ id: string; name: string; type: string; threadsUnread?: number }>>,
  gmailDownloadAttachment: (messageId: string, attachmentId: string, filename: string) =>
    ipcRenderer.invoke('gmail:download-attachment', messageId, attachmentId, filename),
  gmailGetInlineImage: (messageId: string, attachmentId: string, mimeType: string) =>
    ipcRenderer.invoke('gmail:get-inline-image', messageId, attachmentId, mimeType) as Promise<{ ok: boolean; data?: string; mimeType?: string; error?: string }>,

  // ── Slack ──
  slackGetSelf: () =>
    ipcRenderer.invoke('slack:get-self') as Promise<{ id: string; displayName: string; avatar?: string } | null>,
  slackGetConnectionStatus: () =>
    ipcRenderer.invoke('slack:get-connection-status') as Promise<{
      connected: boolean
      tokenKind: 'user' | 'bot' | 'none'
      source: 'stored' | 'env' | 'none'
      userId?: string
      displayName?: string
      team?: string
      warning?: string
    }>,
  slackSetUserToken: (token: string) =>
    ipcRenderer.invoke('slack:set-user-token', token) as Promise<{ ok: boolean; error?: string; status?: { connected: boolean; tokenKind: 'user' | 'bot' | 'none'; source: 'stored' | 'env' | 'none'; userId?: string; displayName?: string; team?: string; warning?: string } }>,
  slackDisconnect: () =>
    ipcRenderer.invoke('slack:disconnect'),
  slackGetOAuthConfig: () =>
    ipcRenderer.invoke('slack:get-oauth-config') as Promise<{ clientId?: string; hasSecret: boolean }>,
  slackSaveOAuthConfig: (clientId: string, clientSecret: string) =>
    ipcRenderer.invoke('slack:save-oauth-config', clientId, clientSecret) as Promise<{ ok: boolean; error?: string }>,
  slackStartOAuth: () =>
    ipcRenderer.invoke('slack:start-oauth') as Promise<{ ok: boolean; error?: string; status?: { connected: boolean; tokenKind: 'user' | 'bot' | 'none'; source: 'stored' | 'env' | 'none'; userId?: string; displayName?: string; team?: string; warning?: string } }>,
  slackListConversations: (opts?: { types?: string; limit?: number; cursor?: string; pollMode?: boolean }) =>
    ipcRenderer.invoke('slack:list-conversations', opts),
  slackListMessages: (channelId: string, opts?: { limit?: number; cursor?: string; oldest?: string; latest?: string }) =>
    ipcRenderer.invoke('slack:list-messages', channelId, opts),
  slackGetThread: (channelId: string, threadTs: string, opts?: { silent?: boolean; oldest?: string }) =>
    ipcRenderer.invoke('slack:get-thread', channelId, threadTs, opts),
  slackSendMessage: (channelId: string, text: string, opts?: { threadTs?: string }) =>
    ipcRenderer.invoke('slack:send-message', channelId, text, opts),
  slackMarkRead: (channelId: string, timestamp: string) =>
    ipcRenderer.invoke('slack:mark-read', channelId, timestamp),
  slackDownloadFile: (url: string, name: string) =>
    ipcRenderer.invoke('slack:download-file', url, name),
  slackGetThumbnail: (url: string) =>
    ipcRenderer.invoke('slack:get-thumbnail', url) as Promise<string>,
  slackSearchMessages: (query: string, opts?: { count?: number; page?: number }) =>
    ipcRenderer.invoke('slack:search-messages', query, opts) as Promise<{ messages: any[]; total: number; userMap: Record<string, string> }>,
  slackGetUser: (userId: string) =>
    ipcRenderer.invoke('slack:get-user', userId) as Promise<{ id: string; name: string; realName: string; displayName: string; avatar: string; isBot: boolean }>,
  slackAddReaction: (channelId: string, ts: string, emoji: string) =>
    ipcRenderer.invoke('slack:add-reaction', channelId, ts, emoji) as Promise<void>,
  slackRemoveReaction: (channelId: string, ts: string, emoji: string) =>
    ipcRenderer.invoke('slack:remove-reaction', channelId, ts, emoji) as Promise<void>,

  // ── Dev Apps ──
  devGetAppsDir: () => ipcRenderer.invoke('dev:get-apps-dir') as Promise<string>,
  devListApps: () => ipcRenderer.invoke('dev:list-apps') as Promise<{ name: string; path: string; hasIndex: boolean; description: string; fileCount: number; createdAt: string; modifiedAt: string }[]>,
  devCreateApp: (name: string, description?: string) => ipcRenderer.invoke('dev:create-app', name, description) as Promise<{ ok: boolean; name?: string; path?: string; error?: string }>,
  devDeleteApp: (name: string) => ipcRenderer.invoke('dev:delete-app', name) as Promise<{ ok: boolean; error?: string }>,
  devOpenInFinder: (name: string) => ipcRenderer.invoke('dev:open-in-finder', name) as Promise<{ ok: boolean }>,
  devOpenInBrowser: (name: string) => ipcRenderer.invoke('dev:open-in-browser', name) as Promise<{ ok: boolean }>,

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

  // ── Connections (settings bubble) ──
  connectionsList: () => ipcRenderer.invoke('connections:list') as Promise<Array<{
    id: string
    name: string
    category: 'CRM' | 'Google Workspace' | 'Messaging' | 'Outreach' | 'Meetings' | 'Developer' | 'Custom'
    status: 'connected' | 'disconnected' | 'unverified'
    account?: string
    details?: string
    disconnectable?: boolean
    isCustom?: boolean
    setup:
      | { kind: 'api-key'; keyId: 'crm' | 'outreach' | 'slack-bot'; envKey: string; placeholder: string; getKeyUrl: string; docsUrl?: string; help: string }
      | { kind: 'slack-oauth'; getKeyUrl: string; help: string }
      | { kind: 'google-oauth'; tokenPath: string; getKeyUrl: string; help: string }
      | { kind: 'external-app'; appName: string; downloadUrl: string; help: string }
      | { kind: 'cli-tool'; binaryPath?: string; version?: string; installUrl: string; help: string }
      | { kind: 'custom-api'; envVarName: string; getKeyUrl?: string; verify?: { url: string; headerName: string; headerTemplate: string }; help: string }
      | { kind: 'custom-cli'; binaryPath?: string; version?: string; installUrl: string; help: string }
  }>>,
  connectionsDisconnect: (id: string) =>
    ipcRenderer.invoke('connections:disconnect', id) as Promise<{ ok: boolean; error?: string }>,
  connectionsSaveKey: (keyId: 'crm' | 'outreach' | 'slack-bot', key: string) =>
    ipcRenderer.invoke('connections:save-key', keyId, key) as Promise<{ ok: boolean; account?: string; details?: string; error?: string }>,
  connectionsTestKey: (keyId: 'crm' | 'outreach' | 'slack-bot', key: string) =>
    ipcRenderer.invoke('connections:test-key', keyId, key) as Promise<{ ok: boolean; account?: string; details?: string; error?: string }>,
  connectionsOpenExternal: (url: string) =>
    ipcRenderer.invoke('connections:open-external', url) as Promise<void>,
  connectionsListHooks: () => ipcRenderer.invoke('connections:list-hooks') as Promise<Array<{
    event: string; matcher: string; command: string; type: string; label: string
  }>>,
  connectionsListMessagingTokens: () => ipcRenderer.invoke('connections:list-messaging-tokens') as Promise<Array<{
    channel: 'slack' | 'email'
    label: string
    status: 'configured' | 'unconfigured'
    details: string
    managedBy?: string
    envKey?: string
    getKeyUrl?: string
    instructions: string
  }>>,
  connectionsAddCustom: (input:
    | { kind: 'api'; name: string; envVarName: string; apiKey: string; getKeyUrl?: string; verify?: { url: string; headerName: string; headerTemplate: string } }
    | { kind: 'cli'; name: string; binaryPaths: string[]; installUrl: string; versionArgs: string[] }
  ) => ipcRenderer.invoke('connections:add-custom', input) as Promise<{ ok: boolean; id?: string; error?: string }>,
  connectionsListMcp: () => ipcRenderer.invoke('connections:list-mcp') as Promise<{
    available: boolean
    servers: Array<{ name: string; scope: 'user' | 'project'; command: string; args: string[]; status: 'connected' | 'failed' | 'unknown' }>
  }>,
  connectionsAddMcp: (spec: { name: string; scope: 'user' | 'project'; command: string; args: string[]; env: Record<string, string> }) =>
    ipcRenderer.invoke('connections:add-mcp', spec) as Promise<{ ok: boolean; error?: string }>,
  connectionsRemoveMcp: (name: string, scope: 'user' | 'project') =>
    ipcRenderer.invoke('connections:remove-mcp', name, scope) as Promise<{ ok: boolean; error?: string }>,

})
