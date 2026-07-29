import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { WeeklyView } from './components/weekly-view'
import { NotesPanel } from './components/notes/notes-panel'
import { RightPanel, type PanelTab, ensureLocalTerminalTab } from './components/right-panel'
import { AssistantOverlay } from './components/assistant-overlay'
import { TopNav, type NavTab, type DynamicTab, type DynamicTabKind } from './components/top-nav'
import { SettingsBubble } from './components/settings-bubble'
import { ScribePanel } from './components/scribe/scribe-panel'
import type { ScribeRecording as ScribeRecordingDTO, ScribeSegment as ScribeSegmentDTO, CalEvent as CalEventDTO } from './components/scribe/types'
import { ScribeMeetingPopup } from './components/scribe/scribe-meeting-popup'
// FilePathView is now mounted inside the Settings overlay (settings-bubble.tsx).
// EmailView — DEPRECATED tab (kept in the repo, not rendered). The pinned
// Email tab was removed in favor of the Gmail webview tool in the `+` picker.
// Leaving the import commented out means we can restore the pane in one line
// without having to resurrect any other wiring.
// import { EmailView } from './components/email-view'
import { WebviewTool } from './components/webview-tool'
import { BrowserBar } from './components/browser-bar'
import { NewTabPage } from './components/new-tab-page'

const NEW_TAB_KIND = 'roca:newtab'

// Per-window namespace for tab-related localStorage entries. Multiple ROCA
// windows share the same localStorage origin (file:// or http://localhost),
// so tab state has to be keyed by windowId or they'd stomp on each other.
// The windowId arrives via the URL query string, set by main.ts in
// createWindow(). Falls back to 'primary' for the first window during
// migration (so the old un-namespaced keys are still readable).
const WINDOW_ID = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('windowId')
    return q || 'primary'
  } catch { return 'primary' }
})()

// Per-window key — drop in for the legacy un-namespaced key. The PRIMARY
// window also reads the legacy key on first load (one-time migration); see
// the localStorage initializers below.
const wkey = (k: string): string => `${k}:${WINDOW_ID}`
import {
  getToolByKind,
  loadCustomTools,
  saveCustomTools,
  createCustomTool,
  WEBVIEW_TOOLS,
  type WebviewToolSpec,
} from './lib/webview-tools'
import { FeedbackModal } from './components/feedback-modal'
import { ErrorBoundary } from './components/error-boundary'
import type { Task, TaskStatus, Folder, DelegateCache, DelegateMessage, DelegateExecution } from '@shared/types'
import { ASSISTANT_TASK_ID, ACTIVE_STATUSES } from '@shared/constants'
import { currentIsoWeek, isoWeeksInYear } from './lib/format-date'
import type { SpeechRecognitionInstance } from './lib/speech-recognition-manager'

export { ASSISTANT_TASK_ID }

export const ASSISTANT_TASK: Task = {
  id: ASSISTANT_TASK_ID,
  title: 'Assistant',
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
  forked_session_id: null,
  forked_source_cwd: null,
  browser_companion_of: null,
  merged_into_task_id: null,
}

export interface WeekData {
  id: number
  week: string
  challenges: string
  meetings_held: number
  created_at: string
}

type AgentEntry = {
  name: string; label: string; running: boolean;
  pid: number | null; lastExitCode: number | null;
  schedule: string | null; stateFile: string | null;
  alertOwner: boolean; outputDir: string | null
}

