import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import {
  createTask, taskExistsBySource, taskExistsByTitle,
  updateTaskStatusBySource, currentIsoWeek, weekForDate,
  getDb, ACTIVE_STATUSES,
} from './database'
import type { Task } from '../shared/types'

/** Find claude binary — checks common paths then falls back to `which` */
function findClaudeBinary(): string | null {
  const candidates = [
    process.env.CLAUDE_BIN,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.claude', 'local', 'claude'),
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  try {
    const result = execSync('which claude 2>/dev/null', { timeout: 3000 }).toString().trim()
    if (result && fs.existsSync(result)) return result
  } catch { /* ignore */ }
  return null
}

// Read API keys lazily — env vars may be loaded after module import (Dock launch)
function getCrmApiKey(): string { return process.env.CRM_API_KEY || '' }
const CRM_API_BASE = process.env.CRM_API_BASE || ''
const GTASKS_BASE = 'https://tasks.googleapis.com/tasks/v1'

// ═══════════════════════════════════════════
//  CRM SYNC
// ═══════════════════════════════════════════

export async function syncCRM(): Promise<number> {
  if (!getCrmApiKey()) {
    console.log('[sync] CRM_API_KEY not set, skipping CRM sync')
    return 0
  }

  const headers: Record<string, string> = { 'Authorization': `api-key ${getCrmApiKey()}` }
  const week = currentIsoWeek()
  let created = 0

  let data: any
  try {
    const resp = await fetch(
      `${CRM_API_BASE}/objects/task/resources?page[limit]=200`,
      { headers, signal: AbortSignal.timeout(30000) }
    )
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    data = await resp.json()
  } catch (e) {
    console.error('[sync] CRM API error:', e)
    return 0
  }

  const db = getDb()
  try {
    // Build lookup of existing CRM tasks
    const existingCrm = new Map<string, { id: number; status: string }>()
    const existingRows = db.prepare(
      "SELECT id, source_id, status FROM tasks WHERE source = 'crm' AND source_id IS NOT NULL ORDER BY created_at DESC"
    ).all() as { id: number; source_id: string; status: string }[]
    for (const row of existingRows) {
      if (!existingCrm.has(row.source_id)) {
        existingCrm.set(row.source_id, { id: row.id, status: row.status })
      }
    }

    const existingTitles = new Set<string>(
      (db.prepare('SELECT title FROM tasks WHERE week = ?').all(week) as { title: string }[])
        .map(r => r.title)
    )

    const maxOrderRow = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM tasks WHERE week = ?'
    ).get(week) as { max_order: number }
    let maxOrder = maxOrderRow.max_order

    const nameCache = new Map<string, string | null>()
    const createdAt = new Date().toISOString()

    const inserts: any[][] = []
    const statusUpdates: [string, string | null, number][] = []

    for (const record of data.data || []) {
      const attrs = record.attributes || {}
      const crmId = record.id || ''
      const title = attrs.title || 'Untitled'
      const status = attrs.status || 'To Do'

      if (status === 'Canceled') continue

      const rocaStatus = status === 'Done' ? 'done' : 'open'
      const existingTask = existingCrm.get(crmId)
      if (existingTask) {
        if (existingTask.status !== rocaStatus && existingTask.status !== 'carried') {
          const completedAt = attrs._updated_at || new Date().toISOString()
          statusUpdates.push([
            rocaStatus,
            rocaStatus === 'done' ? completedAt : null,
            existingTask.id,
          ])
        }
        continue
      }

      if (existingTitles.has(title)) continue

      const priorityMap: Record<string, string> = { Urgent: 'high', High: 'high', Medium: 'medium', Low: 'low' }
      const priority = priorityMap[attrs.priority || 'Medium'] || 'medium'

      const rels = record.relationships || {}
      const companyName = await resolveName(rels, 'company', headers, nameCache)
      const dealName = await resolveName(rels, 'deal', headers, nameCache)

      maxOrder += 1
      inserts.push([
        title, 'crm', crmId, priority, rocaStatus,
        attrs.due_date || null, companyName, dealName, null,
        week, createdAt,
        rocaStatus === 'done' ? (attrs._updated_at || null) : null,
        maxOrder,
      ])
      existingTitles.add(title)
      created++
    }

    if (inserts.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
           company_name, deal_name, notes, week, created_at, completed_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const transaction = db.transaction(() => {
        for (const row of inserts) stmt.run(...row)
      })
      transaction()
    }
    if (statusUpdates.length > 0) {
      const stmt = db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      const transaction = db.transaction(() => {
        for (const row of statusUpdates) stmt.run(...row)
      })
      transaction()
    }
  } catch (e) {
    console.error('[sync] CRM processing error:', e)
  }

  console.log(`[sync] CRM: synced ${created} new tasks`)
  return created
}

