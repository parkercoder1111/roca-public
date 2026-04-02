/**
 * Smart delegation engine — spawns Claude headless sessions (Slack Bot pattern)
 * that pull full Clarify context, analyze tasks, and return concrete
 * execution plans with actual generated output.
 *
 * Ported from roca/delegate.py for the Electron app.
 *
 * Flow:
 * 1. Enrich: Fetch task + company + person + deal + meetings from Clarify REST API
 * 2. Build prompt: Assemble rich context + roca-prompt.md + journal.md + skills + playbooks
 * 3. Run Claude: Spawn `claude -p` headless (same as Slack Bot workflow)
 * 4. Return: Structured plan + actual artifacts (email drafts, SQL, memos, etc.)
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import crypto from 'crypto'
import {
  runClaudeHeadless,
  CLAUDE_MODEL,
  CLAUDE_MAX_TURNS_ANALYSIS,
  CLAUDE_MAX_TURNS_EXECUTE,
  CLAUDE_TIMEOUT_ANALYSIS,
  CLAUDE_TIMEOUT_EXECUTE,
} from './toolExecutor'
import type { ClaudeRunResult } from './toolExecutor'

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════

const CLARIFY_API_KEY = process.env.CLARIFY_API_KEY || ''
const CLARIFY_BASE = process.env.CLARIFY_API_BASE || ''
const CLARIFY_HEADERS: Record<string, string> = CLARIFY_API_KEY
  ? { Authorization: `api-key ${CLARIFY_API_KEY}` }
  : {}

// ═══════════════════════════════════════════
//  CACHES
// ═══════════════════════════════════════════

/** In-memory session ID cache (taskId -> sessionId) */
const taskSessions = new Map<number, string>()

/** Claude binary path cache */
let claudeBinaryCache: string | null = null

/** Mtime-based file cache for prompt source files */
const textFileCache = new Map<string, { mtime: number; text: string }>()

/** Taxonomy cache (parsed from journal.md) */
const taxonomyCache: {
  mtime: number
  keys: string[]
  triggers: Record<string, string[]>
} = { mtime: 0, keys: [], triggers: {} }

/** Playbook section cache */
const playbookCache: {
  maxMtime: number
  sections: Record<string, string>
} = { maxMtime: 0, sections: {} }

// ═══════════════════════════════════════════
//  PATH HELPERS
// ═══════════════════════════════════════════

function getRocaDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'roca')
    : path.join(__dirname, '../../roca')
}

function getProjectRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath)
    : path.join(__dirname, '../..')
}

function getUploadDir(): string {
  return path.join(app.getPath('userData'), 'uploads')
}

// ═══════════════════════════════════════════
//  FILE HELPERS
// ═══════════════════════════════════════════

/** Read a text file with mtime-based caching. Returns empty string if missing. */
function readCachedText(filePath: string): string {
  if (!fs.existsSync(filePath)) return ''

  const mtime = fs.statSync(filePath).mtimeMs
  const cached = textFileCache.get(filePath)
  if (cached && cached.mtime === mtime) return cached.text

  const text = fs.readFileSync(filePath, 'utf-8')
  textFileCache.set(filePath, { mtime, text })
  return text
}

/** Read a file from the roca/ directory. Returns empty string if missing. */
function readRocaFile(filename: string): string {
  return readCachedText(path.join(getRocaDir(), filename))
}

// ═══════════════════════════════════════════
//  CLAUDE BINARY FINDER
// ═══════════════════════════════════════════

/** Find the Claude Code CLI binary. Cached after first lookup. */
function findClaudeBinary(): string | null {
  if (claudeBinaryCache && fs.existsSync(claudeBinaryCache)) {
    return claudeBinaryCache
  }

  // Check well-known paths first
  for (const candidate of ['/usr/local/bin/claude', '/opt/homebrew/bin/claude']) {
    if (fs.existsSync(candidate)) {
      claudeBinaryCache = candidate
      return candidate
    }
  }

  // Check PATH via which
  try {
    const result = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim()
    if (result && fs.existsSync(result)) {
      claudeBinaryCache = result
      return result
    }
  } catch { /* not found via which */ }

  // Fallback: Application Support (desktop app installs)
  const appSupportDir = path.join(
    os.homedir(),
    'Library/Application Support/Claude/claude-code'
  )
  if (fs.existsSync(appSupportDir)) {
    try {
      const findBinary = (dir: string): string[] => {
        const results: string[] = []
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            results.push(...findBinary(full))
          } else if (entry.name === 'claude') {
            try {
              const stat = fs.statSync(full)
              if (stat.mode & 0o111) results.push(full)
            } catch { /* skip */ }
          }
        }
        return results
      }
      const binaries = findBinary(appSupportDir).sort()
      if (binaries.length > 0) {
        claudeBinaryCache = binaries[binaries.length - 1]
        return claudeBinaryCache
      }
    } catch { /* skip */ }
  }

  return null
}

// ═══════════════════════════════════════════
//  IMAGE REF REWRITING
// ═══════════════════════════════════════════

/**
 * Convert markdown image refs from /uploads/X to absolute paths for Claude Read tool.
 * Adds instruction for Claude to read the images.
 */
function rewriteImageRefs(text: string): string {
  const imagePattern = /!\[([^\]]*)\]\(\/uploads\/([^)]+)\)/g
  const images: Array<{ alt: string; filename: string }> = []

  let match: RegExpExecArray | null
  while ((match = imagePattern.exec(text)) !== null) {
    images.push({ alt: match[1], filename: match[2] })
  }
  if (images.length === 0) return text

  const uploadDir = getUploadDir()
  let rewritten = text.replace(
    /!\[([^\]]*)\]\(\/uploads\/([^)]+)\)/g,
    (_, alt: string, fname: string) => `![${alt}](${path.join(uploadDir, fname)})`
  )

  const imagePaths = images.map(img => path.join(uploadDir, img.filename))
  rewritten += `\n\n**IMPORTANT: The user attached screenshot(s). Use the Read tool to view: ${imagePaths.join(', ')}**`
  return rewritten
}

// ═══════════════════════════════════════════
//  TAXONOMY & PLAYBOOK (dynamic classification)
// ═══════════════════════════════════════════

/**
 * Parse journal.md taxonomy into keys + trigger map. Cached by mtime.
 * Returns [allKeys, keyTriggers].
 */
