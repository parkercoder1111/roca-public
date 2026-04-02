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
  // UI-computed flags
  is_recurring?: boolean
  has_cache?: boolean
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