async function resolveName(
  relationships: any, relType: string,
  headers: Record<string, string>,
  cache: Map<string, string | null>
): Promise<string | null> {
  const rel = relationships[relType]
  const relData = rel?.data
  if (!relData) return null
  const recordId = typeof relData === 'object' ? relData.id : null
  if (!recordId) return null

  const cacheKey = `${relType}:${recordId}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  let name: string | null = null
  try {
    const resp = await fetch(`${CRM_API_BASE}/objects/${relType}/records/${recordId}`, {
      headers, signal: AbortSignal.timeout(10000),
    })
    if (resp.ok) {
      const data = await resp.json() as any
      const attrs = data.data?.attributes || {}
      name = attrs.name || attrs.title || null
    }
  } catch { /* ignore */ }
  cache.set(cacheKey, name)
  return name
}

export async function pushTaskToCRM(sourceId: string, rocaStatus: string): Promise<boolean> {
  if (!getCrmApiKey() || !sourceId) return false
  const crmStatus = rocaStatus === 'done' ? 'Done' : 'To Do'
  try {
    const resp = await fetch(`${CRM_API_BASE}/objects/task/records/${sourceId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `api-key ${getCrmApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: { type: 'task', id: sourceId, attributes: { status: crmStatus } },
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    console.log(`[sync] Pushed to CRM: ${sourceId} -> ${crmStatus}`)
    return true
  } catch (e) {
    console.error(`[sync] CRM push error for ${sourceId}:`, e)
    return false
  }
}

// ═══════════════════════════════════════════
//  MEETING NOTES SYNC
// ═══════════════════════════════════════════

export async function syncMeetingNotes(): Promise<number> {
  const token = getMeetingNotesToken()
  if (!token) {
    console.log('[sync] Meeting notes token not found, skipping')
    return 0
  }

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  const week = currentIsoWeek()
  let created = 0

  try {
    // Meeting notes API — configure for your provider
    const resp = await fetch('https://api.granola.ai/v2/get-documents', {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 20, offset: 0 }),
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json() as any
    const docs = Array.isArray(data) ? data : (data.docs || data.documents || data.data || [])

    const db = getDb()

    for (const doc of docs) {
      const docId = doc.id || ''
      const title = doc.title || 'Meeting notes'

      // First try: extract action items from notes (checkbox syntax)
      const actionItems = extractActionItems(doc)

      for (let i = 0; i < actionItems.length; i++) {
        const sourceId = `${docId}_${i}`
        if (taskExistsBySource('meeting_notes', sourceId)) continue
        createTask({
          title: actionItems[i],
          source: 'meeting_notes',
          source_id: sourceId,
          priority: 'medium',
          notes: `From meeting: ${title}`,
          week,
        })
        created++
      }

      // Second try: if no action items found, fetch transcript and process via Claude
      if (actionItems.length === 0 && docId) {
        // Skip if we already processed this doc's transcript (any source)
        const existing = db.prepare(
          "SELECT id FROM tasks WHERE source_id LIKE ?"
        ).get(`transcript_meeting_notes_${docId}_%`) as { id: number } | undefined
        if (existing) continue

        const transcript = await fetchMeetingNotesTranscript(docId, headers)
        if (transcript && transcript.length >= 50) {
          const meetingDate = doc.created_at || ''
          console.log(`[sync] Processing meeting notes transcript: ${title} (${docId.slice(0, 8)}...)`)
          const transcriptCreated = await processTranscript(
            `meeting_notes_${docId}`, title, transcript, meetingDate, 'meeting_notes'
          )
          created += transcriptCreated
        }
      }
    }
  } catch (e) {
    console.error('[sync] Meeting notes error:', e)
  }

  console.log(`[sync] Meeting notes: synced ${created} new tasks`)
  return created
}

async function fetchMeetingNotesTranscript(
  docId: string, headers: Record<string, string>
): Promise<string> {
  try {
    // Meeting notes API — configure for your provider
    const resp = await fetch('https://api.granola.ai/v1/get-document-transcript', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document_id: docId }),
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) return ''
    const chunks = await resp.json() as any[]
    if (!Array.isArray(chunks) || chunks.length === 0) return ''

    // Build readable transcript from chunks
    return chunks
      .map(c => (c.text || '').trim())
      .filter(t => t)
      .join(' ')
  } catch (e) {
    console.error(`[sync] Meeting notes transcript fetch error for ${docId}:`, e)
    return ''
  }
}

function getMeetingNotesToken(): string | null {
  // Reads credentials from locally installed meeting notes app
  const credPath = path.join(os.homedir(), 'Library/Application Support/Granola/supabase.json')
  if (!fs.existsSync(credPath)) return null
  try {
    const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
    if (data.workos_tokens) {
      let tokens = data.workos_tokens
      if (typeof tokens === 'string') {
        try { tokens = JSON.parse(tokens) } catch { return tokens }
      }
      return typeof tokens === 'object' ? (tokens.access_token || tokens.token) : tokens
    }
    if (data.access_token) return data.access_token
    for (const val of Object.values(data)) {
      if (typeof val === 'string' && (val as string).length > 50) return val as string
    }
  } catch (e) {
    console.error('[sync] Error reading meeting notes creds:', e)
  }
  return null
}

function extractActionItems(doc: any): string[] {
  const items: string[] = []

  // Try notes_markdown first (plain text), then last_viewed_panel, then notes (ProseMirror)
  let text = ''
  if (doc.notes_markdown && typeof doc.notes_markdown === 'string') {
    text = doc.notes_markdown
  } else if (doc.last_viewed_panel && typeof doc.last_viewed_panel === 'object') {
    const content = doc.last_viewed_panel.content
    if (typeof content === 'string') text = content
  }
  // Fallback: extract text from ProseMirror notes object
  if (!text && doc.notes && typeof doc.notes === 'object') {
    text = extractProseMirrorText(doc.notes)
  }

  if (text) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('- [ ]') || trimmed.startsWith('* [ ]')) {
        items.push(trimmed.replace(/^[-*]\s*\[\s*\]\s*/, '').trim())
      } else if (trimmed.toLowerCase().startsWith('action:') || trimmed.toLowerCase().startsWith('todo:')) {
        items.push(trimmed.split(':').slice(1).join(':').trim())
      }
    }
  }
  return items
}

function extractProseMirrorText(node: any): string {
  if (!node) return ''
  let text = ''
  if (node.text) text += node.text
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const childText = extractProseMirrorText(child)
      if (childText) text += childText
    }
    // Add newline after block nodes
    if (['paragraph', 'heading', 'listItem', 'taskItem', 'bulletList', 'orderedList', 'taskList'].includes(node.type)) {
      text += '\n'
    }
  }
  return text
}

// ═══════════════════════════════════════════
//  GOOGLE TASKS SYNC
// ═══════════════════════════════════════════

async function getGoogleTasksTokenAsync(): Promise<string | null> {
  const tokenPath = process.env.GOOGLE_TOKEN_PATH ||
    path.join(app.getPath('userData'), 'google-token.json')
  if (!fs.existsSync(tokenPath)) {
    console.log('[sync] Google Tasks token.json not found')
    return null
  }

  try {
    const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))

    // Check if expired and refresh
    if (data.expiry && new Date(data.expiry) < new Date()) {
      if (!data.refresh_token || !data.client_id || !data.client_secret) {
        console.log('[sync] Google token expired, cannot refresh')
        return null
      }

      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: data.client_id,
            client_secret: data.client_secret,
            refresh_token: data.refresh_token,
            grant_type: 'refresh_token',
          }).toString(),
          signal: AbortSignal.timeout(15000),
        })
        if (!resp.ok) throw new Error(`Refresh failed: HTTP ${resp.status}`)
        const refreshed = await resp.json() as any

        // Update token file
        data.token = refreshed.access_token
        if (refreshed.expiry_date) {
          data.expiry = new Date(refreshed.expiry_date).toISOString()
        } else if (refreshed.expires_in) {
          data.expiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        }
        fs.writeFileSync(tokenPath, JSON.stringify(data, null, 2))
        return data.token
      } catch (e) {
        console.error('[sync] Google token refresh error:', e)
        return null
      }
    }

    // Check scopes include tasks
    const scopes: string[] = data.scopes || []
    if (scopes.length > 0 && !scopes.includes('https://www.googleapis.com/auth/tasks')) {
      console.log('[sync] Google token missing tasks scope')
      return null
    }

    return data.token || null
  } catch (e) {
    console.error('[sync] Google Tasks auth error:', e)
    return null
  }
}

export async function syncGoogleTasks(): Promise<number> {
  const token = await getGoogleTasksTokenAsync()
  if (!token) {
    console.log('[sync] Google Tasks token unavailable, skipping')
    return 0
  }

  const headers = { 'Authorization': `Bearer ${token}` }
  let created = 0
  const week = currentIsoWeek()

  // 1. Get all task lists
  let taskLists: any[]
  try {
    const resp = await fetch(`${GTASKS_BASE}/users/@me/lists`, {
      headers, signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json() as any
    taskLists = data.items || []
  } catch (e) {
    console.error('[sync] Google Tasks lists error:', e)
    return 0
  }

  // 2. For each list, get tasks
  for (const tlist of taskLists) {
    const listId = tlist.id
    const listTitle = tlist.title || 'Tasks'

    let tasks: any[]
    try {
      const resp = await fetch(
        `${GTASKS_BASE}/lists/${listId}/tasks?maxResults=100&showCompleted=true&showHidden=true`,
        { headers, signal: AbortSignal.timeout(15000) }
      )
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json() as any
      tasks = data.items || []
    } catch (e) {
      console.error(`[sync] Google Tasks fetch error for list '${listTitle}':`, e)
      continue
    }

    for (const gtask of tasks) {
      const taskId = gtask.id || ''
      const title = (gtask.title || '').trim()
      if (!title) continue

      const sourceId = `${listId}:${taskId}`
      const gStatus = gtask.status || 'needsAction'
      const due = gtask.due || null
      const notes = gtask.notes || ''

      // Already synced? Update status if changed
      if (taskExistsBySource('google_tasks', sourceId)) {
        const rocaStatus = gStatus === 'completed' ? 'done' : 'open'
        updateTaskStatusBySource('google_tasks', sourceId, rocaStatus)
        continue
      }

      const rocaStatus = gStatus === 'completed' ? 'done' : 'open'
      const dueDate = due ? due.slice(0, 10) : null
      const taskWeek = dueDate ? weekForDate(dueDate) : week

      // Skip if title already exists in target week
      if (taskExistsByTitle(title, taskWeek)) continue

      let taskNotes = ''
      if (listTitle !== 'My Tasks') taskNotes = `List: ${listTitle}`
      if (notes) taskNotes = taskNotes ? `${taskNotes}\n${notes}` : notes

      createTask({
        title,
        source: 'google_tasks',
        source_id: sourceId,
        priority: 'medium',
        due_date: dueDate,
        notes: taskNotes || null,
        week: taskWeek,
      })

      if (rocaStatus === 'done') {
        const completedAt = gtask.completed || new Date().toISOString()
        const db = getDb()
        db.prepare(
          "UPDATE tasks SET status = 'done', completed_at = ? WHERE source = 'google_tasks' AND source_id = ?"
        ).run(completedAt, sourceId)
      }

      created++
    }
  }

  console.log(`[sync] Google Tasks: synced ${created} new tasks`)
  return created
}

export async function pushTaskToGoogleTasks(sourceId: string, rocaStatus: string): Promise<boolean> {
  const token = await getGoogleTasksTokenAsync()
  if (!token || !sourceId || !sourceId.includes(':')) return false

  const [listId, taskId] = sourceId.split(':', 2)
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const body = rocaStatus === 'done'
    ? { status: 'completed', completed: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z') }
    : { status: 'needsAction', completed: null }

  try {
    const resp = await fetch(`${GTASKS_BASE}/lists/${listId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const statusLabel = rocaStatus === 'done' ? 'completed' : 'needsAction'
    console.log(`[sync] Pushed to Google Tasks: ${taskId} -> ${statusLabel}`)
    return true
  } catch (e) {
    console.error(`[sync] Google Tasks push error for ${taskId}:`, e)
    return false
  }
}

// ═══════════════════════════════════════════
//  VOICE NOTES SYNC
// ═══════════════════════════════════════════

export function syncVoiceNotes(customStagingPath?: string): number {
  // Voice notes staging file — prefer explicit path, then env var, then ROCA's userData dir
  const stagingPath = customStagingPath || process.env.VOICE_NOTES_STAGING_PATH ||
    path.join(os.homedir(), 'Library/Application Support/ROCA/voice-notes-staging.json')
  if (!fs.existsSync(stagingPath)) {
    console.log('[sync] Voice notes staging file not found, skipping')
    return 0
  }

  let data: any
  try {
    data = JSON.parse(fs.readFileSync(stagingPath, 'utf-8'))
  } catch (e) {
    console.error('[sync] Voice notes staging read error:', e)
    return 0
  }

  let created = 0
  let skippedAssignee = 0
  let skippedExisting = 0
  const week = currentIsoWeek()
  const meetings = data.meetings || {}

  for (const meetingId of Object.keys(meetings)) {
    const meeting = meetings[meetingId]
    const meetingName = meeting.meeting_name || 'Voice note meeting'
    const meetingDate = meeting.meeting_date || ''
    const items = meeting.action_items || []

    if (items.length === 0) continue

    // Format date label
    let dateLabel = ''
    if (meetingDate) {
      try {
        const dt = new Date(meetingDate)
        if (!isNaN(dt.getTime())) {
          dateLabel = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        }
      } catch { /* ignore */ }
    }

    for (const item of items) {
      const itemId = item.id || `${meetingId}_${(item.title || '').slice(0, 30)}`
      const assignee: string = item.assignee || ''
      let title: string = item.title || ''

      // Skip completed items
      if (item.completed) continue

      // Skip items assigned to others (not the user)
      const assigneeLower = assignee.toLowerCase()
      if (assigneeLower && !assigneeLower.includes('speaker')) {
        skippedAssignee++
        continue
      }

      // Already synced
      if (taskExistsBySource('voice_notes', itemId)) {
        skippedExisting++
        continue
      }

      // Clean up title: remove "Speaker to " prefix
      for (const prefix of ['Speaker_1 to ']) {
        if (title.startsWith(prefix)) {
          title = title.slice(prefix.length)
          title = title.charAt(0).toUpperCase() + title.slice(1)
          break
        }
      }

      // Skip if task with same title exists this week
      if (taskExistsByTitle(title, week)) {
        skippedExisting++
        continue
      }

      let note = `From: ${meetingName}`
      if (dateLabel) note += ` (${dateLabel})`

      createTask({
        title,
        source: 'voice_notes',
        source_id: itemId,
        priority: 'medium',
        notes: note,
        week,
      })
      created++
    }
  }

  console.log(`[sync] Voice notes: created ${created} tasks, skipped ${skippedAssignee} (other assignee), ${skippedExisting} (already exist)`)
  return created
}

// ═══════════════════════════════════════════
//  VOICE NOTES WEBHOOK LOG — catch up on transcripts
// ═══════════════════════════════════════════

export async function processVoiceNoteTranscripts(): Promise<number> {
  // Read the webhook log and process any unprocessed transcript events
  const logPath = process.env.VOICE_NOTES_WEBHOOK_LOG ||
    path.join(app.getPath('userData'), 'voice-notes-webhook-log.jsonl')
  if (!fs.existsSync(logPath)) return 0

  let lines: string[]
  try {
    lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim())
  } catch (e) {
    console.error('[sync] Error reading voice notes webhook log:', e)
    return 0
  }

  const db = getDb()
  let processed = 0

  for (const line of lines) {
    let event: any
    try { event = JSON.parse(line) } catch { continue }

    const payload = event.payload || {}
    if (payload.event !== 'transcript_created') continue

    const data = payload.data || {}
    const meeting = data.meeting || {}
    const meetingId = meeting.id || payload.id || ''
    if (!meetingId) continue

    // Skip if already processed — check for tasks with this meeting ID (any source)
    const existing = db.prepare(
      "SELECT id FROM tasks WHERE source_id LIKE ?"
    ).get(`transcript_${meetingId}_%`) as { id: number } | undefined
    if (existing) continue

    const meetingName = meeting.title || 'Voice note meeting'
    const meetingDate = meeting.start_date || ''

    // Build transcript text from content array or raw_content
    let transcript = ''
    if (data.raw_content && typeof data.raw_content === 'string') {
      transcript = data.raw_content
    } else if (Array.isArray(data.content)) {
      transcript = data.content
        .map((c: any) => `${c.speaker || 'Speaker'}: ${c.text || ''}`)
        .join('\n')
    }

    if (!transcript || transcript.trim().length < 50) continue

    console.log(`[sync] Processing voice note transcript: ${meetingName} (${meetingId.slice(0, 8)}...)`)
    const count = await processTranscript(meetingId, meetingName, transcript, meetingDate, 'voice_notes')
    processed += count
  }

  if (processed > 0) {
    console.log(`[sync] Voice notes webhook log: created ${processed} tasks from transcripts`)
  }
  return processed
}