function loadTaxonomy(): [string[], Record<string, string[]>] {
  const journalPath = path.join(getRocaDir(), 'journal.md')
  if (!fs.existsSync(journalPath)) return [[], {}]

  const mtime = fs.statSync(journalPath).mtimeMs
  if (mtime === taxonomyCache.mtime) {
    return [taxonomyCache.keys, taxonomyCache.triggers]
  }

  const journalText = readCachedText(journalPath)
  const allKeys: string[] = []
  const keyRegex = /###\s+`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = keyRegex.exec(journalText)) !== null) {
    allKeys.push(m[1])
  }

  const keyTriggers: Record<string, string[]> = {}
  let currentKey: string | null = null

  for (const line of journalText.split('\n')) {
    const keyMatch = line.match(/^###\s+`([^`]+)`/)
    if (keyMatch) {
      currentKey = keyMatch[1]
      keyTriggers[currentKey] = []
    } else if (currentKey && line.trim().startsWith('**Triggers**:')) {
      const triggersText = line.split('**Triggers**:', 2)[1].trim().toLowerCase()
      const quoted = [...triggersText.matchAll(/"([^"]+)"/g)].map(q => q[1])
      const commaWords = triggersText
        .split(',')
        .map(w => w.trim().replace(/^["']|["']$/g, ''))
        .filter(w => w.length > 3)
      keyTriggers[currentKey] = [...quoted, ...commaWords]
    }
  }

  taxonomyCache.mtime = mtime
  taxonomyCache.keys = allKeys
  taxonomyCache.triggers = keyTriggers
  return [allKeys, keyTriggers]
}

/** Load per-key playbook files from playbooks/ directory. Cached by max mtime. */
function loadPlaybookSections(): Record<string, string> {
  const playbooksDir = path.join(getRocaDir(), 'playbooks')
  if (!fs.existsSync(playbooksDir)) return {}

  const files = fs.readdirSync(playbooksDir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(playbooksDir, f))

  if (files.length === 0) return {}

  const maxMtime = Math.max(...files.map(f => fs.statSync(f).mtimeMs))
  if (maxMtime === playbookCache.maxMtime) return playbookCache.sections

  const sections: Record<string, string> = {}
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, 'utf-8').trim()
    const keyMatch = text.match(/#\s+`([^`]+)`/)
    if (keyMatch) {
      sections[keyMatch[1]] = text
    } else {
      // Fallback: derive key from filename (email-founder-followup-fit.md -> email:founder-followup-fit)
      const stem = path.basename(filePath, '.md')
      const parts = stem.split('-')
      const key = parts.length > 1
        ? `${parts[0]}:${parts.slice(1).join('-')}`
        : stem
      sections[key] = text
    }
  }

  playbookCache.maxMtime = maxMtime
  playbookCache.sections = sections
  return sections
}

/** Convert a playbook key like 'email:founder-followup-fit' to filename. */
function keyToFilename(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9:_-]/g, '')
  return safe.replace(/:/g, '-') + '.md'
}

/** Write content to a per-key playbook file, merging with existing. */
function writePlaybookFile(key: string, content: string, label = 'learn'): void {
  try {
    const playbooksDir = path.join(getRocaDir(), 'playbooks')
    if (!fs.existsSync(playbooksDir)) fs.mkdirSync(playbooksDir, { recursive: true })

    const playbookFile = path.join(playbooksDir, keyToFilename(key))
    const existing = fs.existsSync(playbookFile)
      ? fs.readFileSync(playbookFile, 'utf-8').trim()
      : ''

    if (existing && !content.includes(`# \`${key}\``)) {
      // LLM returned a fragment — append to existing
      fs.writeFileSync(playbookFile, existing + '\n\n' + content.trim() + '\n')
    } else {
      fs.writeFileSync(playbookFile, content.trim() + '\n')
    }

    playbookCache.maxMtime = 0 // Invalidate cache
    console.log(`[${label}] Playbook updated: ${path.basename(playbookFile)} (${content.length} chars)`)
  } catch (e) {
    console.error(`[${label}] Failed to update playbook:`, e)
  }
}

/**
 * Classify a task against journal patterns and pull matching playbook entries.
 * Returns [matchedKeys, relevantPlaybookText].
 */
function classifyAndPullPlaybook(
  taskTitle: string,
  taskNotes = ''
): [string[], string] {
  const [allKeys, keyTriggers] = loadTaxonomy()
  const playbookSections = loadPlaybookSections()

  if (allKeys.length === 0) return [[], '']

  const taskText = `${taskTitle} ${taskNotes}`.toLowerCase()
  let matchedKeys: string[] = []

  // Match triggers from journal taxonomy
  for (const [key, triggers] of Object.entries(keyTriggers)) {
    for (const trigger of triggers) {
      if (trigger && taskText.includes(trigger)) {
        matchedKeys.push(key)
        break
      }
    }
  }

  // Fallback: derive categories from allKeys dynamically
  if (matchedKeys.length === 0) {
    const categories = new Set(
      allKeys.filter(k => k.includes(':')).map(k => k.split(':')[0])
    )
    for (const cat of categories) {
      if (taskText.includes(cat)) {
        matchedKeys = allKeys.filter(k => k.startsWith(`${cat}:`))
        break
      }
    }
  }

  if (matchedKeys.length === 0) return [[], '']

  // Pull matching sections
  const relevantSections = matchedKeys
    .filter(k => k in playbookSections)
    .map(k => playbookSections[k])

  // Always include preferences
  if (
    !matchedKeys.includes('util:roca-preferences') &&
    'util:roca-preferences' in playbookSections
  ) {
    relevantSections.push(playbookSections['util:roca-preferences'])
  }

  if (relevantSections.length > 0) {
    return [matchedKeys, relevantSections.join('\n\n---\n\n')]
  }
  return [matchedKeys, '']
}

// ═══════════════════════════════════════════
//  CLARIFY API HELPERS
// ═══════════════════════════════════════════

