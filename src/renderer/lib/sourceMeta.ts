// Shared source metadata — single source of truth for source colors and labels.
// Import from here instead of defining per-component to prevent silent divergence
// when new integration sources are added.

export const SOURCE_COLORS: Record<string, string> = {
  crm: 'bg-blue-2 text-blue-1',
  recurring: 'bg-amber-400/10 text-amber-400',
  meeting_notes: 'bg-purple-2 text-purple-1',
  google_tasks: 'bg-black/[0.04] text-text-3',
  voice_notes: 'bg-emerald-400/10 text-emerald-400',
  transcript: 'bg-teal-400/10 text-teal-400',
  organized: 'bg-purple-2 text-purple-1',
  manual: 'bg-black/[0.04] text-text-3',
}

// Abbreviated labels for compact badge usage (TaskRow)
// manual is intentionally empty — no badge for the default creation path (reduces noise)
export const SOURCE_LABELS: Record<string, string> = {
  crm: 'CRM',
  recurring: 'Rec',
  meeting_notes: 'MN',
  google_tasks: 'GTK',
  voice_notes: 'VN',
  transcript: 'Xscr',
  organized: 'Org',
  manual: '',
}

// Full human-readable labels (TaskDetail, TaskTerminal)
export const SOURCE_LABELS_FULL: Record<string, string> = {
  crm: 'CRM',
  recurring: 'Recurring',
  meeting_notes: 'Meeting Notes',
  google_tasks: 'Google Tasks',
  voice_notes: 'Voice Notes',
  transcript: 'Transcript',
  organized: 'Organized',
  manual: 'Manual',
}