// ═══════════════════════════════════════════
//  TRANSCRIPT PROCESSING
// ═══════════════════════════════════════════

export async function processTranscript(
  meetingId: string, meetingName: string,
  transcriptText: string, meetingDate = '',
  sourceOverride?: string
): Promise<number> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  if (!transcriptText || transcriptText.trim().length < 50) {
    console.log(`[transcript] Skipping '${meetingName}' -- transcript too short`)
    return 0
  }

  const week = currentIsoWeek()
  const db = getDb()
  const existing = db.prepare(
    "SELECT id, title, notes, source, source_id FROM tasks WHERE week = ? AND status = 'open'"
  ).all(week) as Task[]

  const existingSummary = existing.length > 0
    ? existing.map(t => `  #${t.id} [${t.source}] ${t.title}`).join('\n')
    : '  (no existing tasks)'

  let dateLabel = ''
  if (meetingDate) {
    try {
      const dt = new Date(meetingDate)
      if (!isNaN(dt.getTime())) {
        dateLabel = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      }
    } catch { /* ignore */ }
  }

  const transcriptTruncated = transcriptText.slice(0, 50000)

  const prompt = `You are a meeting assistant. Your job is to extract action items from meeting transcripts.

MEETING: ${meetingName} (${dateLabel || meetingDate || 'recent'})

TRANSCRIPT:
${transcriptTruncated}

EXISTING ROCA TASKS THIS WEEK:
${existingSummary}

YOUR JOB: Extract the KEY action items for the user from this transcript. Be selective -- only real tasks, not observations.

1. **Explicit commitments** -- "I'll send you X", "Let me follow up on Y"
2. **Clear follow-ups** -- intros to make, documents to send, meetings to schedule
3. **CRM updates** -- consolidate ALL CRM updates for the same company into ONE task (list all fields in the notes)
4. **Meeting scheduling** -- only if a specific next meeting was discussed

OUTPUT FORMAT -- respond with ONLY a JSON object:
{
  "tasks": [
    {
      "title": "concise action item title",
      "priority": "high|medium|low",
      "notes": "context from transcript -- who said what, why it matters",
      "company_name": "company name if identifiable, null otherwise",
      "enriches_task_id": null
    }
  ],
  "enrichments": [
    {
      "task_id": 123,
      "additional_context": "new info from transcript that enriches this existing task"
    }
  ]
}

RULES:
1. Create NEW tasks only -- don't duplicate existing ones. If an existing task covers the same intent, put it in enrichments instead.
2. Title should be actionable ("Send NDA to Acme", "Research competitor pricing") not descriptive ("Discussion about pricing")
3. Skip items assigned to others unless the user needs to follow up
4. Priority: high = time-sensitive or deal-critical, medium = important follow-up, low = nice-to-have
5. Keep it tight -- aim for 3-5 tasks per meeting. Consolidate related items (e.g. all CRM updates for one company = one task).
6. Do NOT create "Update CRM" tasks for minor details -- only for significant changes (stage, tier, key metrics).
7. Output ONLY valid JSON, no markdown fences, no explanation.`

  let plan: any
  try {
    const env: Record<string, string> = { ...process.env as Record<string, string>, CLAUDECODE: '' }
    env.PATH = `/usr/local/bin:${env.PATH || '/usr/bin:/bin'}`
    const claudeBin = findClaudeBinary()
    if (!claudeBin) {
      console.error('[transcript] Claude CLI not found in PATH')
      return 0
    }

    const { stdout } = await execFileAsync(claudeBin, ['--print', '-p', prompt], {
      timeout: 180000,
      env,
    })

    let output = stdout.trim()
    // Strip markdown fences if present
    if (output.startsWith('```')) {
      output = output.includes('\n') ? output.split('\n').slice(1).join('\n') : output
      if (output.endsWith('```')) output = output.slice(0, -3)
      output = output.trim()
    }

    plan = JSON.parse(output)
  } catch (e: any) {
    if (e.killed) {
      console.error('[transcript] Claude CLI timed out')
    } else if (e instanceof SyntaxError) {
      console.error('[transcript] Failed to parse Claude response:', e.message)
    } else {
      console.error('[transcript] Error:', e.message || e)
    }
    return 0
  }

  let created = 0
  let enriched = 0

  // Create new tasks
  for (const taskData of plan.tasks || []) {
    const title = (taskData.title || '').trim()
    if (!title) continue

    if (taskExistsByTitle(title, week)) continue

    const note = taskData.notes || ''
    let notePrefix = `[Transcript] ${meetingName}`
    if (dateLabel) notePrefix += ` (${dateLabel})`
    const fullNote = note ? `${notePrefix}\n${note}` : notePrefix

    const sourceId = `transcript_${meetingId}_${created}`
    createTask({
      title,
      source: sourceOverride || 'transcript',
      source_id: sourceId,
      priority: taskData.priority || 'medium',
      notes: fullNote,
      company_name: taskData.company_name || null,
      week,
    })
    created++
  }

  // Enrich existing tasks
  for (const enrichment of plan.enrichments || []) {
    const taskId = enrichment.task_id
    const context = (enrichment.additional_context || '').trim()
    if (!taskId || !context) continue

    const task = db.prepare('SELECT id, notes FROM tasks WHERE id = ?').get(taskId) as { id: number; notes: string | null } | undefined
    if (task) {
      const oldNotes = task.notes || ''
      const newNotes = `${oldNotes}\n[Transcript -- ${meetingName}] ${context}`
      db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(newNotes, taskId)
      enriched++
    }
  }

  console.log(`[transcript] '${meetingName}': created ${created} tasks, enriched ${enriched} existing`)
  return created
}