/** GET from Clarify API, return data dict or null. */
async function apiGet(urlPath: string): Promise<any | null> {
  if (!CLARIFY_API_KEY) return null
  try {
    const resp = await fetch(`${CLARIFY_BASE}/${urlPath}`, {
      headers: CLARIFY_HEADERS,
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return null
    const json = await resp.json() as any
    return json.data ?? {}
  } catch (e) {
    console.error(`[delegate] API error ${urlPath}:`, e)
    return null
  }
}

/** Fetch a related entity from task relationships. */
async function fetchRelated(
  relationships: any,
  entityType: string
): Promise<any | null> {
  const rel = relationships?.[entityType] ?? {}
  const relData = rel.data
  if (!relData) return null

  const recordId = typeof relData === 'object' ? relData.id : null
  if (!recordId) return null

  const data = await apiGet(`objects/${entityType}/records/${recordId}`)
  if (data) {
    const attrs = data.attributes ?? {}
    attrs._id = data.id
    attrs._relationships = data.relationships ?? {}
    return attrs
  }
  return null
}

/** Fetch recent meetings for a person by participant email. */
async function fetchMeetingsByEmail(
  emails: string[]
): Promise<Array<{ subject: string; start: string; ai_summary: string; notes: string }>> {
  if (!emails.length || !CLARIFY_API_KEY) return []

  const meetings: Array<{ subject: string; start: string; ai_summary: string; notes: string }> = []
  const seenIds = new Set<string>()

  for (const email of emails.slice(0, 2)) {
    try {
      const encodedEmail = encodeURIComponent(email)
      const url = `${CLARIFY_BASE}/objects/meeting/resources`
        + `?filter%5Bparticipants%5D%5BContains%5D=${encodedEmail}`
        + `&page%5Blimit%5D=5`

      const resp = await fetch(url, {
        headers: CLARIFY_HEADERS,
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        console.log(`[delegate] Meeting search failed for ${email}: ${resp.status}`)
        continue
      }

      const json = await resp.json() as any
      for (const r of json.data ?? []) {
        const mid = r.id
        if (seenIds.has(mid)) continue
        seenIds.add(mid)

        const attrs = r.attributes ?? {}
        meetings.push({
          subject: attrs.title ?? 'No subject',
          start: attrs.start ?? '',
          ai_summary: extractDescription(attrs.summary),
          notes: extractDescription(attrs.notes),
        })
      }
    } catch (e) {
      console.error(`[delegate] Meeting fetch error for ${email}:`, e)
    }
  }

  meetings.sort((a, b) => (b.start || '').localeCompare(a.start || ''))
  return meetings.slice(0, 3)
}

/** Fetch meeting transcripts via Clarify REST API. */
async function fetchClarifyMeetingTranscripts(
  meetings: Array<{ subject: string; start: string; ai_summary: string; notes: string }>,
  maxTranscripts = 2
): Promise<Array<{ meeting_subject: string; transcript_text: string }>> {
  if (!meetings.length || !CLARIFY_API_KEY) return []

  const transcripts: Array<{ meeting_subject: string; transcript_text: string }> = []

  // We need the raw meeting data with _id; re-fetch if needed
  // For simplicity, we work with what the meeting search returned
  // The meetings here don't have _id easily, so this is a best-effort approach
  // In practice, the caller passes full meeting objects from enrichment

  return transcripts
}

// ═══════════════════════════════════════════
//  DATA EXTRACTION HELPERS
// ═══════════════════════════════════════════

/** Extract plain text from Clarify block-based description. */
function extractDescription(desc: any): string {
  if (!desc) return ''
  const textBlocks = desc.text
  if (!Array.isArray(textBlocks)) return ''

  const lines: string[] = []
  for (const block of textBlocks) {
    extractBlock(block, lines, 0)
  }
  return lines.join('\n')
}

/** Recursively extract text from nested blocks. */
function extractBlock(block: any, lines: string[], depth: number): void {
  const content = block.content ?? []
  const prefix = depth > 0 ? '  '.repeat(depth) + '- ' : ''
  const textParts: string[] = []

  for (const item of content) {
    if (item.type === 'text') {
      textParts.push(item.text ?? '')
    }
  }
  if (textParts.length > 0) {
    lines.push(prefix + textParts.join(''))
  }
  for (const child of block.children ?? []) {
    extractBlock(child, lines, depth + 1)
  }
}

/** Extract first item from Clarify JSONB {"items": [...]}. */
function jsonbFirst(val: any): string | null {
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const items = val.items
    return Array.isArray(items) && items.length > 0 ? items[0] : null
  }
  return val ?? null
}

/** Format Clarify name JSONB. */
function formatName(nameVal: any): string {
  if (typeof nameVal === 'object' && nameVal !== null) {
    const first = nameVal.first_name ?? ''
    const last = nameVal.last_name ?? ''
    return `${first} ${last}`.trim() || 'Unknown'
  }
  return nameVal ? String(nameVal) : 'Unknown'
}

/** Extract emails from Clarify email_addresses JSONB. */
function extractEmails(emailVal: any): string[] {
  if (typeof emailVal !== 'object' || emailVal === null) return []
  const items = emailVal.items
  if (!Array.isArray(items)) return []

  return items
    .map((item: any) => {
      if (typeof item === 'object' && item !== null) return item.email ?? ''
      if (typeof item === 'string') return item
      return ''
    })
    .filter((e: string) => e.length > 0)
}

/** Extract phone numbers from Clarify phone_numbers JSONB. */
function extractPhones(phoneVal: any): string[] {
  if (typeof phoneVal !== 'object' || phoneVal === null) return []
  const items = phoneVal.items
  if (!Array.isArray(items)) return []

  return items
    .map((item: any) => {
      if (typeof item === 'object' && item !== null) return item.phone_number ?? item.number ?? ''
      if (typeof item === 'string') return item
      return ''
    })
    .filter((p: string) => p.length > 0)
}

// ═══════════════════════════════════════════
//  CONTEXT ENRICHMENT
// ═══════════════════════════════════════════

export interface EnrichmentResult {
  task: any | null
  company: any | null
  person: any | null
  deal: any | null
  meetings: Array<{ subject: string; start: string; ai_summary: string; notes: string }>
  summary: string
}

/** Pull full context from Clarify for this task. */
export async function enrichFromClarify(task: any): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    task: null,
    company: null,
    person: null,
    deal: null,
    meetings: [],
    summary: '',
  }

  if (task.source !== 'clarify' || !task.source_id) {
    result.summary = `## Task: ${task.title}\nSource: ${task.source} (no Clarify link)`
    if (task.notes) {
      // Resolve relative /uploads/ paths to absolute so Claude can read attached files
      const uploadsDir = getUploadDir()
      const resolvedNotes = task.notes.replace(
        /\(\/uploads\/([^)]+)\)/g,
        (_match: string, filename: string) => `(${path.join(uploadsDir, filename)})`
      )
      result.summary += `\nNotes: ${resolvedNotes}`
    }
    return result
  }

  const clarifyTask = await apiGet(`objects/task/records/${task.source_id}`)
  if (!clarifyTask) {
    result.summary = `## Task: ${task.title}\n(Could not fetch from Clarify)`
    return result
  }

  result.task = clarifyTask
  const attrs = clarifyTask.attributes ?? {}
  const rels = clarifyTask.relationships ?? {}

  const description = extractDescription(attrs.description)

  let company = await fetchRelated(rels, 'company')
  let person = await fetchRelated(rels, 'person')
  let deal = await fetchRelated(rels, 'deal')

  // Chase relationships: person -> company, deal -> company
  if (!company && person) {
    company = await fetchRelated(person._relationships, 'company')
  }
  if (!company && deal) {
    company = await fetchRelated(deal._relationships, 'company')
  }

  result.company = company
  result.person = person
  result.deal = deal

  // Fetch meetings by participant email
  let meetings: EnrichmentResult['meetings'] = []
  if (person) {
    const personEmails = extractEmails(person.email_addresses)
    meetings = await fetchMeetingsByEmail(personEmails)
  }
  result.meetings = meetings

  // Build transcript excerpts from Clarify API (memsearch excluded in TS port)
  let transcriptExcerpts: Array<{ content: string; heading: string; source: string }> = []

  // Try Clarify API for meeting transcripts
  if (meetings.length > 0) {
    // Fetch transcript data for meetings that have recordings
    // This requires meeting IDs which we get from the raw API response
    // For now, transcript support is via the meeting summaries in the enrichment
    // Full transcript download requires the meeting ID from the Clarify resource
  }

  result.summary = buildSummary({
    title: attrs.title ?? task.title,
    description,
    dueDate: attrs.due_date ?? null,
    priority: attrs.priority ?? 'Medium',
    taskId: task.source_id,
    company,
    person,
    deal,
    meetings,
    transcriptExcerpts,
    localNotes: task.notes ?? '',
  })

  return result
}

// ═══════════════════════════════════════════
//  SUMMARY BUILDER
// ═══════════════════════════════════════════

