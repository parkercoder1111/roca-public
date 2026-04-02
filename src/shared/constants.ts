import type { TaskStatus } from './types'

export const ASSISTANT_TASK_ID = -1

export const ACTIVE_STATUSES: TaskStatus[] = [
  'needs_input',
  'draft_ready',
  'open',
  'waiting',
  'blocked',
  'in_progress',
  'carried',
]

export const STATUS_LABELS: Record<string, string> = {
  needs_input: 'Needs Input',
  draft_ready: 'Draft Ready',
  open: 'Open',
  waiting: 'Waiting',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  done: 'Done',
  carried: 'Carried',
}

export const PRIORITY_CYCLE: Record<string, string> = {
  low: 'medium',
  medium: 'high',
  high: 'urgent',
  urgent: 'low',
}

export const FOLDER_COLORS = [
  '#BF5AF2', '#0A84FF', '#30D158', '#FF9F0A', '#FF453A',
  '#FF6482', '#FFD60A', '#64D2FF', '#AC8E68',
]

export const INBOX_SOURCES = new Set(['clarify', 'google_tasks', 'krisp', 'transcript', 'granola'])

export const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic',
  '.pdf', '.csv', '.txt', '.md', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx',
  '.json', '.js', '.ts', '.py', '.sh', '.log',
])

export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 // 10 MB