// ═══════════════════════════════════════════
//  RECONCILE + SYNC ALL
// ═══════════════════════════════════════════

export async function reconcileAll(): Promise<number> {
  let pushed = 0

  // --- CRM reconcile ---
  if (getCrmApiKey()) {
    const db = getDb()
    const tasks = db.prepare(
      "SELECT source_id, status FROM tasks WHERE source = 'crm' AND status IN ('open', 'done')"
    ).all() as { source_id: string; status: string }[]

    const headers = { 'Authorization': `api-key ${getCrmApiKey()}` }

    for (const task of tasks) {
      const sourceId = task.source_id
      const rocaStatus = task.status
      try {
        const url = `${CRM_API_BASE}/objects/task/records/${sourceId}`
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
        if (!resp.ok) continue
        const data = await resp.json() as any
        const crmStatus = data.data?.attributes?.status || ''
        const crmIsDone = crmStatus === 'Done'
        const rocaIsDone = rocaStatus === 'done'
        if (rocaIsDone !== crmIsDone) {
          if (await pushTaskToCRM(sourceId, rocaStatus)) pushed++
        }
      } catch { continue }
    }
    console.log(`[reconcile] Pushed ${pushed} CRM status updates`)
  }

  // --- Google Tasks reconcile ---
  let gtPushed = 0
  const gtToken = await getGoogleTasksTokenAsync()
  if (gtToken) {
    const db = getDb()
    const tasks = db.prepare(
      "SELECT source_id, status FROM tasks WHERE source = 'google_tasks' AND status IN ('open', 'done')"
    ).all() as { source_id: string; status: string }[]

    const headers = { 'Authorization': `Bearer ${gtToken}` }

    for (const task of tasks) {
      const sourceId = task.source_id
      const rocaStatus = task.status
      if (!sourceId.includes(':')) continue
      const [listId, taskId] = sourceId.split(':', 2)

      try {
        const resp = await fetch(
          `${GTASKS_BASE}/lists/${listId}/tasks/${taskId}`,
          { headers, signal: AbortSignal.timeout(10000) }
        )
        if (!resp.ok) continue
        const data = await resp.json() as any
        const gStatus = data.status || ''
        const gIsDone = gStatus === 'completed'
        const rocaIsDone = rocaStatus === 'done'
        if (rocaIsDone !== gIsDone) {
          if (await pushTaskToGoogleTasks(sourceId, rocaStatus)) gtPushed++
        }
      } catch { continue }
    }
    console.log(`[reconcile] Pushed ${gtPushed} Google Tasks status updates`)
  }

  // Pull fresh
  const newCount = await syncAll()
  return pushed + gtPushed + newCount
}

export async function syncAll(): Promise<number> {
  const crmCount = await syncCRM()
  const meetingNotesCount = await syncMeetingNotes()
  const gtasksCount = await syncGoogleTasks()
  const voiceNotesCount = syncVoiceNotes()
  const voiceNoteTranscriptCount = await processVoiceNoteTranscripts()
  return crmCount + meetingNotesCount + gtasksCount + voiceNotesCount + voiceNoteTranscriptCount
}