interface BuildSummaryArgs {
  title: string
  description: string
  dueDate: string | null
  priority: string
  taskId: string
  company: any | null
  person: any | null
  deal: any | null
  meetings: Array<{ subject: string; start: string; ai_summary: string; notes: string }>
  transcriptExcerpts?: Array<{ content: string; heading: string; source: string }>
  localNotes?: string
}

function buildSummary(args: BuildSummaryArgs): string {
  const {
    title, description, dueDate, priority, taskId,
    company, person, deal, meetings,
    transcriptExcerpts = [], localNotes = '',
  } = args

  const parts: string[] = [`## Task: ${title}`]
  if (CLARIFY_BASE) parts.push(`CRM: ${CLARIFY_BASE.replace('/v1/', '/').replace('api.', 'app.')}/objects/task/records/${taskId}`)

  if (priority === 'Urgent' || priority === 'High') {
    parts.push(`**Priority**: ${priority}`)
  }
  if (dueDate) parts.push(`**Due**: ${dueDate}`)
  if (description) parts.push(`\n### Description\n${description}`)
  if (localNotes.trim()) parts.push(`\n### User Notes\n${localNotes.trim()}`)

  // Company
  if (company) {
    const name = company.name ?? 'Unknown'
    const cid = company._id ?? ''
    const tier = jsonbFirst(company.tier)
    const saasType = jsonbFirst(company.saas_type)
    const domain = company.domain ?? ''
    const tierReason = company.tier_reason ?? ''
    const coDescription = extractDescription(company.description)
    const industry = jsonbFirst(company.primary_industry)
    const employeeRange = company.employee_range ?? ''
    const founded = company.founded_date ?? ''
    const funding = company.total_funding_amount ?? ''
    const payments = jsonbFirst(company.payments_capability)
    const prospectStage = jsonbFirst(company.prospect_stage)

    parts.push(`\n### Company: ${name}`)
    if (CLARIFY_BASE) parts.push(`Link: ${CLARIFY_BASE.replace('/v1/', '/').replace('api.', 'app.')}/objects/company/records/${cid}`)
    if (tier) parts.push(`Tier: ${tier}`)
    if (saasType) parts.push(`SaaS Type: ${saasType}`)
    if (domain) parts.push(`Domain: ${domain}`)
    if (industry) parts.push(`Industry: ${industry}`)
    if (coDescription) parts.push(`Description: ${coDescription.slice(0, 500)}`)
    if (employeeRange) parts.push(`Employees: ${employeeRange}`)
    if (founded) parts.push(`Founded: ${founded}`)
    if (funding) parts.push(`Total Funding: ${funding}`)
    if (payments) parts.push(`Payments: ${payments}`)
    if (prospectStage) parts.push(`Prospect Stage: ${prospectStage}`)
    if (tierReason) parts.push(`Tier Reason: ${tierReason}`)
  }

  // Person
  if (person) {
    const pname = formatName(person.name)
    const pid = person._id ?? ''
    const ptitle = person.title ?? ''
    const emails = extractEmails(person.email_addresses)
    const phones = extractPhones(person.phone_numbers)
    const linkedin = person.linkedin ?? ''
    const prospectStage = jsonbFirst(person.prospect_stage)
    const c1 = jsonbFirst(person.outreach_campaign)
    const c1Date = person.outreach_campaign_1_date ?? ''
    const c2 = jsonbFirst(person.outreach_campaign_2)
    const c3 = person.outreach_campaign_3 ?? ''
    const campaignResponse = person.outreach_campaign_response ?? ''
    const contactStatus = jsonbFirst(person.contact_status)

    parts.push(`\n### Person: ${pname}`)
    if (CLARIFY_BASE) parts.push(`Link: ${CLARIFY_BASE.replace('/v1/', '/').replace('api.', 'app.')}/objects/person/records/${pid}`)
    if (ptitle) parts.push(`Title: ${ptitle}`)
    if (emails.length) parts.push(`Email: ${emails.join(', ')}`)
    if (phones.length) parts.push(`Phone: ${phones.join(', ')}`)
    if (linkedin) parts.push(`LinkedIn: ${linkedin}`)
    if (prospectStage) parts.push(`Prospect Stage: ${prospectStage}`)
    if (contactStatus) parts.push(`Contact Status: ${contactStatus}`)

    const campaigns: string[] = []
    if (c1) campaigns.push(`C1: ${c1}${c1Date ? ` (${c1Date.slice(0, 10)})` : ''}`)
    if (c2) campaigns.push(`C2: ${c2}`)
    if (c3) campaigns.push(`C3: ${c3}`)
    if (campaigns.length) parts.push(`Outreach: ${campaigns.join(' | ')}`)
    if (campaignResponse) parts.push(`Campaign Response: ${campaignResponse}`)
  }

  // Deal
  if (deal) {
    const dname = deal.name ?? 'Unknown'
    const did = deal._id ?? ''
    const stage = deal.stage ?? ''
    const dealDesc = extractDescription(deal.description)
    const amount = deal.amount ?? ''
    const closeDate = deal.close_date ?? ''
    const icpFit = jsonbFirst(deal.icp_fit)
    const dealNotes = deal.notes ?? ''

    parts.push(`\n### Deal: ${dname}`)
    if (CLARIFY_BASE) parts.push(`Link: ${CLARIFY_BASE.replace('/v1/', '/').replace('api.', 'app.')}/objects/deal/records/${did}`)
    if (stage) parts.push(`Stage: ${stage}`)
    if (amount) parts.push(`Amount: ${amount}`)
    if (closeDate) parts.push(`Close Date: ${closeDate}`)
    if (icpFit) parts.push(`ICP Fit: ${icpFit}`)
    if (dealDesc) parts.push(`Description: ${dealDesc.slice(0, 500)}`)
    if (dealNotes) parts.push(`Notes: ${dealNotes.slice(0, 300)}`)
  }

  // Meetings
  if (meetings.length > 0) {
    parts.push(`\n### Recent Meetings (${meetings.length})`)
    for (const m of meetings.slice(0, 3)) {
      const subject = m.subject ?? 'No subject'
      const start = (m.start ?? '').slice(0, 10)
      let summary = m.ai_summary ?? ''
      let notes = m.notes ?? ''

      parts.push(`\n**${subject}** (${start})`)
      if (summary) {
        if (summary.length > 800) summary = summary.slice(0, 800) + '...'
        parts.push(summary)
      }
      if (notes) {
        if (notes.length > 500) notes = notes.slice(0, 500) + '...'
        parts.push(`Notes: ${notes}`)
      }
    }
  }

  // Transcript excerpts
  if (transcriptExcerpts.length > 0) {
    parts.push(`\n### Call Transcript Excerpts (${transcriptExcerpts.length})`)
    for (let i = 0; i < Math.min(transcriptExcerpts.length, 3); i++) {
      const excerpt = transcriptExcerpts[i]
      const heading = excerpt.heading || `Excerpt ${i + 1}`
      let content = excerpt.content || ''
      const source = excerpt.source || ''
      const sourceLabel = source.includes('memsearch') ? 'memsearch' : 'Clarify API'
      if (content.length > 1500) content = content.slice(0, 1500) + '...'
      parts.push(`\n**${heading}** (via ${sourceLabel})`)
      parts.push(content)
    }
  }

  // Flag missing context
  const missing: string[] = []
  if (!person) {
    missing.push('person (no contact linked to this task -- look up in Clarify by company or name from task title)')
  } else if (extractEmails(person.email_addresses).length === 0) {
    missing.push('person email (contact found but no email on record)')
  }
  if (!company) {
    missing.push('company (not linked -- search Clarify if company name appears in task title)')
  }
  if (missing.length > 0) {
    parts.push('\n### Missing Context -- USE TOOLS TO LOOK UP')
    for (const m of missing) {
      parts.push(`- ${m}`)
    }
  }

  return parts.join('\n')
}