declare global {
  interface Window {
    electronAPI: {
      // Window management (multi-window + Chrome-style tabs)
      windowGetId: () => Promise<string | null>
      windowOpenNew: () => Promise<string | null>
      windowClose: () => Promise<{ ok: boolean }>
      windowReportStripBounds: (rect: { x: number; y: number; width: number; height: number } | null) => Promise<{ ok: boolean }>
      tabDragBegin: (payload: { tabId: string; serializedTab: unknown }) => Promise<{ ok: boolean; error?: string }>
      tabDragEnd: (payload: { cancelled?: boolean }) => Promise<{ ok: boolean; kind?: string }>
      onTabDragHover: (callback: (info: { x: number } | null) => void) => () => void
      onTabDrop: (callback: (data: { serializedTab: unknown; dropX: number }) => void) => () => void
      onTabRemove: (callback: (data: { tabId: string }) => void) => () => void

      // Environment
      getEnv: (key: string) => Promise<string | null>
      openExternal: (url: string) => Promise<boolean>
      onOpenUrlInNewTab: (callback: (url: string) => void) => () => void
      debugWrite?: (content: string) => Promise<void>
      writeErrorLog?: (content: string) => Promise<void>
      voiceLogSession: (entry: {
        event: string; state: string; taskId: number | null; tab: string;
        error?: string; spokenText?: string; transcript?: string;
      }) => Promise<boolean>

      // Tasks
      getTasks: (opts?: { week?: string; source?: string }) => Promise<Task[]>
      createTask: (task: { title: string; priority?: string; notes?: string }) => Promise<{ id: number }>
      toggleTask: (taskId: number) => Promise<Task>
      forkTask: (taskId: number) => Promise<{ id: number | null }>
      forkTaskSession: (sourceTaskId: number) => Promise<{
        ok: boolean
        sessionId?: string
        cwd?: string
        sourceTitle?: string
        sourceTaskId?: number
        error?: string
      }>
      forkSessionByPty: (sourcePtyId: string) => Promise<{
        ok: boolean
        sessionId?: string
        cwd?: string
        error?: string
      }>
      mirrorByPty: (sourcePtyId: string) => Promise<{
        ok: boolean
        ptyId?: string
        error?: string
      }>
      listMirrorCandidates: () => Promise<Array<{
        ptyId: string
        taskId: number | null
        isAssistant: boolean
        tabSuffix: string | null
        task?: Task
      }>>
      getTask: (taskId: number) => Promise<Task>
      getTasksByIds: (ids: number[]) => Promise<Task[]>
      mergeTasks: (sourceTaskId: number, destTaskId: number) => Promise<{
        ok: boolean
        error?: string
        mergedTabPtyId?: string
        mergedTabTabSuffix?: string
        mergedTabLabel?: string
        tmuxRenamed?: boolean
      }>
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
      addDelegateMessage: (taskId: number, role: string, content: string, cost?: number, turns?: number) => Promise<{ ok: boolean }>
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
      onBootTaskSession: (callback: (taskId: number) => void) => () => void
      onNavigateTab: (callback: (tab: string) => void) => () => void
      onPopupTab: (callback: (data: { url: string; partition: string }) => void) => () => void
      onBrowserOpen: (callback: (data: { taskId?: number; url: string }) => void) => () => void
      onAssistantNotify: (callback: () => void) => () => void
      onAssistantToggle: (callback: () => void) => () => void
      onTabCycle: (callback: (direction: 'prev' | 'next') => void) => () => void

      // SSH
      listSshHosts: () => Promise<Array<{ alias: string; hostname?: string; user?: string }>>
      openSshConfig: () => Promise<{ ok: boolean; path: string; reason?: 'missing'; error?: string }>

      // PTY
      startPty: (taskId: string, cwd?: string, host?: string) => Promise<{ ok: boolean; id: string; existing: boolean; tmuxReattached?: boolean; savedScrollback?: string; contextPath?: string; bypassPermissions?: boolean }>
      getPtyScrollback: (id: string) => Promise<string>
      getPtyStatuses: () => Promise<Record<string, string>>
      getLiveTaskIds: () => Promise<number[]>
      writePty: (id: string, data: string) => void
      resizePty: (id: string, cols: number, rows: number) => void
      killPty: (id: string) => Promise<{ ok: boolean }>
      pasteImage: () => Promise<{ ok: boolean; path: string | null; dataUrl: string | null }>
      uploadFile: (taskId: number, fileData: { buffer: Uint8Array; filename: string; mimeType: string }) => Promise<any>
      getUploadsForTask: (taskId: number) => Promise<any[]>
      deleteUpload: (uploadId: number) => Promise<{ ok: boolean }>
      serveUpload: (filename: string) => Promise<Uint8Array<ArrayBuffer> | null>
      serveUploadPath: (storedName: string) => Promise<{ path: string } | null>
      readXlsxWorkbook: (storedName: string) => Promise<any>
      writeXlsxCells: (storedName: string, changes: any[]) => Promise<{ ok: boolean; error?: string }>
      watchXlsxFile: (storedName: string) => Promise<void>
      unwatchXlsxFile: (storedName: string) => Promise<void>
      checkXlsxMtime: (storedName: string) => Promise<{ mtime: number }>
      onXlsxFileChanged: (callback: (storedName: string) => void) => () => void
      convertUploadToPdf: (storedName: string) => Promise<{ path?: string; error?: string } | null>
      convertPptxToSlides: (storedName: string) => Promise<{ slides?: string[]; pdf?: string; count?: number; error?: string }>
      getPptxNotes: (storedName: string) => Promise<{ notes: string[] }>
      getPptxSlideCount: (storedName: string) => Promise<{ count: number }>
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
      browserFindInPage: (taskId: number, text: string, forward: boolean) => Promise<{ ok: boolean }>
      browserStopFind: (taskId: number) => Promise<{ ok: boolean }>
      browserZoom: (taskId: number, direction: 'in' | 'out' | 'reset') => Promise<void>
      browserToggleDevTools: (taskId: number) => Promise<void>
      onBrowserStatus: (taskId: number, callback: (status: any) => void) => () => void
      onBrowserThought: (taskId: number, callback: (thought: string) => void) => () => void
      onBrowserOpenTab: (taskId: number, callback: (url: string) => void) => () => void

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

      // Notes (North Stars + weekly notes)
      getAlignment: () => Promise<string>
      saveAlignment: (content: string) => Promise<{ ok: boolean }>
      getWeeklyNotes: (week: string) => Promise<string>
      saveWeeklyNotes: (week: string, content: string) => Promise<{ ok: boolean }>

      // Notes (Apple-Notes-style: pinned / weekly / quarterly, many per scope)
      listNotes: () => Promise<{ notes: { id: string; title: string; scope: 'pinned' | 'weekly' | 'quarterly'; period: string | null; updatedAt: string; preview: string }[] }>
      createNote: (scope: 'pinned' | 'weekly' | 'quarterly', period: string | null, title: string) =>
        Promise<{ ok: boolean; note?: { id: string; title: string; scope: 'pinned' | 'weekly' | 'quarterly'; period: string | null; updatedAt: string; preview: string } }>
      renameNote: (id: string, title: string) => Promise<{ ok: boolean }>
      deleteNote: (id: string) => Promise<{ ok: boolean }>
      getNoteBody: (id: string) => Promise<string>
      saveNoteBody: (id: string, content: string) => Promise<{ ok: boolean }>

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

      // Dev Apps
      devGetAppsDir: () => Promise<string>
      devListApps: () => Promise<{ name: string; path: string; hasIndex: boolean; description: string; fileCount: number; createdAt: string; modifiedAt: string }[]>
      devCreateApp: (name: string, description?: string) => Promise<{ ok: boolean; name?: string; path?: string; error?: string }>
      devDeleteApp: (name: string) => Promise<{ ok: boolean; error?: string }>
      devOpenInFinder: (name: string) => Promise<{ ok: boolean }>
      devOpenInBrowser: (name: string) => Promise<{ ok: boolean }>

      // FilePath
      filePathGetRoot: () => Promise<{ projectRoot: string; rocaDir: string }>
      filePathListDir: (dirPath: string) => Promise<{ name: string; path: string; isDirectory: boolean; size?: number; modifiedAt?: string; childCount?: number }[]>
      filePathReadFile: (filePath: string) => Promise<{ ok: boolean; content: string; size: number }>
      filePathSaveFile: (filePath: string, content: string) => Promise<{ ok: boolean }>

      // Google Sheets
      sheetsOutreachData: () => Promise<string[][] | null>

      // Active context (read by ROCA Assistant)
      writeActiveContext: (ctx: {
        tab: 'email' | 'week' | 'notes' | 'filepath' | 'scribe' | null
        email?: { threadId: string; subject: string; from: string; to: string; messageCount: number; latestMessageText: string }
        file?: { path: string }
        slack?: { channelId: string; channelName?: string; threadTs?: string }
      }) => Promise<void>
      clearActiveContext?: () => Promise<void>

      // Gmail
      gmailGetProfile: () => Promise<{ displayName: string; email: string } | null>
      gmailListMessages: (opts?: any) => Promise<{ messages: any[]; nextPageToken?: string; failedCount: number; failedThreadIds?: string[] }>
      gmailGetThread: (threadId: string) => Promise<any>
      gmailSend: (opts: any) => Promise<{ id: string; threadId: string }>
      gmailReply: (messageId: string, body: string, headers?: { inReplyTo?: string; references?: string; replyTo?: string; from?: string; to?: string; cc?: string; subject?: string; threadId?: string }) => Promise<{ id: string; threadId: string }>
      gmailMarkThreadRead: (threadId: string) => Promise<void>
      gmailArchive: (messageId: string) => Promise<void>
      gmailTrash: (messageId: string) => Promise<void>
      gmailArchiveThread: (threadId: string) => Promise<void>
      gmailTrashThread: (threadId: string) => Promise<void>
      gmailUntrashThread: (threadId: string) => Promise<void>
      gmailMoveThreadToInbox: (threadId: string) => Promise<void>
      gmailStarThread: (threadId: string, starred: boolean) => Promise<void>
      gmailGetLabels: () => Promise<Array<{ id: string; name: string; type: string; threadsUnread?: number }>>
      gmailDownloadAttachment: (messageId: string, attachmentId: string, filename: string) => Promise<{ ok: boolean; error?: string; canceled?: boolean }>
      gmailGetInlineImage: (messageId: string, attachmentId: string, mimeType: string) => Promise<{ ok: boolean; data?: string; mimeType?: string; error?: string }>

      // Slack
      slackGetSelf: () => Promise<{ id: string; displayName: string } | null>
      slackGetConnectionStatus: () => Promise<{ connected: boolean; tokenKind: 'user' | 'bot' | 'none'; source: 'stored' | 'env' | 'none'; userId?: string; displayName?: string; team?: string; warning?: string }>
      slackSetUserToken: (token: string) => Promise<{ ok: boolean; error?: string; status?: { connected: boolean; tokenKind: 'user' | 'bot' | 'none'; source: 'stored' | 'env' | 'none'; userId?: string; displayName?: string; team?: string; warning?: string } }>
      slackDisconnect: () => Promise<{ connected: boolean; tokenKind: 'user' | 'bot' | 'none'; source: 'stored' | 'env' | 'none' }>
      slackGetOAuthConfig: () => Promise<{ clientId?: string; hasSecret: boolean }>
      slackSaveOAuthConfig: (clientId: string, clientSecret: string) => Promise<{ ok: boolean; error?: string }>
      slackStartOAuth: () => Promise<{ ok: boolean; error?: string; status?: { connected: boolean; tokenKind: 'user' | 'bot' | 'none'; source: 'stored' | 'env' | 'none'; userId?: string; displayName?: string; team?: string; warning?: string } }>
      slackListConversations: (opts?: any) => Promise<{ channels: any[]; nextCursor?: string; userMap?: Record<string, string> }>
      slackListMessages: (channelId: string, opts?: any) => Promise<{ messages: any[]; nextCursor?: string; hasMore: boolean; userMap?: Record<string, string> }>
      slackGetThread: (channelId: string, threadTs: string, opts?: { silent?: boolean; oldest?: string }) => Promise<{ messages: any[]; userMap?: Record<string, string>; truncated?: boolean; rootReplyCount?: number }>
      slackSendMessage: (channelId: string, text: string, opts?: any) => Promise<{ ok: boolean; ts: string; channel: string }>
      slackMarkRead: (channelId: string, timestamp: string) => Promise<void>
      slackDownloadFile: (url: string, name: string) => Promise<{ ok: boolean; error?: string; canceled?: boolean }>
      slackGetThumbnail: (url: string) => Promise<string>
      slackSearchMessages: (query: string, opts?: { count?: number; page?: number }) => Promise<{ messages: any[]; total: number; userMap: Record<string, string> }>
      slackGetUser: (userId: string) => Promise<{ id: string; name: string; realName: string; displayName: string; avatar: string; isBot: boolean }>
      slackAddReaction: (channelId: string, ts: string, emoji: string) => Promise<void>
      slackRemoveReaction: (channelId: string, ts: string, emoji: string) => Promise<void>

      // Optical view: per-task claude stream-json child process
      claudeStream: {
        start: (ptyId: string, cwd: string) => Promise<{ ok: boolean }>
        send: (ptyId: string, text: string) => Promise<{ ok: boolean }>
        stop: (ptyId: string) => Promise<{ ok: boolean }>
        usage: () => Promise<{ ok: boolean; data?: unknown; error?: string }>
        setPermissionMode: (ptyId: string, mode: string) => Promise<{ ok: boolean; mode: string }>
        scheduleCreate: (ptyId: string, text: string, sendAtMs: number) => Promise<{ ok: boolean; item?: unknown }>
        scheduleList: (ptyId: string) => Promise<{ ok: boolean; items: unknown[] }>
        scheduleCancel: (id: string) => Promise<{ ok: boolean }>
        onEvent: (
          ptyId: string,
          cb: (event: import('@shared/stream-json-events').StreamJsonEvent) => void,
        ) => () => void
        onEventBatch: (
          ptyId: string,
          cb: (events: import('@shared/stream-json-events').StreamJsonEvent[]) => void,
        ) => () => void
        onExit: (ptyId: string, cb: (code: number | null) => void) => () => void
        onError: (ptyId: string, cb: (err: string) => void) => () => void
        onStderr: (ptyId: string, cb: (text: string) => void) => () => void
        onStatus: (
          ptyId: string,
          cb: (status: { state: string; sessionId?: string; cwd?: string; mirrored?: boolean }) => void,
        ) => () => void
      }

      voice: {
        ensureSession: () => Promise<{ sessionId: string; isNew: boolean; warn: boolean }>
        send: (text: string) => Promise<{ ok: boolean; turnOrdinal: number }>
        newConversation: () => Promise<{ sessionId: string }>
        interrupt: () => Promise<{ sessionId: string }>
        getModel: () => Promise<{ model: string; label: string; models: Record<string, string> }>
        setModel: (model: string) => Promise<{ ok: boolean; model: string; label: string }>
        recover: () => Promise<{ sessionId: string }>
        recordExchange: (userText: string, replyText: string) => Promise<{ ok: boolean }>
        saveAttachments: (files: Array<{ name: string; type: string; buffer: Uint8Array }>) => Promise<{ paths: string[] }>
        transcribeLocal: (wav: Uint8Array) => Promise<{ ok: boolean; text?: string; error?: string }>
        ttsTrace: (entry: Record<string, unknown>) => Promise<boolean>
        onEvent: (cb: (event: import('@shared/stream-json-events').StreamJsonEvent) => void) => () => void
        onExit: (cb: (code: number | null) => void) => () => void
        onError: (cb: (err: string) => void) => () => void
        onToggle: (cb: () => void) => () => void
      }

      agentRuns: {
        watch: (ptyId: string) => Promise<{ ok: boolean }>
        unwatch: (ptyId: string) => Promise<{ ok: boolean }>
        get: (ptyId: string) => Promise<import('@shared/types').AgentRun[]>
        events: (ptyId: string, runId: string) => Promise<import('@shared/stream-json-events').StreamJsonEvent[]>
        onUpdate: (
          ptyId: string,
          cb: (runs: import('@shared/types').AgentRun[]) => void,
        ) => () => void
      }

      // Connections (settings bubble)
      connectionsList: () => Promise<Array<{
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
      }>>
      connectionsDisconnect: (id: string) => Promise<{ ok: boolean; error?: string }>
      connectionsSaveKey: (keyId: 'crm' | 'outreach' | 'slack-bot', key: string) => Promise<{ ok: boolean; account?: string; details?: string; error?: string }>
      connectionsTestKey: (keyId: 'crm' | 'outreach' | 'slack-bot', key: string) => Promise<{ ok: boolean; account?: string; details?: string; error?: string }>
      connectionsOpenExternal: (url: string) => Promise<void>
      connectionsListHooks: () => Promise<Array<{ event: string; matcher: string; command: string; type: string; label: string }>>
      connectionsListMessagingTokens: () => Promise<Array<{ channel: 'slack' | 'email'; label: string; status: 'configured' | 'unconfigured'; details: string; managedBy?: string; envKey?: string; getKeyUrl?: string; instructions: string }>>
      connectionsAddCustom: (input:
        | { kind: 'api'; name: string; envVarName: string; apiKey: string; getKeyUrl?: string; verify?: { url: string; headerName: string; headerTemplate: string } }
        | { kind: 'cli'; name: string; binaryPaths: string[]; installUrl: string; versionArgs: string[] }
      ) => Promise<{ ok: boolean; id?: string; error?: string }>
      connectionsListMcp: () => Promise<{
        available: boolean
        servers: Array<{ name: string; scope: 'user' | 'project'; command: string; args: string[]; status: 'connected' | 'failed' | 'unknown' }>
      }>
      connectionsAddMcp: (spec: { name: string; scope: 'user' | 'project'; command: string; args: string[]; env: Record<string, string> }) => Promise<{ ok: boolean; error?: string }>
      connectionsRemoveMcp: (name: string, scope: 'user' | 'project') => Promise<{ ok: boolean; error?: string }>

      // Scribe (meeting note-taker)
      scribe: {
        start: (title: string, calendarEventId?: string | null) => Promise<{ id: number } | { error: string }>
        stop: () => Promise<{ ok: boolean }>
        status: () => Promise<string>
        list: () => Promise<ScribeRecordingDTO[]>
        get: (id: number) => Promise<{ recording: ScribeRecordingDTO | undefined; segments: ScribeSegmentDTO[] }>
        ask: (id: number, question: string) => Promise<{ answer: string } | { error: string }>
        followupEmail: (id: number) => Promise<{ answer: string } | { error: string }>
        upcoming: () => Promise<CalEventDTO[]>
        rename: (id: number, title: string) => Promise<{ ok: boolean }>
        onMeetingStarting: (cb: (e: CalEventDTO) => void) => () => void
        onStatus: (cb: (p: { state: string }) => void) => () => void
        onSegment: (cb: (p: ScribeSegmentDTO & { recordingId: number }) => void) => () => void
        onDone: (cb: (p: { recordingId: number }) => void) => () => void
        onUpdated: (cb: (p: { recordingId: number }) => void) => () => void
      }
    }
    SpeechRecognition?: new () => SpeechRecognitionInstance
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance
  }
}


