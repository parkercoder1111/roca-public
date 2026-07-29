// ═══════════════════════════════════════════
//  ROCA Shared Types — Complete schema
// ═══════════════════════════════════════════

export type TaskStatus =
  | 'needs_input'
  | 'draft_ready'
  | 'open'
  | 'waiting'
  | 'blocked'
  | 'in_progress'
  | 'done'
  | 'carried'

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'

export type TaskSource =
  | 'manual'
  | 'crm'
  | 'google_tasks'
  | 'voice_notes'
  | 'transcript'
  | 'meeting_notes'
  | 'recurring'
  | 'organized'
  | 'assistant'

export interface Task {
  id: number
  title: string
  source: string
  source_id: string | null
  priority: string
  status: TaskStatus
  due_date: string | null
  company_name: string | null
  deal_name: string | null
  notes: string | null
  week: string
  sort_order: number
  scheduled_at: string | null
  folder_id: number | null
  project_id: string | null
  triaged_at: string | null
  created_at: string
  completed_at: string | null
  forked_session_id: string | null
  forked_source_cwd: string | null
  browser_companion_of: number | null
  // Set when this task was merged into another (via the drag-merge UI).
  // The row stays as a tombstone so re-sync dedup checks still find its
  // (source, source_id) pair and skip recreation. UI queries filter on
  // `merged_into_task_id IS NULL` so it's invisible everywhere.
  merged_into_task_id: number | null
  // UI-computed flags
  is_recurring?: boolean
  has_cache?: boolean
  // Most recent of: created_at, triaged_at, completed_at, last delegate message,
  // last execution, last task session, last PTY scrollback write. Drives the
  // Active/Stale/Old age filter in WeeklyView. ISO8601 string.
  last_activity_at?: string
}

export interface Week {
  id: number
  week: string
  challenges: string
  meetings_held: number
  created_at: string
}

export interface RecurringTask {
  id: number
  title: string
  priority: string
  company_name: string | null
  deal_name: string | null
  notes: string | null
  created_at: string
}

export interface DelegateCache {
  id: number
  task_id: number
  plan: string | null
  context: string | null
  cost: number
  turns: number
  error: string | null
  session_id: string | null
  created_at: string
}

export interface DelegateExecution {
  id: number
  task_id: number
  status: string
  output: string | null
  cost: number
  started_at: string
  completed_at: string | null
}

export interface DelegateMessage {
  id: number
  task_id: number
  role: string
  content: string
  cost: number
  turns: number
  created_at: string
}

export interface Upload {
  id: number
  task_id: number
  message_id: number | null
  filename: string
  stored_name: string
  mime_type: string
  size: number
  created_at: string
}

// A sub-agent the main claude session spun up mid-conversation (a Task/Agent
// tool call). Derived live from the session transcript, not persisted — it
// exists for as long as the conversation it belongs to is on screen.
export interface AgentRun {
  id: string                 // the spawning tool_use id (toolu_…)
  title: string              // the tool call's `description`
  subagentType: string       // `subagent_type`, e.g. "Explore" ('' if unset)
  status: 'running' | 'done' | 'error'
  startedAt: number          // epoch ms
  endedAt: number | null
  steps: number              // sub-agent tool calls seen so far (activity proxy)
}

export interface Folder {
  id: number
  name: string
  color: string
  sort_order: number
  collapsed: number
  created_at: string
  tasks?: Task[]
}

export interface OrganizeAction {
  type: 'keep' | 'close'
  id: number
  new_title?: string | null
  reason: string
}

export interface OrganizePlan {
  actions: OrganizeAction[]
}

export interface OrganizeStats {
  kept: number
  closed: number
  renamed: number
}


export interface TranscriptProcessResult {
  created: number
  enriched: number
}

// ── Browser Sessions ──

export type BrowserMode = 'local' | 'browserbase'

export interface BrowserSessionStatus {
  taskId: number
  mode: BrowserMode
  url: string
  isClaudeActive: boolean
  claudeStatus: string | null
}

// ── Projects ──

export interface GitProject {
  id: string
  name: string
  path: string
  branch: string
  status: string
  addedAt: string
}

// ── Tools / Integrations ──

export type ToolStatus = 'connected' | 'disconnected' | 'error'
export type ToolConnectionType = 'MCP' | 'REST API' | 'OAuth' | 'Bot API' | 'Local' | 'Native' | 'Embedded' | 'launchd' | 'Webhook'

export interface Tool {
  id: number
  name: string
  description: string
  category: string
  connection_type: ToolConnectionType
  status: ToolStatus
  config: string | null      // JSON blob for tool-specific settings
  icon: string | null         // icon key
  capabilities: string | null // JSON array of strings
  account: string | null
  details: string | null
  is_builtin: number          // 1 = system tool, 0 = user-added
  created_at: string
  updated_at: string
}