// ═══════════════════════════════════════════
//  PROMPT BUILDERS
// ═══════════════════════════════════════════

/** Check if a task is email-related (by classification keys or title). */
function isEmailTask(matchedKeys: string[], taskTitle: string): boolean {
  if (matchedKeys.some(k => k.startsWith('email:'))) return true
  const lower = taskTitle.toLowerCase()
  const emailWords = ['email', 'draft', 'send', 'nda', 'follow up', 'follow-up', 'intro', 'reply']
  return emailWords.some(w => lower.includes(w))
}

/** Load email templates block if applicable. */
function loadEmailTemplatesBlock(matchedKeys: string[], taskTitle: string): string {
  if (!isEmailTask(matchedKeys, taskTitle)) return ''

  const templatesPath = path.join(getProjectRoot(), 'outputs', 'templates', 'email-templates.md')
  const templatesText = readCachedText(templatesPath)
  if (!templatesText) return ''

  return `
---

# Email Templates -- MATCH THIS VOICE

These are the user's approved email templates. Match the tone, structure, and style exactly.
Do NOT deviate from these patterns unless the user explicitly asks for something different.

${templatesText}
`
}

/** Build the prompt for Claude's initial analysis session. */
function buildAnalysisPrompt(task: any, context: EnrichmentResult, userContext = ''): string {
  const rocaPrompt = readRocaFile('roca-prompt.md')
  const rocaJournal = readRocaFile('journal.md')
  const observerBrief = readCachedText(path.join(os.homedir(), '.claude/observer/brief.md'))
  const prioritiesMd = readCachedText(path.join(getProjectRoot(), 'state', 'priorities.md'))

  const [matchedKeys, rocaPlaybook] = classifyAndPullPlaybook(
    task.title ?? '', task.notes ?? ''
  )

  const taskContext = context.summary

  let userContextBlock = ''
  if (userContext?.trim()) {
    userContextBlock = `
---

# User Instructions

The user added the following context for this specific task:

${userContext.trim()}

Follow these instructions carefully when producing your output.
`
  }

  let journalBlock = ''
  if (rocaJournal.trim()) {
    journalBlock = `
---

# ROCA Journal -- Patterns & Insights

This journal captures patterns from past corrections and preferences.
Use these insights to produce better first-try output. Follow these patterns closely.

${rocaJournal.slice(0, 3000)}
`
  }

  let playbookBlock = ''
  if (rocaPlaybook.trim()) {
    const keyLabel = matchedKeys.length > 0 ? matchedKeys.join(', ') : 'general'
    playbookBlock = `
---

# ROCA Playbook -- Matched Cases (classification: ${keyLabel})

These are concrete examples of how the user handled similar tasks previously.
Replicate what worked and avoid what was corrected.

${rocaPlaybook.slice(0, 5000)}
`
  }

  const emailTemplatesBlock = loadEmailTemplatesBlock(matchedKeys, task.title ?? '')

  const observerBlock = observerBrief
    ? `---\n\n# Daily Reflection Brief\n\n${observerBrief}`
    : ''

  const prioritiesBlock = prioritiesMd
    ? `---\n\n# Current Priorities\n\n${prioritiesMd.slice(0, 2000)}`
    : ''

  return `You are a CRM analyst and task executor.
The user is delegating a task to you via ROCA (their task manager). Your job is to analyze this task
and produce TWO things:

1. A **brief execution plan** -- the steps to complete this task
2. The **actual output** -- the real artifact (email draft, SQL query, analysis, memo, etc.)

NOTE: CLAUDE.md is already loaded as your system context from the project directory.
You have full access to skills, API configs, and project rules defined there.

---

# Task to Analyze

${taskContext}

${observerBlock}

${prioritiesBlock}

---

# ROCA-Specific Instructions

${rocaPrompt ? rocaPrompt.slice(0, 4000) : '(No roca-prompt.md)'}
${journalBlock}
${playbookBlock}
${emailTemplatesBlock}
${userContextBlock}
---

# Your Instructions

Analyze this task and produce REAL OUTPUT -- not a description of what to do.

## Response Format (use these exact headers):

### Plan
Brief numbered steps (3-7 steps max). What you're doing and why.

### Output
The actual artifact. Examples by task type:
- **Email tasks**: Write the full email draft (subject, to, body)
- **Research tasks**: Present your findings with sources
- **CRM update tasks**: Show the exact API calls or field changes needed
- **Meeting prep**: Write the actual briefing doc
- **Analysis tasks**: Present the analysis with data and conclusions

### Next Steps
What the user should do after reviewing (1-3 bullets max).

---

RULES:
- If this involves email: Write the FULL draft (subject line, greeting, body, sign-off). Reference email draft skills if available. NEVER send -- drafts only.
- **EMAIL TEMPLATES**: ALWAYS check for email templates before writing ANY email. Match the tone, structure, and style from the relevant template. If the user asks you to adjust tone/style, check the templates first -- the answer is probably there.
- If this involves CRM: Show exact field values and API endpoints.
- If this involves a person: Use their actual name, title, and company from the context above
- Be CONCRETE. Write the actual email, not "draft an email about X"
- If you don't have enough context to produce the output, say exactly what's missing

CRITICAL: Produce the plan AND output in your FIRST response. Your job is ANALYSIS + ARTIFACT GENERATION, not codebase exploration.

TOOL USAGE: If the enriched context above is MISSING key info needed for the output (e.g., email address, phone number, person details, deal status), USE TOOLS to look it up:
- Use Bash to run \`cd agents/sdk/tools && python3 clarify/query.py person --filter "name[Contains]=PersonName"\` to find contacts
- Use Bash to run \`cd agents/sdk/tools && python3 clarify/query.py company --filter "name[Contains]=CompanyName"\` to find company details
- Use Read tool to check email templates at \`outputs/templates/email-templates.md\`
- Use Read tool to check relevant skill files
- NEVER leave placeholders like "[email]" or "[pull from Clarify]" -- look it up yourself
- Do NOT explore the codebase or read files unrelated to the task`
}