export function App() {
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
    // Read per-window key first; primary window falls back to legacy key.
    const saved = localStorage.getItem(wkey('roca:activeTab'))
      ?? (WINDOW_ID === 'primary' ? localStorage.getItem('roca:activeTab') : null)
    // 'filepath' (Files) moved into the Settings overlay — fall back to Tasks.
    if (saved === 'filepath') return 'week'
    // Other historical tab names also collapse onto Tasks.
    if (saved === 'journal' || saved === 'tools' || saved === 'agents') return 'week'
    if (saved === 'dev' || saved === 'dashboard') return 'week'
    if (saved === 'slack') return 'week'
    if (saved === 'email') return 'week'
    const VALID_TABS: NavTab[] = ['week', 'notes']
    return VALID_TABS.includes(saved as NavTab) ? (saved as NavTab) : 'week'
  })
  // Dynamic tabs — user-added tabs that embed external tools (e.g. Slack web).
  // Persisted so they survive app restart. activeDynamicId != null means the
  // active surface is a dynamic tab rather than `activeTab` (the pinned one).
  const [dynamicTabs, setDynamicTabs] = useState<DynamicTab[]>(() => {
    try {
      const raw = localStorage.getItem(wkey('roca:dynamicTabs'))
        ?? (WINDOW_ID === 'primary' ? localStorage.getItem('roca:dynamicTabs') : null)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter((t: unknown): t is DynamicTab => {
          if (!t || typeof t !== 'object') return false
          if (!('id' in t) || !('kind' in t) || !('label' in t)) return false
          // Drop tabs for retired tools (e.g. the rolled-back slack-web
          // experiment) so they don't linger as "Unknown tool" chips.
          if ((t as DynamicTab).kind === 'slack-web') return false
          return true
        })
        .map((t): DynamicTab => {
          // Popup tabs (Apps Script etc.) carry their own label derived
          // from the page title — preserve it. For default-landing tabs,
          // upgrade stale labels (early tabs stored the raw kind like
          // "gmail" instead of "Gmail") from the registry on load.
          if (t.initialUrl) return t
          const tool = getToolByKind(t.kind)
          return tool ? { ...t, label: tool.label } : t
        })
    } catch { return [] }
  })
  const [activeDynamicId, setActiveDynamicId] = useState<string | null>(() => {
    const saved = localStorage.getItem(wkey('roca:activeDynamicId'))
      ?? (WINDOW_ID === 'primary' ? localStorage.getItem('roca:activeDynamicId') : null)
    return saved || null
  })
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderColors, setFolderColors] = useState<string[]>([])
  const [feedbackModal, setFeedbackModal] = useState<{ type: 'feature' | 'bug' } | null>(null)
  // Fire-once tab trigger: set to 'terminal' in handleFeedbackSubmit, RightPanel switches then
  // calls onTabChanged() which resets it to 'notes'. This is intentionally event-via-state.
  const [rightPanelTab, setRightPanelTab] = useState<PanelTab>('notes')
  const [pendingAutoCommand, setPendingAutoCommand] = useState<string | null>(null)
  const [projectSelectedTask, setProjectSelectedTask] = useState<Task | null>(null)
  const projectSelectedTaskRef = useRef<Task | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [ptyStatuses, setPtyStatuses] = useState<Record<string, string>>({})
  const [assistantActive, setAssistantActive] = useState(false)
  const [assistantHasUpdates, setAssistantHasUpdates] = useState(false)
  // Voice is a MODE of the assistant overlay (⌘⇧A), not a separate window. It
  // reuses the same docked panel — clicking the mic (or ⌘⇧S) swaps the panel to
  // the voice orb; the back arrow returns to chat.
  const [assistantVoiceMode, setAssistantVoiceMode] = useState(false)
  const assistantActiveRef = useRef(false)
  const voiceModeRef = useRef(false)
  useEffect(() => { assistantActiveRef.current = assistantActive }, [assistantActive])
  useEffect(() => { voiceModeRef.current = assistantVoiceMode }, [assistantVoiceMode])

  // Cmd+Shift+A toggles ROCA Assistant as a right-side overlay over any tab.
  // No tab/task mutation — overlay coexists with whatever the user is doing.
  // The webview-tab fallback path is the IPC listener below: webviews capture
  // keyboard input, so when focus is in Gmail/CRM/etc., the renderer's
  // window keydown never fires. Main process intercepts ⌘⇧A on every webview
  // via before-input-event and forwards via this IPC.
  useEffect(() => {
    // Toggle the panel; always land on chat (not voice) when (re)opening via ⌘⇧A.
    const toggle = () => setAssistantActive(prev => { const next = !prev; if (next) setAssistantVoiceMode(false); return next })
    const keyHandler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', keyHandler)
    const cleanupIpc = window.electronAPI.onAssistantToggle?.(toggle)
    return () => {
      window.removeEventListener('keydown', keyHandler)
      cleanupIpc?.()
    }
  }, [])

  // Cmd+Shift+S jumps straight to voice: open the assistant panel in voice mode
  // (or close it if already there). Same dual-path (renderer keydown + IPC).
  useEffect(() => {
    const toggle = () => {
      const inVoice = assistantActiveRef.current && voiceModeRef.current
      if (inVoice) { setAssistantActive(false); setAssistantVoiceMode(false) }
      else { setAssistantActive(true); setAssistantVoiceMode(true) }
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', keyHandler)
    const cleanupIpc = window.electronAPI.voice.onToggle(toggle)
    return () => {
      window.removeEventListener('keydown', keyHandler)
      cleanupIpc?.()
    }
  }, [])

  // Listen for navigate-task from main process (RPC)
  useEffect(() => {
    const cleanup = window.electronAPI.onNavigateTask((taskId: number) => {
      setSelectedTaskId(taskId)
      if (!voiceModeRef.current) setAssistantActive(false)
      setProjectSelectedTask(null)
      setActiveTab('week')
    })
    return cleanup
  }, [])

  // Listen for navigate-tab from main process (RPC — screenshot walkthrough agent)
  useEffect(() => {
    const cleanup = window.electronAPI.onNavigateTab((tab: string) => {
      const validTabs: NavTab[] = ['week', 'notes']
      if (validTabs.includes(tab as NavTab)) {
        setActiveTab(tab as NavTab)
      }
    })
    return cleanup
  }, [])

  // Popup-from-guest → new ROCA tab. Main intercepts window.open from
  // dynamic-tool webviews (e.g. Sheets → Apps Script) and forwards the
  // url + partition here. We pick the first registered tool that uses
  // the same partition (so the new tab inherits the existing login) and
  // open a fresh tab pointed at the popup URL. The hostname becomes the
  // initial label and is replaced with the page <title> once it loads.
  useEffect(() => {
    const cleanup = window.electronAPI.onPopupTab?.((data) => {
      const { url, partition } = data
      let host = url
      try { host = new URL(url).hostname.replace(/^www\./, '') } catch {}
      const tool = WEBVIEW_TOOLS.find(t => t.partition === partition)
        ?? loadCustomTools().find(t => t.partition === partition)
      if (!tool) return
      const id = `${tool.kind}-popup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      setDynamicTabs(prev => [...prev, { id, kind: tool.kind, label: host, initialUrl: url }])
      setActiveDynamicId(id)
    })
    return cleanup
  }, [])

  // Listen for assistant notifications from monitor
  useEffect(() => {
    const handler = () => {
      if (!assistantActive) setAssistantHasUpdates(true)
    }
    const cleanup = window.electronAPI.onAssistantNotify?.(handler)
    return cleanup
  }, [assistantActive])

  // Persist UI state to localStorage so it survives hot-reloads
  useEffect(() => {
    if (selectedTaskId != null) {
      localStorage.setItem('roca:selectedTaskId', String(selectedTaskId))
    } else {
      localStorage.removeItem('roca:selectedTaskId')
    }
  }, [selectedTaskId])

  useEffect(() => {
    localStorage.setItem(wkey('roca:activeTab'), activeTab)
    // Let the ROCA Assistant know which tab the user is looking at. The email
    // view publishes its own richer context (with thread details) on select.
    // Only publish when no dynamic tab is active — dynamic tabs aren't yet
    // tracked in the active-context schema (follow-up work).
    if (activeDynamicId == null) {
      window.electronAPI.writeActiveContext({ tab: activeTab }).catch(() => {})
    }
  }, [activeTab, activeDynamicId])

  useEffect(() => {
    localStorage.setItem(wkey('roca:dynamicTabs'), JSON.stringify(dynamicTabs))
  }, [dynamicTabs])

  useEffect(() => {
    if (activeDynamicId) localStorage.setItem(wkey('roca:activeDynamicId'), activeDynamicId)
    else localStorage.removeItem(wkey('roca:activeDynamicId'))
  }, [activeDynamicId])

  const handleSelectDynamic = useCallback((id: string) => {
    setActiveDynamicId(id)
  }, [])

  const handleOpenDynamic = useCallback((kind: DynamicTabKind) => {
    // One dynamic tab per kind for the preloaded/saved tools — clicking the
    // tool again just brings the existing tab forward instead of duplicating.
    const existing = dynamicTabs.find(t => t.kind === kind)
    if (existing) { setActiveDynamicId(existing.id); return }
    const tool = getToolByKind(kind)
    const label = tool?.label ?? kind
    const id = `${kind}-${Date.now().toString(36)}`
    setDynamicTabs(prev => [...prev, { id, kind, label }])
    setActiveDynamicId(id)
  }, [dynamicTabs])

  // Cmd+Left / Cmd+Right cycle through the full tab strip (pinned + dynamic),
  // wrapping at the edges. Order matches the visual order in TopNav.
  const PINNED_ORDER: NavTab[] = ['week', 'notes', 'scribe']
  const cycleTab = useCallback((direction: 'prev' | 'next') => {
    const list: ({ kind: 'pinned'; tab: NavTab } | { kind: 'dynamic'; id: string })[] = [
      ...PINNED_ORDER.map(t => ({ kind: 'pinned' as const, tab: t })),
      ...dynamicTabs.map(d => ({ kind: 'dynamic' as const, id: d.id })),
    ]
    if (list.length === 0) return
    const currentIdx = activeDynamicId
      ? list.findIndex(e => e.kind === 'dynamic' && e.id === activeDynamicId)
      : list.findIndex(e => e.kind === 'pinned' && e.tab === activeTab)
    const safeIdx = currentIdx < 0 ? 0 : currentIdx
    const delta = direction === 'next' ? 1 : -1
    const nextIdx = (safeIdx + delta + list.length) % list.length
    const target = list[nextIdx]
    if (target.kind === 'pinned') {
      setActiveTab(target.tab)
      setActiveDynamicId(null)
    } else {
      setActiveDynamicId(target.id)
    }
  }, [activeTab, activeDynamicId, dynamicTabs])

  // Renderer-side keydown — fires when focus is in ROCA's UI (not inside a
  // webview). The webview path is handled in main.ts's before-input-event
  // and forwarded via onTabCycle below.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.shiftKey || e.ctrlKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      // Don't hijack start/end-of-line inside text inputs / contenteditable.
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return
      }
      e.preventDefault()
      cycleTab(e.key === 'ArrowLeft' ? 'prev' : 'next')
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cycleTab])

  // Webview-side fallback — main process intercepts Cmd+Arrow before the
  // guest page sees it and forwards the direction here.
  useEffect(() => {
    const cleanup = window.electronAPI.onTabCycle?.(cycleTab)
    return cleanup
  }, [cycleTab])

  // Browser-style new-tab: opens a ROCA new-tab landing page (URL bar +
  // app-store grid). The tab is later promoted to a real webview tab when
  // the user picks an app or types a URL.
  const handleNewTab = useCallback(() => {
    const id = `newtab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    setDynamicTabs(prev => [...prev, { id, kind: NEW_TAB_KIND, label: 'New Tab' }])
    setActiveDynamicId(id)
  }, [])

  // Reorder a dynamic tab to a new index in the strip. Pinned tabs are not
  // draggable, so `toIndex` is always within the dynamic-tabs slice.
  const handleReorderTab = useCallback((tabId: string, toIndex: number) => {
    setDynamicTabs(prev => {
      const fromIndex = prev.findIndex(t => t.id === tabId)
      if (fromIndex < 0) return prev
      const next = prev.slice()
      const [moved] = next.splice(fromIndex, 1)
      const clampedTo = Math.max(0, Math.min(toIndex, next.length))
      next.splice(clampedTo, 0, moved)
      return next
    })
  }, [])

  // ⌘N → new ROCA window. Native (main process) creates the window; this just
  // sends the IPC. The new window's renderer initializes its own state from
  // its per-windowId localStorage namespace (empty on first load).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.shiftKey || e.ctrlKey) return
      if (e.key.toLowerCase() !== 'n') return
      // Don't hijack ⌘N inside text fields — most apps treat that as "new"
      // within the field's context (Gmail compose, etc.). Webviews capture
      // their own keydowns, so the only fields here are ROCA's own inputs.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      window.electronAPI.windowOpenNew?.().catch(() => {})
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Cross-window tab-drag receiver. Main process forwards `tab:drop` when a
  // tab from another window is released over our strip (or when this is a
  // freshly-spawned tear-off window receiving its first tab). `tab:remove`
  // strips the original out of the source window. Drops append to the end
  // of the dynamic strip — Chrome inserts at the cursor position, but
  // appending is good enough for v1 and avoids a second DOM hit-test.
  useEffect(() => {
    const offDrop = window.electronAPI.onTabDrop?.((data) => {
      const tab = data.serializedTab as DynamicTab | null
      if (!tab || !tab.id) return
      setDynamicTabs(prev => {
        if (prev.some(t => t.id === tab.id)) return prev
        return [...prev, tab]
      })
      setActiveDynamicId(tab.id)
    })
    const offRemove = window.electronAPI.onTabRemove?.((data) => {
      setDynamicTabs(prev => prev.filter(t => t.id !== data.tabId))
      setActiveDynamicId(prev => prev === data.tabId ? null : prev)
    })
    return () => { offDrop?.(); offRemove?.() }
  }, [])

  // Open an arbitrary URL as a new dynamic tab in the top strip — used when
  // the user clicks a link in any task chat or runs /browse <url>. Mirrors the
  // popup-tab flow but origin is a chat click rather than a guest popup. Uses
  // the Google partition so the new tab inherits any Google sign-in (most
  // common follow-target). Auto-pops the assistant overlay so the user can keep
  // talking to the originating task while browsing.
  const handleOpenUrlInNewTab = useCallback((url: string) => {
    if (!url) return
    let host = url
    try { host = new URL(url).hostname.replace(/^www\./, '') } catch {}
    const id = `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    setDynamicTabs(prev => [...prev, { id, kind: 'google', label: host, initialUrl: url }])
    setActiveDynamicId(id)
    setAssistantActive(true)
  }, [])

  // Catch-all for URLs that would otherwise escape to the system browser —
  // main's setWindowOpenHandler + the shell:open-external IPC both forward
  // here. Covers xterm fallbacks, markdown <a target="_blank">, and any
  // direct openExternal callers.
  useEffect(() => {
    const cleanup = window.electronAPI.onOpenUrlInNewTab?.((url) => {
      handleOpenUrlInNewTab(url)
    })
    return cleanup
  }, [handleOpenUrlInNewTab])

  // Promote a `roca:newtab` tab in place to a real tool kind. Used by the
  // app-store grid on the new-tab page (click a tile → that tab loads the
  // app). Same flow as opening a fresh dynamic tab, except we mutate the
  // existing one instead of pushing a new entry.
  const handleConvertNewTab = useCallback((tabId: string, kind: string) => {
    const tool = getToolByKind(kind)
    if (!tool) return
    setDynamicTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, kind, label: tool.label, initialUrl: undefined } : t,
    ))
  }, [])

  const handleCloseDynamic = useCallback((id: string) => {
    setDynamicTabs(prev => prev.filter(t => t.id !== id))
    setActiveDynamicId(current => current === id ? null : current)
    setDynamicUnread(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setDynamicNav(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    dynamicWebviewRefs.current.delete(id)
  }, [])

  // Unread counts per dynamic tab (id → count). Populated when a registered
  // tool exposes parseUnreadFromTitle — right now only Gmail. Drives the
  // badge on the tab chip.
  const [dynamicUnread, setDynamicUnread] = useState<Record<string, number>>({})

  // Live favicons emitted by each guest webview once it loads. Falls back to
  // the tool spec's iconUrl when we don't have a live one yet.
  const [dynamicFavicons, setDynamicFavicons] = useState<Record<string, string>>({})
  const handleFaviconChange = useCallback((tabId: string, url: string) => {
    setDynamicFavicons(prev => (prev[tabId] === url ? prev : { ...prev, [tabId]: url }))
  }, [])

  // Per-tab browser navigation state — drives the top URL bar shown when a
  // dynamic webview tab is active. Each guest emits did-navigate / loading
  // events that flow into here.
  type DynamicNav = { url: string; loading: boolean; canBack: boolean; canForward: boolean }
  const [dynamicNav, setDynamicNav] = useState<Record<string, DynamicNav>>({})
  // Refs to each mounted webview element so the BrowserBar can drive them
  // (loadURL, goBack, etc.) without lifting the element itself into state.
  const dynamicWebviewRefs = useRef<Map<string, Electron.WebviewTag>>(new Map())
  const setDynamicWebviewRef = useCallback((tabId: string): React.MutableRefObject<Electron.WebviewTag | null> => {
    const map = dynamicWebviewRefs.current
    return {
      get current() { return map.get(tabId) ?? null },
      set current(el: Electron.WebviewTag | null) {
        if (el) map.set(tabId, el); else map.delete(tabId)
      },
    }
  }, [])
  const handleDynamicUrlChange = useCallback((tabId: string, url: string) => {
    if (!url) return
    setDynamicNav(prev => {
      const cur = prev[tabId]
      if (cur && cur.url === url) return prev
      return { ...prev, [tabId]: { ...(cur ?? { loading: false, canBack: false, canForward: false }), url } }
    })
  }, [])
  const handleDynamicLoadingChange = useCallback((tabId: string, loading: boolean) => {
    setDynamicNav(prev => {
      const cur = prev[tabId]
      if (cur && cur.loading === loading) return prev
      return { ...prev, [tabId]: { ...(cur ?? { url: '', canBack: false, canForward: false }), loading } }
    })
  }, [])
  const handleDynamicCanNavigateChange = useCallback((tabId: string, canBack: boolean, canForward: boolean) => {
    setDynamicNav(prev => {
      const cur = prev[tabId]
      if (cur && cur.canBack === canBack && cur.canForward === canForward) return prev
      return { ...prev, [tabId]: { ...(cur ?? { url: '', loading: false }), canBack, canForward } }
    })
  }, [])

  // Popup-tab labels start as the URL hostname (e.g. "script.google.com")
  // because we don't know what the page is until it loads. Once the guest
  // emits a <title>, replace the chip label with a trimmed version. Only
  // applied to tabs created via popup (initialUrl set) so we don't churn
  // the registry-defined labels for the standard tools.
  const handlePopupTitleChange = useCallback((tabId: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    // Strip trailing site suffixes like " - Google Apps Script" → "MyScript".
    const cleaned = trimmed.split(/\s[-–|]\s/)[0].slice(0, 60) || trimmed.slice(0, 60)
    setDynamicTabs(prev => prev.map(t => (
      t.id === tabId && t.initialUrl && t.label !== cleaned ? { ...t, label: cleaned } : t
    )))
  }, [])

  // User-added web apps — persisted to localStorage via webview-tools helpers.
  const [customTools, setCustomTools] = useState<WebviewToolSpec[]>(() => loadCustomTools())
  useEffect(() => { saveCustomTools(customTools) }, [customTools])

  const handleAddCustomTool = useCallback((url: string, label?: string) => {
    const spec = createCustomTool(url, label)
    if (!spec) return
    // Replace any existing spec with the same kind (same domain) so the
    // partition stays stable across remove/re-add. Sync-save to localStorage
    // so the subsequent handleOpenDynamic() can resolve the spec through
    // getToolByKind() without waiting for a render pass.
    const next = [...customTools.filter(t => t.kind !== spec.kind), spec]
    saveCustomTools(next)
    setCustomTools(next)
    // If the active tab is a fresh new-tab page, promote it in place
    // instead of stacking another tab on top of the empty new-tab.
    const activeNewTab = activeDynamicId ? dynamicTabs.find(t => t.id === activeDynamicId && t.kind === NEW_TAB_KIND) : null
    if (activeNewTab) {
      setDynamicTabs(prev => prev.map(t =>
        t.id === activeNewTab.id ? { ...t, kind: spec.kind, label: spec.label, initialUrl: undefined } : t,
      ))
      return
    }
    handleOpenDynamic(spec.kind)
  }, [customTools, handleOpenDynamic, activeDynamicId, dynamicTabs])

  const handleUnreadChange = useCallback((tabId: string, count: number) => {
    setDynamicUnread(prev => (prev[tabId] === count ? prev : { ...prev, [tabId]: count }))
  }, [])

  // BrowserBar visibility — the user can hide the URL bar to reclaim a row of
  // pixels on dynamic webview tabs. Persisted so the choice survives reload.
  const [browserBarHidden, setBrowserBarHidden] = useState<boolean>(() => {
    return localStorage.getItem('roca:browserBarHidden') === 'true'
  })
  useEffect(() => {
    localStorage.setItem('roca:browserBarHidden', String(browserBarHidden))
  }, [browserBarHidden])
  const handleToggleBrowserBar = useCallback(() => {
    setBrowserBarHidden(prev => !prev)
  }, [])

  // BrowserBar actions — drive the active dynamic webview from the top URL bar.
  const activeNav = activeDynamicId ? dynamicNav[activeDynamicId] : undefined
  const getActiveWebview = useCallback((): Electron.WebviewTag | null => {
    if (!activeDynamicId) return null
    return dynamicWebviewRefs.current.get(activeDynamicId) ?? null
  }, [activeDynamicId])
  const handleBrowserBarNavigate = useCallback((url: string) => {
    // If the active tab is a fresh ROCA new-tab page (no webview yet),
    // promote it to a Google-partition webview pointed at this URL. This
    // matches Chrome's behavior: typing into a new tab's omnibox opens the
    // page in the same tab.
    const activeTab = activeDynamicId ? dynamicTabs.find(t => t.id === activeDynamicId) : null
    if (activeTab?.kind === NEW_TAB_KIND) {
      const tool = getToolByKind('google')
      const label = tool?.label ?? 'Google'
      setDynamicTabs(prev => prev.map(t =>
        t.id === activeTab.id ? { ...t, kind: 'google', label, initialUrl: url } : t,
      ))
      return
    }
    const wv = getActiveWebview()
    if (!wv) return
    try { (wv as { loadURL: (u: string) => void }).loadURL(url) } catch (err) { console.error('[BrowserBar] loadURL failed:', err) }
  }, [activeDynamicId, dynamicTabs, getActiveWebview])
  const handleBrowserBarBack = useCallback(() => {
    const wv = getActiveWebview() as { canGoBack?: () => boolean; goBack?: () => void } | null
    if (wv?.canGoBack?.()) wv.goBack?.()
  }, [getActiveWebview])
  const handleBrowserBarForward = useCallback(() => {
    const wv = getActiveWebview() as { canGoForward?: () => boolean; goForward?: () => void } | null
    if (wv?.canGoForward?.()) wv.goForward?.()
  }, [getActiveWebview])
  const handleBrowserBarReload = useCallback(() => {
    const wv = getActiveWebview() as { reload?: () => void } | null
    wv?.reload?.()
  }, [getActiveWebview])
  const handleBrowserBarStop = useCallback(() => {
    const wv = getActiveWebview() as { stop?: () => void } | null
    wv?.stop?.()
  }, [getActiveWebview])

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

  // Listen for boot-task-session from main process (RPC task:boot — voice "create
  // a task and start its session"). Selects the task, forces the right panel to
  // its terminal, and ensures a local terminal tab exists — which mounts
  // TaskTerminal and runs the existing auto-launch, booting Claude in view.
  useEffect(() => {
    const cleanup = window.electronAPI.onBootTaskSession(async (taskId: number) => {
      await loadDataRef.current() // a freshly-created task must be in the tasks array to render
      if (!voiceModeRef.current) setAssistantActive(false)
      setProjectSelectedTask(null)
      setActiveTab('week')
      setSelectedTaskId(taskId)
      setRightPanelTab('terminal')
      ensureLocalTerminalTab(taskId)
    })
    return cleanup
  }, [])

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
    try {
      const { id } = await window.electronAPI.createTask({ title, priority })
      await loadData()
      setSelectedTaskId(id as number)
    } catch (e) {
      console.error('[handleCreateTask] failed:', e)
    }
  }, [loadData])

  // Navigate to a newly created task (shared by fork + split)
  const navigateToNewTask = useCallback(async (id: number, openTerminal = true) => {
    const cw = currentIsoWeek()
    const needsWeekChange = week !== cw
    const needsFilterClear = sourceFilter !== null

    if (needsWeekChange) setWeek(cw)
    if (needsFilterClear) setSourceFilter(null)

    if (!needsWeekChange && !needsFilterClear) {
      await loadData()
    }

    setSelectedTaskId(id)
    if (openTerminal) setRightPanelTab('terminal')
  }, [loadData, week, sourceFilter])

  const handleToggleTask = useCallback(async (taskId: number) => {
    const task = await window.electronAPI.toggleTask(taskId)
    await loadData()
    // Navigate home when task is completed (tmux session persists for 1 day)
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
    } catch (err) {
      console.error('[Organize] Failed:', err)
      setOrganizeError(`Organize failed: ${err instanceof Error ? err.message : 'unknown error'}`)
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
    // Keep the voice panel pinned while navigating tasks; only auto-close the
    // text assistant chat.
    if (!voiceModeRef.current) setAssistantActive(false)
  }, [])

  // Flow State's Shift+↑/↓ jump: same as selecting a task, but also forces the
  // right panel to its terminal so the user lands on the live session, not notes.
  const handleFlowNavigate = useCallback((id: number) => {
    setSelectedTaskId(id)
    setProjectSelectedTask(null)
    if (!voiceModeRef.current) setAssistantActive(false)
    setRightPanelTab('terminal')
  }, [])

  const handleTabChange = useCallback((tab: NavTab) => {
    setActiveTab(tab)
    // Clicking a pinned tab deselects any active dynamic tab so the pinned
    // surface actually comes forward. Dynamic tabs stay open (just not active).
    setActiveDynamicId(null)
    // Don't clear selectedTaskId — preserve task selection across tab switches
    // so terminal sessions survive when switching to inbox/journal and back
  }, [])


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
  // Drag one task onto another's row body to combine them. Notes are stitched
  // together with a "Merged from" separator, sessions/uploads move with the
  // source, and if the source had a live tmux Claude session it shows up as a
  // new tab on the destination so the workstream continues uninterrupted.
  const handleMergeTasks = useCallback(async (sourceId: number, destId: number) => {
    if (sourceId === destId) return
    const source = tasks.find(t => t.id === sourceId)
    const dest = tasks.find(t => t.id === destId)
    if (!source || !dest) return

    const proceed = window.confirm(
      `Merge "${source.title}" into "${dest.title}"?\n\n` +
      `Notes and sessions will be combined into "${dest.title}". The original task will be hidden.`
    )
    if (!proceed) return

    const result = await window.electronAPI.mergeTasks(sourceId, destId)
    if (!result.ok) {
      console.error('[merge] failed:', result.error)
      window.alert(`Merge failed: ${result.error ?? 'unknown error'}`)
      return
    }

    // If the source had any terminal activity, surface it as a new tab on the
    // destination so the user can see both workstreams side-by-side.
    if (result.mergedTabTabSuffix && result.mergedTabLabel) {
      try {
        const tabsKey = `roca:terminalTabs:task-${destId}`
        const activeKey = `roca:terminalActiveTab:task-${destId}`
        type StoredTab = { id: string; label: string }
        let tabs: StoredTab[]
        try {
          const raw = localStorage.getItem(tabsKey)
          const parsed = raw ? JSON.parse(raw) : null
          tabs = Array.isArray(parsed) && parsed.every((t: unknown) =>
            typeof (t as StoredTab)?.id === 'string' && typeof (t as StoredTab)?.label === 'string'
          ) ? parsed as StoredTab[] : [{ id: '', label: 'Main' }]
        } catch {
          tabs = [{ id: '', label: 'Main' }]
        }
        if (!tabs.some(t => t.id === result.mergedTabTabSuffix)) {
          tabs.push({ id: result.mergedTabTabSuffix, label: result.mergedTabLabel })
          localStorage.setItem(tabsKey, JSON.stringify(tabs))
          // Don't auto-switch to the merged tab — keep the user's current tab
          // active. The new tab is just available in the strip.
        }
        // Tell any mounted RightPanel for this task to re-read localStorage.
        window.dispatchEvent(
          new CustomEvent('roca:task-tabs-changed', { detail: { taskId: destId } })
        )
      } catch (err) {
        console.warn('[merge] failed to register merged tab in localStorage:', err)
      }
    }

    // If the user was viewing the now-deleted source task, switch them to dest.
    if (selectedTaskId === sourceId) setSelectedTaskId(destId)

    await loadDataRef.current()
  }, [tasks, selectedTaskId])

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
          if (result?.ok && result.stored_name) {
            uploadResults.push(`![${file.name}](/uploads/${result.stored_name})`)
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
        // Legacy tab names — Files moved into Settings, so most flows route
        // back to the Tasks (week) view. Files/agents are now under ⌘,.
        const tabArg = args.trim()
        const tabMap: Record<string, string> = {
          journal: 'week', tools: 'week', agents: 'week', filepath: 'week',
          dev: 'week', slack: 'week', email: 'week',
        }
        const tabTarget = tabMap[tabArg] || tabArg
        if (tabTarget === 'week') {
          handleTabChange('week')
        }
        break
      }
      case 'agents':
        // Files/Agents now live in the Settings overlay (⌘,). Land on Tasks.
        handleTabChange('week')
        break
      case 'agent': {
        try {
          const parts = args.split(/\s+/)
          const action = parts[0]?.toLowerCase()
          const name = parts.slice(1).join(' ')
          if (action === 'start' && name) {
            const agents = await window.electronAPI.agentsList()
            const match = agents.find((a: AgentEntry) => a.name.toLowerCase() === name.toLowerCase()
              || a.label.toLowerCase() === name.toLowerCase())
            if (match) window.electronAPI.agentsStart(match.label).catch((err: unknown) => console.error('[agent cmd]', err))
            else console.warn('[agent cmd] no agent found for name:', name)
          } else if (action === 'stop' && name) {
            const agents = await window.electronAPI.agentsList()
            const match = agents.find((a: AgentEntry) => a.name.toLowerCase() === name.toLowerCase()
              || a.label.toLowerCase() === name.toLowerCase())
            if (match) window.electronAPI.agentsStop(match.label).catch((err: unknown) => console.error('[agent cmd]', err))
            else console.warn('[agent cmd] no agent found for name:', name)
          }
        } catch (err) {
          console.error('[agent cmd]', err)
        }
        break
      }
      case 'popout':
        if (currentTask) {
          window.electronAPI.popoutOpen({ taskId: currentTask, tab: rightPanelTab })
        }
        break
      // notes, files, terminal, browser, clear, help — handled in RightPanel/TaskTerminal
    }
  }, [selectedTaskId, projectSelectedTask, rightPanelTab, handleSync, handleCreateTask, handleToggleTask, handleStatusChange, handlePriorityChange, navigateWeek, handleTabChange])

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
    // Navigate home when task is completed (tmux session persists for 1 day)
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
    setAssistantActive(prev => !prev)
    setAssistantHasUpdates(false)
  }, [])

  const handleGoToCurrentWeek = useCallback(() => {
    setWeekData(null)
    setWeek(currentIsoWeek())
  }, [])

  const selectedTask = useMemo(
    () => tasks.find(t => t.id === selectedTaskId) || completedTasks.find(t => t.id === selectedTaskId) || null,
    [tasks, completedTasks, selectedTaskId]
  )

  // Flow State crosses week boundaries, so a selected task can live outside the
  // current week's `tasks`/`completedTasks`. Fetch that row on demand and hold
  // it here so the RightPanel renders the right task (and its live terminal)
  // instead of falling back to the previously-shown one.
  const [externalTask, setExternalTask] = useState<Task | null>(null)
  useEffect(() => {
    // < 0 covers the virtual assistant (ASSISTANT_TASK_ID) — it has no DB row,
    // so a getTask lookup would throw.
    if (selectedTaskId == null || selectedTaskId < 0) { setExternalTask(null); return }
    if (tasks.some(t => t.id === selectedTaskId) || completedTasks.some(t => t.id === selectedTaskId)) {
      setExternalTask(null) // in-week row is authoritative — no override needed
      return
    }
    if (externalTask?.id === selectedTaskId) return // already fetched
    let cancelled = false
    window.electronAPI.getTask(selectedTaskId)
      .then(t => { if (!cancelled && t) setExternalTask(t as Task) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedTaskId, tasks, completedTasks, externalTask])

  const resolvedSelectedTask = selectedTask
    || (externalTask?.id === selectedTaskId ? externalTask : null)

  // Keep ref to last valid selected task — prevents RightPanel (and its terminal pool)
  // from unmounting during transient null states caused by organize/loadData transitions
  const lastSelectedTaskRef = useRef<Task | null>(null)
  if (resolvedSelectedTask) lastSelectedTaskRef.current = resolvedSelectedTask
  else if (selectedTaskId == null) lastSelectedTaskRef.current = null

  // Use last-known task as fallback when selectedTaskId is set but task not yet in arrays
  const displayTask = resolvedSelectedTask || (selectedTaskId != null ? lastSelectedTaskRef.current : null)

  const openTasks = useMemo(
    () => tasks.filter(t => ACTIVE_STATUSES.includes(t.status)),
    [tasks]
  )

  return (
    <div className="flex flex-col h-screen bg-surface-0 text-text-1">
      <div className="relative shrink-0">
        <ErrorBoundary>
          <TopNav
            activeTab={activeTab}
            activeDynamicId={activeDynamicId}
            dynamicTabs={dynamicTabs}
            week={week}
            onTabChange={handleTabChange}
            onSelectDynamic={handleSelectDynamic}
            onCloseDynamic={handleCloseDynamic}
            onNewTab={handleNewTab}
            onReorderTab={handleReorderTab}
            onFeedback={(type) => setFeedbackModal({ type })}
            dynamicUnread={dynamicUnread}
            dynamicFavicons={dynamicFavicons}
            customTools={customTools}
          />
        </ErrorBoundary>
      </div>
      {activeDynamicId && (
        <BrowserBar
          url={activeNav?.url ?? ''}
          isLoading={activeNav?.loading ?? false}
          canGoBack={activeNav?.canBack ?? false}
          canGoForward={activeNav?.canForward ?? false}
          hidden={browserBarHidden}
          onNavigate={handleBrowserBarNavigate}
          onBack={handleBrowserBarBack}
          onForward={handleBrowserBarForward}
          onReload={handleBrowserBarReload}
          onStop={handleBrowserBarStop}
          onToggleHidden={handleToggleBrowserBar}
        />
      )}
      {feedbackModal && (
        <FeedbackModal
          type={feedbackModal.type}
          currentTask={resolvedSelectedTask ? { id: resolvedSelectedTask.id, title: resolvedSelectedTask.title } : null}
          onSubmit={handleFeedbackSubmit}
          onClose={() => setFeedbackModal(null)}
        />
      )}
      <ErrorBoundary>
      <div className="flex flex-1 overflow-hidden">
        {/* Tab content container — compresses when AssistantOverlay is visible */}
        <div className="flex flex-1 overflow-hidden min-w-0">
        {/* Week view stays mounted (hidden) so RightPanel & terminals survive tab switches */}
        <div className={`flex flex-1 overflow-hidden ${activeTab === 'week' && activeDynamicId == null ? '' : 'hidden'}`}>
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
                onNavigateToTaskTerminal={handleFlowNavigate}
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
                onMergeTasks={handleMergeTasks}
                ptyStatuses={ptyStatuses}
                onAssistant={handleAssistant}
                assistantActive={assistantActive}
                assistantHasUpdates={assistantHasUpdates}
              />
            </div>
            {/* Projects panel removed */}
            {/* Drag handle — only interactive when expanded */}
            <div
              className={`absolute top-0 right-0 w-[4px] h-full cursor-col-resize hover:bg-purple-1/20 transition-colors z-10 ${leftPanelCollapsed ? 'pointer-events-none' : ''}`}
              onMouseDown={handleResizeStart}
              onDoubleClick={handleResizeDoubleClick}
            />
          </div>
          <main className="flex-1 flex flex-col overflow-hidden">
            {(displayTask || projectSelectedTask) ? (
              <RightPanel
                task={(displayTask || projectSelectedTask)!}
                initialTab={rightPanelTab}
                onDataChange={handleRightPanelDataChange}
                onToggleRecurring={handleToggleRecurring}
                onComplete={handleRightPanelComplete}
                onStatusChange={handleRightPanelStatusChange}
                onPriorityChange={handleRightPanelPriorityChange}
                onTitleChange={handleRightPanelTitleChange}
                onTabChanged={() => setRightPanelTab('notes')}
                autoCommand={pendingAutoCommand}
                onAutoCommandConsumed={() => setPendingAutoCommand(null)}
                onSlashCommand={handleSlashCommand}
                onCollapseTaskList={() => setLeftPanelCollapsed(prev => !prev)}
                taskListCollapsed={leftPanelCollapsed}
                onSelectTaskId={setSelectedTaskId}
                onOpenUrlInNewTab={handleOpenUrlInNewTab}
              />
            ) : (
              <div className="flex-1 overflow-hidden flex items-center justify-center">
                <p className="text-text-3 text-sm">Select a task to get started</p>
              </div>
            )}
          </main>
        </div>
        {/* Notes tab — the full note-taking surface. Shares the notesStore
            (and therefore the same docs, live) with the assistant's right-panel
            notes overlay. Mounted only while active — its editor state lives in
            the store, so unmounting on tab-switch loses nothing. */}
        {activeTab === 'notes' && activeDynamicId == null && (
          <div className="flex flex-1 overflow-hidden">
            <NotesPanel variant="full" />
          </div>
        )}
        {activeTab === 'scribe' && activeDynamicId == null && (
          <div className="flex flex-1 overflow-hidden">
            <ScribePanel />
          </div>
        )}
        {/* Email pane — DEPRECATED, not rendered. Restore by re-importing
            EmailView at the top of this file and uncommenting below. */}
        {/* <div className={`flex-1 overflow-hidden ${activeTab === 'email' && activeDynamicId == null ? 'flex' : 'hidden'}`}>
          <EmailView onUnreadCount={setEmailUnreadCount} />
        </div> */}
        {/* Files used to live here as a pinned tab; it now sits inside the
            Settings overlay (⌘,) instead. */}
        {/* Dynamic tool tabs — each stays mounted so the guest webview
            survives tab switches (no reload, no lost scroll). Tool specs
            come from webview-tools.ts. */}
        {dynamicTabs.map(dt => {
          if (dt.kind === NEW_TAB_KIND) {
            return (
              <div
                key={dt.id}
                className={`flex-1 overflow-hidden ${activeDynamicId === dt.id ? 'flex' : 'hidden'}`}
              >
                <NewTabPage
                  preloadedTools={WEBVIEW_TOOLS}
                  customTools={customTools}
                  onPickKind={(kind) => handleConvertNewTab(dt.id, kind)}
                  onAddCustomTool={handleAddCustomTool}
                />
              </div>
            )
          }
          const tool = getToolByKind(dt.kind)
          return (
            <div
              key={dt.id}
              className={`flex-1 overflow-hidden ${activeDynamicId === dt.id ? 'flex' : 'hidden'}`}
            >
              {tool ? (
                <WebviewTool
                  tool={tool}
                  initialUrl={dt.initialUrl}
                  webviewRef={setDynamicWebviewRef(dt.id)}
                  onUnreadChange={(count) => handleUnreadChange(dt.id, count)}
                  onFaviconChange={(url) => handleFaviconChange(dt.id, url)}
                  onTitleChange={dt.initialUrl ? (title) => handlePopupTitleChange(dt.id, title) : undefined}
                  onUrlChange={(url) => handleDynamicUrlChange(dt.id, url)}
                  onLoadingChange={(loading) => handleDynamicLoadingChange(dt.id, loading)}
                  onCanNavigateChange={(b, f) => handleDynamicCanNavigateChange(dt.id, b, f)}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-text-3 text-sm">
                  Unknown tool: {dt.kind}
                </div>
              )}
            </div>
          )
        })}
        </div>
        {/* Global right-side Assistant — Cmd+Shift+A, visible over any tab */}
        <AssistantOverlay
          active={assistantActive}
          assistantTask={ASSISTANT_TASK}
          onOpenVoice={() => setAssistantVoiceMode(true)}
          voiceMode={assistantVoiceMode}
          onExitVoice={() => setAssistantVoiceMode(false)}
          onSlashCommand={handleSlashCommand}
          onSelectTaskId={setSelectedTaskId}
          onOpenUrlInNewTab={handleOpenUrlInNewTab}
        />
      </div>
      </ErrorBoundary>
      {/* Global settings bubble — bottom-left, lists external connections */}
      <SettingsBubble />
      {/* "Start note taker" prompt when a calendar meeting begins */}
      <ScribeMeetingPopup />
    </div>
  )
}