/** Build prompt for refinement -- includes conversation history. */
function buildRefinementPrompt(
  task: any,
  cachedPlan: string,
  cachedContext: string,
  messages: Array<{ role: string; content: string }>,
  feedback: string
): string {
  const rocaPrompt = readRocaFile('roca-prompt.md')
  const rocaJournal = readRocaFile('journal.md')
  const observerBrief = readCachedText(path.join(os.homedir(), '.claude/observer/brief.md'))

  const [matchedKeys, rocaPlaybook] = classifyAndPullPlaybook(
    task.title ?? '', task.notes ?? ''
  )

  // Build conversation history
  const historyParts: string[] = []
  for (const msg of messages) {
    const roleLabel = msg.role === 'user' || msg.role === 'context' ? 'User' : 'You (Claude)'
    const content = msg.role === 'user' || msg.role === 'context'
      ? rewriteImageRefs(msg.content)
      : msg.content
    historyParts.push(`**${roleLabel}**: ${content}`)
  }
  const historyText = historyParts.length > 0
    ? historyParts.join('\n\n')
    : '(No prior conversation)'

  let journalBlock = ''
  if (rocaJournal.trim()) {
    journalBlock = `
---

# ROCA Journal -- Patterns & Insights

${rocaJournal.slice(0, 3000)}
`
  }

  let playbookBlock = ''
  if (rocaPlaybook.trim()) {
    const keyLabel = matchedKeys.length > 0 ? matchedKeys.join(', ') : 'general'
    playbookBlock = `
---

# ROCA Playbook -- Matched Cases (classification: ${keyLabel})

These are concrete examples of how the user handled similar tasks previously.
Replicate what worked and avoid what was corrected.

${rocaPlaybook.slice(0, 5000)}
`
  }

  const emailTemplatesBlock = loadEmailTemplatesBlock(matchedKeys, task.title ?? '')

  const observerBlock = observerBrief
    ? `---\n\n# Daily Reflection Brief\n\n${observerBrief}`
    : ''

  return `You are a CRM analyst and task executor.
The user previously asked you to analyze a task via ROCA. You produced an output, and now the user
has feedback to refine it. Revise your output based on their instructions.

NOTE: CLAUDE.md is already loaded as your system context from the project directory.

---

# ROCA-Specific Instructions

${rocaPrompt ? rocaPrompt.slice(0, 4000) : '(No roca-prompt.md)'}
${journalBlock}
${playbookBlock}
${emailTemplatesBlock}

${observerBlock}

---

# Task Context

${cachedContext}

---

# Your Previous Output

${cachedPlan}

---

# Conversation History

${historyText}

---

# User's New Feedback

${rewriteImageRefs(feedback)}

---

# Your Instructions

Revise the output based on the user's feedback above. Keep the same format:

### Plan
Brief numbered steps (3-7 steps max).

### Output
The revised artifact (email draft, analysis, memo, etc.)

### Next Steps
What the user should do after reviewing (1-3 bullets max).

RULES:
- Incorporate the user's feedback precisely
- Keep everything the user didn't mention -- only change what they asked to change
- Maintain the same quality and detail level
- Be CONCRETE -- produce the actual artifact, not a description

CRITICAL: Produce the revised plan AND output in your FIRST response. If you need to look up missing info, use available tools -- never leave placeholders.`
}

/** Build prompt for actual execution -- Claude gets write tools. */
function buildExecutionPrompt(task: any, plan: string, context: string): string {
  const rocaPrompt = readRocaFile('roca-prompt.md')

  return `You are a CRM analyst and task executor. The user reviewed the following plan
in ROCA and clicked "Execute". Your job is to EXECUTE this plan -- actually do the work.

NOTE: CLAUDE.md is already loaded as your system context. You have full access to
skills, API configs, data integrity rules, and project documentation.

---

# Task
${task.title ?? 'Unknown task'}
${task.company_name ? `Company: ${task.company_name}` : ''}
${task.source ? `Source: ${task.source}` : ''}

# Enriched Context
${context}

# Approved Plan
${plan}

---

# Execution Instructions

Execute the plan above. You have full tool access:
- Clarify MCP tools for CRM reads/writes
- Gmail draft skill for emails (NEVER send -- drafts only)
- File tools for document creation
- Web search for research

RULES:
- Follow the plan step by step
- Log all CRM changes to \`state/clarify-changelog.jsonl\` (format in CLAUDE.md)
- For emails: use \`skills/gmail-drafts/scripts/gmail-draft.py\` -- DRAFTS ONLY
- For CRM writes: validate against \`skills/data-integrity-rules.md\` first
- When done, summarize what you actually did (not what you planned to do)

---

# ROCA-Specific Instructions

${rocaPrompt ? rocaPrompt.slice(0, 4000) : ''}

Execute now. Report what you did when finished.`
}

/** Generate a static fallback prompt when Claude headless is unavailable. */
function fallbackPrompt(task: any, context: EnrichmentResult): string {
  const summary = context.summary
  const titleLower = (task.title ?? '').toLowerCase()

  let action: string
  if (['send', 'email', 'draft', 'follow-up', 'pass'].some(kw => titleLower.includes(kw))) {
    action = 'Draft an email using `skills/gmail-drafts/SKILL.md` (NEVER send -- drafts only)'
  } else if (['research', 'evaluate', 'analyze', 'investigate'].some(kw => titleLower.includes(kw))) {
    action = 'Research using web search + Clarify data, then update CRM'
  } else if (['schedule', 'book', 'meeting', 'calendar', 'coordinate'].some(kw => titleLower.includes(kw))) {
    action = 'Check calendar via `skills/calendar.skill` and coordinate'
  } else if (['prepare', 'create', 'write', 'compile'].some(kw => titleLower.includes(kw))) {
    action = 'Create the deliverable described in the task'
  } else if (['update', 'add', 'tag', 'label', 'mark'].some(kw => titleLower.includes(kw))) {
    action = 'Update CRM records via Clarify REST API'
  } else if (titleLower.includes('invite')) {
    action = 'Draft invitation email via Gmail draft skill'
  } else {
    action = 'Analyze task context and determine best approach'
  }

  return `### Plan
1. ${action}
2. Review context from Clarify (see below)
3. Produce deliverable

### Output
*Claude was unavailable -- static fallback. Click "Re-analyze" to try again.*

---

${summary}`
}

// ═══════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════

export interface DelegateResult {
  plan: string
  context: string
  cost: number
  turns: number
  error: string | null
  sessionId: string | null
  sessionLabel: string
}

/**
 * Enrich task with Clarify context, spawn Claude to analyze, return plan + output.
 * This is the main entry point for initial task analysis.
 */
export async function runClaudeAnalysis(
  task: any,
  context: EnrichmentResult,
  userContext?: string
): Promise<DelegateResult> {
  console.log(`[delegate] runClaudeAnalysis called for: ${task.title ?? '?'}`)
  if (userContext) {
    console.log(`[delegate] userContext: ${userContext.slice(0, 200)}`)
  }

  const claudeBin = findClaudeBinary()
  if (!claudeBin) {
    return {
      plan: fallbackPrompt(task, context),
      context: context.summary,
      cost: 0,
      turns: 0,
      error: 'Claude binary not found -- showing static prompt',
      sessionId: null,
      sessionLabel: 'new session',
    }
  }

  const prompt = buildAnalysisPrompt(task, context, userContext)
  const sessionId = crypto.randomUUID()

  console.log(`[delegate] Spawning Claude: --model ${CLAUDE_MODEL} --max-turns ${CLAUDE_MAX_TURNS_ANALYSIS} --session-id ${sessionId.slice(0, 12)}...`)
  console.log(`[delegate] Prompt length: ${prompt.length} chars, timeout: ${CLAUDE_TIMEOUT_ANALYSIS / 1000}s`)

  const result = await runClaudeHeadless({
    claudeBin,
    prompt,
    sessionId,
    timeout: CLAUDE_TIMEOUT_ANALYSIS,
  })

  if (result.error && !result.plan) {
    return {
      plan: fallbackPrompt(task, context),
      context: context.summary,
      cost: result.cost,
      turns: result.turns,
      error: result.error,
      sessionId: result.sessionId,
      sessionLabel: 'new session',
    }
  }

  if (!result.plan.trim()) {
    if (result.turns > 1) {
      result.plan = 'Analysis completed but no summary was returned. Click Re-analyze to retry.'
    } else {
      return {
        plan: fallbackPrompt(task, context),
        context: context.summary,
        cost: result.cost,
        turns: result.turns,
        error: 'Claude returned empty response',
        sessionId: result.sessionId,
        sessionLabel: 'new session',
      }
    }
  }

  // Cache session for --resume on follow-up messages
  const taskId = task.id
  if (result.sessionId && taskId) {
    taskSessions.set(taskId, result.sessionId)
  }

  console.log(`[delegate] SUCCESS: plan_len=${result.plan.length}, cost=$${result.cost.toFixed(4)}, turns=${result.turns}`)

  return {
    plan: result.plan,
    context: context.summary,
    cost: result.cost,
    turns: result.turns,
    error: result.error,
    sessionId: result.sessionId,
    sessionLabel: 'new session',
  }
}

/**
 * Refine via --resume (like Slack Bot follow-up messages).
 * If a session exists for this task, resumes it with just the new feedback.
 * Falls back to full prompt rebuild if resume fails.
 */
export async function refineOutput(
  task: any,
  cachedPlan: string,
  cachedContext: string,
  messages: Array<{ role: string; content: string }>,
  feedback: string,
  cachedSessionId?: string | null
): Promise<DelegateResult> {
  const taskId = task.id as number | undefined
  console.log(`[delegate] refineOutput called for task ${taskId}: ${feedback.slice(0, 100)}`)

  const claudeBin = findClaudeBinary()
  if (!claudeBin) {
    return {
      plan: '',
      context: cachedContext,
      cost: 0,
      turns: 0,
      error: 'Claude binary not found',
      sessionId: null,
      sessionLabel: 'new session',
    }
  }

  const feedbackForClaude = rewriteImageRefs(feedback)

  // Try --resume first (much cheaper — Claude retains full conversation state)
  const sessionId = (taskId ? taskSessions.get(taskId) : undefined) ?? cachedSessionId
  if (sessionId) {
    console.log(`[delegate] Resuming session ${sessionId.slice(0, 12)}... with feedback`)

    const resumeResult = await runClaudeHeadless({
      claudeBin,
      prompt: feedbackForClaude,
      resumeSessionId: sessionId,
      timeout: CLAUDE_TIMEOUT_ANALYSIS,
    })

    if (!resumeResult.error && resumeResult.plan.trim()) {
      // Update session cache
      if (resumeResult.sessionId && taskId) {
        taskSessions.set(taskId, resumeResult.sessionId)
      }
      console.log(`[delegate] Resume SUCCESS: plan_len=${resumeResult.plan.length}, cost=$${resumeResult.cost.toFixed(4)}`)
      return {
        plan: resumeResult.plan,
        context: cachedContext,
        cost: resumeResult.cost,
        turns: resumeResult.turns,
        error: null,
        sessionId: resumeResult.sessionId,
        sessionLabel: 'resumed',
      }
    }

    // Resume failed — fall through to full prompt
    console.log(`[delegate] Resume failed (${resumeResult.error}), falling back to full prompt`)
    if (taskId) taskSessions.delete(taskId)
  }

  // Fallback: full prompt rebuild
  const prompt = buildRefinementPrompt(task, cachedPlan, cachedContext, messages, feedback)
  const newSessionId = crypto.randomUUID()

  console.log(`[delegate] Refine (full prompt): ${prompt.length} chars, session=${newSessionId.slice(0, 12)}...`)

  const result = await runClaudeHeadless({
    claudeBin,
    prompt,
    sessionId: newSessionId,
    timeout: CLAUDE_TIMEOUT_ANALYSIS,
  })

  // Update session cache
  if (result.sessionId && taskId) {
    taskSessions.set(taskId, result.sessionId)
  }

  if (result.error && !result.plan) {
    return {
      plan: '',
      context: cachedContext,
      cost: result.cost,
      turns: result.turns,
      error: result.error,
      sessionId: result.sessionId,
      sessionLabel: 'new session',
    }
  }

  if (!result.plan.trim()) {
    console.log(`[delegate] Refine returned empty plan -- reporting error`)
    return {
      plan: '',
      context: cachedContext,
      cost: result.cost,
      turns: result.turns,
      error: 'Claude returned empty response -- try again or rephrase',
      sessionId: result.sessionId,
      sessionLabel: 'new session',
    }
  }

  console.log(`[delegate] Refine SUCCESS: plan_len=${result.plan.length}, cost=$${result.cost.toFixed(4)}`)
  return {
    plan: result.plan,
    context: cachedContext,
    cost: result.cost,
    turns: result.turns,
    error: null,
    sessionId: result.sessionId,
    sessionLabel: 'new session',
  }
}

/**
 * Execute a previously generated plan. Called from background thread.
 * Returns { output, cost }.
 */
export async function executePlan(
  task: any,
  plan: string,
  context: string
): Promise<{ output: string; cost: number }> {
  const claudeBin = findClaudeBinary()
  if (!claudeBin) {
    return { output: 'Error: Claude binary not found.', cost: 0 }
  }

  const prompt = buildExecutionPrompt(task, plan, context)

  console.log(`[delegate] executePlan: ${prompt.length} chars, timeout: ${CLAUDE_TIMEOUT_EXECUTE / 1000}s`)

  const result = await runClaudeHeadless({
    claudeBin,
    prompt,
    maxTurns: CLAUDE_MAX_TURNS_EXECUTE,
    timeout: CLAUDE_TIMEOUT_EXECUTE,
    // No allowedTools restriction for execution — full access
    allowedTools: '',
  })

  if (result.error && !result.plan) {
    return { output: result.error, cost: 0 }
  }

  let output = result.plan
  if (!output.trim()) {
    if (result.turns > 1) {
      output = 'Execution completed but no summary was returned. Check Clarify/Gmail for results.'
    } else {
      output = 'No output generated.'
    }
  }

  return { output, cost: result.cost }
}

// ═══════════════════════════════════════════
//  LEARNING LOOP
// ═══════════════════════════════════════════

/**
 * Shared runner for learning reflection calls. Uses Opus model.
 * Returns Claude's text output or null.
 */
async function runReflection(
  claudeBin: string,
  prompt: string,
  label: string,
  timeout = 300_000
): Promise<string | null> {
  console.log(`[learn:${label}] Opus reflecting...`)

  const result = await runClaudeHeadless({
    claudeBin,
    prompt,
    model: 'opus',
    maxTurns: 5,
    timeout,
    allowedTools: '', // No tools needed for reflection
  })

  if (result.error) {
    console.log(`[learn:${label}] Claude failed: ${result.error}`)
    return null
  }

  if (!result.plan.trim()) {
    console.log(`[learn:${label}] Empty result from Claude`)
    return null
  }

  return result.plan
}

/** Build readable conversation text from message list. */
function buildConversationText(
  messages: Array<{ role: string; content: string }>,
  maxMessages = 15
): string {
  if (!messages || messages.length === 0) return '(No conversation)'

  return messages
    .slice(-maxMessages)
    .map(msg => {
      const role = msg.role === 'user' || msg.role === 'context' ? 'User' : 'ROCA'
      return `**${role}**: ${msg.content}`
    })
    .join('\n\n')
}

/**
 * Learn from a completed task -- Opus reviews the full conversation and writes playbook entries.
 * Called when a task is marked done. Reviews everything: what the user asked for, what ROCA
 * produced, what corrections the user made, what the final result was.
 * Also updates the journal if there's a new abstract rule worth capturing.
 */
export async function learnFromFeedback(
  feedback: string,
  taskTitle = '',
  messages?: Array<{ role: string; content: string }>
): Promise<void> {
  const claudeBin = findClaudeBinary()
  if (!claudeBin) {
    console.log('[learn] Claude binary not found, skipping learning')
    return
  }

  const playbookSections = loadPlaybookSections()
  const currentJournal = readRocaFile('journal.md')
  const conversation = buildConversationText(messages ?? [])

  const playbookKeysLabel = Object.keys(playbookSections).length > 0
    ? Object.keys(playbookSections).map(k => `\`${k}\``).join(', ')
    : '(none yet)'

  const prompt = `You are ROCA's learning system. A task just completed. Your job is to:
1. CLASSIFY the task into a pattern key
2. Decide if the playbook for that key needs updating (new rules or cases)
3. Optionally update the journal if a new pattern emerged

## The completed task
Title: "${taskTitle}"

## Full conversation (User <-> ROCA)
${conversation}

## Current journal (classification taxonomy)
---
${currentJournal.slice(0, 4000)}
---

## Step 1: Classify the task

Look at the journal's pattern keys (e.g., \`email:founder-followup-pass\`, \`sheets:vai-tracker\`,
\`crm:meeting-count\`, \`research:api-exploration\`). Which key best matches this task?

If NO existing key fits, create a new one following the naming convention:
\`category:specific-pattern\` (e.g., \`email:banker-intro-request\`, \`research:competitor-analysis\`)

## Step 2: Decide if playbook needs updating

**CRITICAL: Only update the playbook if this task adds NEW information.** Ask yourself:
- Did the user correct something that isn't already captured as a rule?
- Is this case meaningfully different from existing cases?
- Would a future ROCA session benefit from knowing about this specific execution?

If the answer to ALL is no, output SKIP.

If yes, output the COMPLETE updated playbook file content for this key.
The playbook file should have this structure:

\`\`\`
# \`the:classification-key\`

> One-line description of this task type.

## Rules

- [Actionable rules -- what to always/never do]

## Cases

> **[Company/Person] ([Date])** -- [1-2 sentence summary]
\`\`\`

**Available playbook keys**: ${playbookKeysLabel}

If the classified key already has a playbook file, MERGE your additions into the existing content below (don't lose existing rules/cases).
If it's a new key, write the complete file from scratch.

## Step 3: Journal update (only if needed)

If this task revealed a NEW pattern that doesn't exist in the journal yet, add it.
If the task fits an existing pattern, output UNCHANGED.

## Output format

Output THREE sections separated by exact delimiters:

SECTION 1 (classification key): Just the key, e.g., \`email:founder-followup-pass\`

===PLAYBOOK===

SECTION 2 (playbook file content): The COMPLETE file content for this key's playbook, or SKIP if nothing new to add.

===JOURNAL===

SECTION 3 (journal): The COMPLETE updated journal (starting with "# ROCA Journal"),
or the word UNCHANGED if no new pattern needed.`

  const result = await runReflection(claudeBin, prompt, 'feedback')
  if (!result) return

  // Parse the three sections: classification, playbook, journal
  let classification = ''
  let playbookPart = ''
  let journalPart = 'UNCHANGED'

  if (result.includes('===PLAYBOOK===') && result.includes('===JOURNAL===')) {
    const [beforePlaybook, rest] = result.split('===PLAYBOOK===', 2)
    classification = beforePlaybook.trim().replace(/`/g, '')

    if (rest.includes('===JOURNAL===')) {
      const [pb, jp] = rest.split('===JOURNAL===', 2)
      playbookPart = pb.trim()
      journalPart = jp.trim()
    } else {
      playbookPart = rest.trim()
    }
  } else if (result.includes('===JOURNAL===')) {
    const [pb, jp] = result.split('===JOURNAL===', 2)
    playbookPart = pb.trim()
    journalPart = jp.trim()
  } else {
    playbookPart = result.trim()
  }

  if (classification) {
    console.log(`[learn:feedback] Classified as: ${classification}`)
  }

  // Update per-key playbook file
  if (playbookPart && playbookPart.toUpperCase() !== 'SKIP') {
    writePlaybookFile(classification || 'unknown', playbookPart, 'learn:feedback')
  } else {
    console.log('[learn:feedback] No new playbook entries')
  }

  // Update journal (full rewrite if changed)
  if (
    journalPart &&
    journalPart.toUpperCase() !== 'UNCHANGED' &&
    journalPart.startsWith('# ROCA Journal')
  ) {
    if (journalPart.trim() !== currentJournal.trim()) {
      const journalPath = path.join(getRocaDir(), 'journal.md')
      fs.writeFileSync(journalPath, journalPart + '\n')
      console.log(`[learn:feedback] Journal updated (${currentJournal.length} -> ${journalPart.length} chars)`)
    } else {
      console.log('[learn:feedback] Journal unchanged')
    }
  } else {
    console.log('[learn:feedback] No journal changes')
  }
}

// ═══════════════════════════════════════════
//  CONVENIENCE: FULL ENRICH + ANALYZE FLOW
// ═══════════════════════════════════════════

/**
 * Full delegation flow: enrich from Clarify, then run Claude analysis.
 * Convenience wrapper that combines enrichFromClarify + runClaudeAnalysis.
 */
export async function enrichAndAnalyze(
  task: any,
  userContext = ''
): Promise<DelegateResult> {
  console.log(`[delegate] enrichAndAnalyze called for: ${task.title ?? '?'}`)

  const context = await enrichFromClarify(task)
  console.log(`[delegate] enrichment done, summary length=${context.summary.length}`)

  const result = await runClaudeAnalysis(task, context, userContext)
  return result
}
