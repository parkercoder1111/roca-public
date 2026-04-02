import { app, BrowserWindow, ipcMain, Menu, nativeImage, clipboard, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { execSync, execFile } from 'child_process'
import {
  initDatabase,
  currentIsoWeek,
  getTasks,
  getCompletedInWeek,
  createTask,
  toggleTask,
  getTaskById,
  updateTaskNotes,
  updateTaskFields,
  updateTaskStatus,
  reorderTasks,
  setTaskInProgress,
  getWeekData,
  updateChallenges,
  updateMeetingsHeld,
  makeTaskRecurring,
  unmakeTaskRecurring,
  isTaskRecurring,
  getRecurringTasks,
  addRecurringTask,
  removeRecurringTask,
  spawnRecurringForWeek,
  rolloverWeek,
  rolloverAllPriorWeeks,
  repairRolloverFolders,
  getCachedDelegate,
  saveDelegateCache,
  clearDelegateCache,
  createExecution,
  updateExecution,
  getExecution,
  getLatestExecution,
  addDelegateMessage,
  getDelegateMessages,
  clearDelegateMessages,
  getDelegateMessageCount,
  saveUpload,
  getUploadsForTask,
  getUploadsForMessage,
  getPendingUploads,
  linkUploadsToMessage,
  deleteUpload,
  getScheduledDueTasks,
  clearScheduledAt,
  getFolders,
  getOpenUnfoldered,
  createFolder,
  renameFolder,
  toggleFolderCollapse,
  deleteFolder,
  setTaskFolder,
  updateFolderColor,
  reorderFolders,
  FOLDER_COLORS,
  STATUS_LABELS,
  ACTIVE_STATUSES,
  getInboxTasks,
  getInboxCount,
  markTaskTriaged,
  populateTaskFlags,
  getDb,
  getTasksByProject,
  setTaskProject,
} from './database'
import {
  syncAll,
  pushTaskToClarify,
  pushTaskToGoogleTasks,
  reconcileAll,
  processTranscript,
  syncKrisp,
} from './sync'
import { PtyManager } from './ptyManager'
import { BrowserManager } from './browserManager'
import { RemoteServer } from './remoteServer'
import {
  savePtyScrollbackBatch, loadPtyScrollback, getTools, createTool, updateTool, deleteTool,
  createTaskSession, endTaskSession, saveSessionSummary, getTaskSessions, getActiveTaskSession,
  saveBrowserTabs, loadBrowserTabs, deleteBrowserTabs,
} from './database'
import {
  enrichAndAnalyze,
  enrichFromClarify,
  refineOutput,
  executePlan,
  learnFromFeedback,
} from './delegate'
import { listAgents, getAgentState, tailAgentLog, startAgent, stopAgent, openAgentOutput, getAgentFiles, readAgentFile, getToolFiles } from './agentManager'

// ═══════════════════════════════════════════
//  LOAD SHELL ENVIRONMENT
//  macOS Dock-launched apps don't inherit .zshrc env vars
// ═══════════════════════════════════════════

try {
  const shellEnv = execSync('zsh -ilc env 2>/dev/null', { timeout: 5000 }).toString()
  for (const line of shellEnv.split('\n')) {
    const eqIdx = line.indexOf('=')
    if (eqIdx < 1) continue
    const key = line.slice(0, eqIdx)
    const val = line.slice(eqIdx + 1)
    if (!process.env[key]) process.env[key] = val
  }
} catch { /* ignore — shell env loading is best-effort */ }

// ═══════════════════════════════════════════
//  APP GLOBALS
// ═══════════════════════════════════════════

let mainWindow: BrowserWindow | null = null
const popoutWindows = new Map<string, BrowserWindow>()
const ptyManager = new PtyManager()
const browserManager = new BrowserManager()
const remoteServer = new RemoteServer()


// Track whether a code update is available
let updateAvailable = false
// Guard: suppress window-all-closed during hot-reload
let isHotReloading = false

// Upload config — shared constants
import { ALLOWED_EXTENSIONS, MAX_UPLOAD_SIZE } from '../shared/constants'

// ═══════════════════════════════════════════
//  APPLICATION MENU
// ═══════════════════════════════════════════

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        ...(updateAvailable
          ? [
              { type: 'separator' as const },
              {
                label: 'Apply Update (keep sessions)',
                accelerator: 'CmdOrCtrl+Shift+U',
                click: async () => {
                  isHotReloading = true
                  mainWindow?.webContents.send('app:rebuilding')
                  const srcDir = path.join(os.homedir(), 'repos/roca')
                  try {
                    try {
                      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
                      execSync('git add -A', { cwd: srcDir, timeout: 10000 })
                      execSync(`git diff --cached --quiet || git commit -m "ROCA update ${timestamp}"`, { cwd: srcDir, timeout: 10000 })
                      execSync('git push origin main', { cwd: srcDir, timeout: 30000 })
                    } catch (_gitErr) {
                      console.error('[roca] Git push failed:', _gitErr)
                    }
                    if (app.isPackaged) {
                      execSync('source $HOME/.nvm/nvm.sh && npm run build', { cwd: srcDir, timeout: 60000, shell: '/bin/bash' })
                      const installedRenderer = '/Applications/ROCA.app/Contents/Resources/app/dist/renderer'
                      const builtRenderer = path.join(srcDir, 'dist/renderer')
                      execSync(`rm -rf "${installedRenderer}" && cp -R "${builtRenderer}" "${installedRenderer}"`)
                      const installedMain = '/Applications/ROCA.app/Contents/Resources/app/dist/main'
                      const builtMain = path.join(srcDir, 'dist/main')
                      execSync(`rm -rf "${installedMain}" && cp -R "${builtMain}" "${installedMain}"`)
                    }
                    console.log('[roca] Hot-reload: reloading window (PTYs preserved)')
                    updateAvailable = false
                    buildAppMenu()
                    if (app.isPackaged) {
                      mainWindow?.loadFile(path.join(__dirname, '../../renderer/index.html'))
                    } else {
                      mainWindow?.webContents.reload()
                    }
                    isHotReloading = false
                  } catch (e: any) {
                    isHotReloading = false
                    dialog.showErrorBox('Update Failed', e.message || 'Build failed')
                  }
                },
              },
              {
                label: 'Full Restart (kills sessions)',
                click: async () => {
                  if (app.isPackaged) {
                    const srcDir = path.join(os.homedir(), 'repos/roca')
                    try {
                      mainWindow?.webContents.send('app:rebuilding')
                      try {
                        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
                        execSync('git add -A', { cwd: srcDir, timeout: 10000 })
                        execSync(`git diff --cached --quiet || git commit -m "ROCA update ${timestamp}"`, { cwd: srcDir, timeout: 10000 })
                        execSync('git push origin main', { cwd: srcDir, timeout: 30000 })
                      } catch (_gitErr) {
                        console.error('[roca] Git push failed:', _gitErr)
                      }
                      execSync('source $HOME/.nvm/nvm.sh && rm -rf dist release && npm run pack', { cwd: srcDir, timeout: 180000, shell: '/bin/bash' })
                      const builtApp = path.join(srcDir, 'release/mac-arm64/ROCA.app')
                      const installedApp = '/Applications/ROCA.app'
                      execSync(`rm -rf "${installedApp}" && cp -R "${builtApp}" "${installedApp}"`)
                      ptyManager.killAll()
                      app.relaunch({ execPath: path.join(installedApp, 'Contents/MacOS/ROCA') })
                      app.exit(0)
                    } catch (e: any) {
                      dialog.showErrorBox('Update Failed', e.message || 'Build failed')
                    }
                  } else {
                    ptyManager.killAll()
                    app.relaunch()
                    app.exit(0)
                  }
                },
              },
            ]
          : []),
        { type: 'separator' },
        { role: 'services' as const },
        { type: 'separator' },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' },
        { role: 'quit' as const },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ═══════════════════════════════════════════
//  WINDOW CREATION
// ═══════════════════════════════════════════

function createWindow(): void {
  const iconPath = path.join(__dirname, '../../build/icon.png')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'ROCA',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      navigateOnDragDrop: false,
    },
  })

  // Disable macOS two-finger swipe back/forward navigation
  mainWindow.webContents.on('will-navigate', (e) => { e.preventDefault() })

  // Open external links (target="_blank") in the system browser instead of a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(iconPath)
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
    } catch {}
  }

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }
}

// ═══════════════════════════════════════════
//  UPLOAD HELPERS
// ═══════════════════════════════════════════

function getUploadDir(): string {
  const dir = path.join(app.getPath('userData'), 'uploads')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}


// ═══════════════════════════════════════════
//  SMART TASK MAKER (organize)
// ═══════════════════════════════════════════

async function runOrganize(week: string, dryRun: boolean): Promise<any> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  // Get open tasks
  const db = getDb()
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
  const tasks = db.prepare(
    `SELECT id, title, source, source_id, notes, priority, company_name, deal_name, status
     FROM tasks WHERE week = ? AND status IN (${placeholders}) ORDER BY source, id`
  ).all(week, ...ACTIVE_STATUSES) as any[]

  if (tasks.length < 2) {
    return { actions: [], stats: {} }
  }

  // Build summary — titles only, no notes (keeps prompt small)
  const lines = tasks.map((t: any) => {
    const company = t.company_name ? ` (${t.company_name})` : ''
    return `  #${t.id} [${t.source}] ${t.title}${company}`
  })

  const prompt = `You are a task deduplicator. Below are active tasks from a productivity app called ROCA. Sources:
- manual: user-created tasks (most intentional -- preserve these)
- crm: CRM tasks
- krisp: AI-extracted action items from Krisp meeting transcripts
- granola: AI-extracted action items from Granola meeting transcripts
- organized: previously organized tasks
- google_tasks, recurring: other synced sources

YOUR JOB: Find duplicates and clean up. Most tasks are fine -- only act when there's a clear issue.

TASKS:
${lines.join('\n')}

OUTPUT FORMAT -- respond with ONLY a JSON object:
{
  "actions": [
    {
      "type": "keep",
      "id": 123,
      "new_title": "optional cleaner title or null",
      "reason": "why"
    },
    {
      "type": "close",
      "id": 456,
      "reason": "duplicate of #123"
    }
  ]
}

RULES:
1. CLOSE a task only if it's clearly a duplicate of another open task (same intent, different wording)
2. When closing a duplicate, prefer keeping: manual > clarify > transcript > krisp > organized
3. Rename only if the title is genuinely unclear -- don't rename for style
4. Do NOT create new tasks -- only keep or close existing ones
5. If tasks look fine, return an empty actions array
6. Be conservative -- when in doubt, keep both tasks

Output ONLY valid JSON, no markdown fences, no explanation.`

  try {
    const claudeBin = findClaudeBinarySync()
    if (!claudeBin) throw new Error('Claude CLI not found')
    const env: Record<string, string> = { ...process.env as Record<string, string>, CLAUDECODE: '' }
    env.PATH = `/usr/local/bin:${env.PATH || '/usr/bin:/bin'}`

    // Pipe prompt via stdin — avoids arg escaping issues
    const { spawn } = require('child_process') as typeof import('child_process')
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn(claudeBin, ['--print'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { proc.kill(); reject(new Error('Organize timed out (120s)')) }, 120000)
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', (code: number) => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(`Claude exited ${code}: ${stderr.slice(0, 300)}`))
        else resolve(stdout.trim())
      })
      proc.on('error', (e: Error) => { clearTimeout(timer); reject(e) })
      proc.stdin.write(prompt)
      proc.stdin.end()
    })

    let cleaned = output
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.includes('\n') ? cleaned.split('\n').slice(1).join('\n') : cleaned
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3)
      cleaned = cleaned.trim()
    }

    const plan = JSON.parse(cleaned)
    const actions = plan.actions || []
    const stats = { kept: 0, closed: 0, renamed: 0 }
    const tasksById = new Map<number, any>()
    for (const t of tasks) tasksById.set(t.id, t)

    // Apply actions
    for (const action of actions) {
      const actionType = action.type
      if (actionType === 'keep') {
        const task = tasksById.get(action.id)
        if (!task) continue
        const newTitle = action.new_title
        if (!dryRun && newTitle && newTitle !== task.title) {
          db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(newTitle, action.id)
          stats.renamed++
        }
        stats.kept++
      } else if (actionType === 'close') {
        const task = tasksById.get(action.id)
        if (!task) continue
        if (!dryRun) {
          const reason = action.reason || ''
          db.prepare(
            "UPDATE tasks SET status = 'done', completed_at = ?, notes = ? WHERE id = ?"
          ).run(
            new Date().toISOString(),
            `[Dedup: ${reason}]\n${task.notes || ''}`,
            action.id
          )
        }
        stats.closed++
      }
    }

    return { actions, stats }
  } catch (e: any) {
    const errMsg = e.message || String(e)
    console.error('[organizer] Error:', errMsg)
    // Write debug log for diagnosis
    try {
      fs.writeFileSync('/tmp/roca-organize-error.log',
        `${new Date().toISOString()}\n${errMsg}\n${e.stack || ''}\n`)
    } catch { /* ignore */ }
    return { actions: [], stats: {}, error: errMsg }
  }
}

// ═══════════════════════════════════════════
//  ROCA CONTEXT HELPERS
// ═══════════════════════════════════════════

function getRocaDir(): string {
  // Allow external intelligence directory (e.g., a shared project repo)
  // so prompt files, journal, and skills live outside the app bundle.
  // Falls back to the bundled roca/ directory for standalone/GitHub use.
  const custom = process.env.ROCA_INTELLIGENCE_DIR
  if (custom && fs.existsSync(custom)) return custom
  return app.isPackaged
    ? path.join(process.resourcesPath, 'roca')
    : path.join(__dirname, '../../roca')
}

/** Read a file from the roca/ directory, returning empty string if missing. */
function readRocaFile(filename: string): string {
  try {
    const p = path.join(getRocaDir(), filename)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
  } catch { return '' }
}

/**
 * Match a task to the best ROCA skill file based on the journal's pattern table.
 * Returns the skill content or empty string if no match.
 */
function matchSkillForTask(task: { title: string; notes?: string | null }): { name: string; content: string } | null {
  const text = `${task.title} ${task.notes || ''}`.toLowerCase()
  const skillsDir = path.join(getRocaDir(), 'skills')
  if (!fs.existsSync(skillsDir)) return null

  // Pattern keywords → skill filename (from journal.md pattern table)
  const patterns: [string[], string][] = [
    [['follow-up', 'followup', 'discovery', 'fit', 'founder'], 'email-founder-followup-fit'],
    [['follow-up', 'followup', 'pass', 'not a fit'], 'email-founder-followup-pass'],
    [['m&a', 'advisor', 'banker', 'one-pager'], 'email-ma-advisor-followup'],
    [['cold outreach', 'cold email', 'first touch', 'campaign messaging'], 'email-cold-outreach'],
    [['campaign followup', 'heyreach', '2nd touch', '3rd touch'], 'email-campaign-followup'],
    [['pass on', 'passing on', 'communicating a pass'], 'email-pass'],
    [['vai tracker', 'vaicorp', 'weekly kr'], 'sheets-vai-tracker'],
    [['google sheet', 'sheet update', 'spreadsheet'], 'sheets-general-update'],
    [['how many', 'show me', 'which companies', 'metrics', 'pipeline'], 'crm-query-metrics'],
    [['meeting count', 'how many meetings'], 'crm-meeting-count'],
    [['update clarify', 'change tier', 'add to crm', 'crm update'], 'crm-write-update'],
    [['bulk enrich', 'enrich companies', 'bulk contact'], 'crm-bulk-enrichment'],
    [['bulk acquisition', 'acquisition audit'], 'crm-bulk-acquisition-audit'],
    [['find companies using', 'coresignal', 'api exploration'], 'research-api-exploration'],
    [['scrape', 'company database', 'external database'], 'research-external-database'],
    [['pull logos', 'mining', 'prospect source'], 'research-prospect-source-mining'],
    [['vertical gap', 'gap analysis'], 'research-vertical-gap-analysis'],
    [['conference', 'trade show', 'event evaluation'], 'research-conference-evaluation'],
    [['vertical seed', 'prospecting vertical'], 'prospecting-vertical-seed'],
    [['remind me', 'follow up with', 'set reminder'], 'calendar-set-reminder'],
    [['meeting brief', 'prep calendar', 'weekly briefs'], 'calendar-meeting-briefs'],
    [['prep for meeting', 'prep for call', 'founder call'], 'prep-founder-call'],
    [['prep for advisor', 'banker meeting', 'advisor call'], 'prep-ma-advisor-call'],
    [['cold call', 'call prep', 'outreach call'], 'outreach-cold-call-prep'],
    [['reeval', 're-eval', 'agent review'], 'agent-reeval-review'],
    [['relaunch', 'daemon', 'agent relaunch'], 'agent-relaunch-daemon'],
  ]

  for (const [keywords, skillName] of patterns) {
    if (keywords.some(kw => text.includes(kw))) {
      const skillPath = path.join(skillsDir, `${skillName}.md`)
      if (fs.existsSync(skillPath)) {
        return { name: skillName, content: fs.readFileSync(skillPath, 'utf-8') }
      }
    }
  }
  return null
}

/**
 * Strip ANSI escape codes from terminal output to produce clean text.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')         // Character set selection
    .replace(/\x1b[#%][A-Z0-9]/g, '')         // Other escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // Control chars (keep \n \r \t)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Generate a concise session summary by running Claude headless.
 * Returns the summary text, or null on failure.
 */
async function generateSessionSummary(transcript: string, taskTitle: string): Promise<string | null> {
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)

  // Truncate to keep the prompt reasonable
  const truncated = transcript.slice(-30000)

  const prompt = `You are summarizing a Claude Code terminal session for future context.

TASK: ${taskTitle}

TERMINAL TRANSCRIPT (most recent portion):
${truncated}

Produce a concise summary (3-8 bullet points) of:
1. What was discussed/requested
2. What actions were taken (files changed, commands run, API calls made)
3. What was accomplished or left unfinished
4. Any decisions or preferences the user expressed

Be factual and specific. Use past tense. Output ONLY the bullet points, no preamble.`

  try {
    const claudeBin = findClaudeBinarySync()
    if (!claudeBin) throw new Error('Claude CLI not found')
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    env.PATH = `/usr/local/bin:${env.PATH || '/usr/bin:/bin'}`

    const { stdout } = await execFileAsync(claudeBin, ['--print', '-p', prompt], {
      timeout: 60000,
      env,
    })
    return stdout.trim() || null
  } catch (e) {
    console.error('[session-summary] Failed to generate summary:', e)
    return null
  }
}

/**
 * Build task-specific context markdown.
 * Includes: task details, CRM enrichment, matched skill, delegate history,
 * and previous session summaries for conversation continuity.
 */
function buildTaskContext(task: any, taskId: number, enrichmentSummary?: string): string {
  let md = ''

  // ROCA identity — injected so every session understands it's running inside ROCA
  const rocaPrompt = readRocaFile('roca-prompt.md')
  if (rocaPrompt) {
    md += `${rocaPrompt}\n\n---\n\n`
  }

  // Task details
  md += `# Current Task: ${task.title}\n\n`
  md += `**Status:** ${task.status} | **Priority:** ${task.priority} | **Source:** ${task.source}\n`
  if (task.company_name) md += `**Company:** ${task.company_name}\n`
  if (task.deal_name) md += `**Deal:** ${task.deal_name}\n`
  if (task.due_date) md += `**Due:** ${task.due_date}\n`
  md += `\n---\n\n`

  if (task.notes) {
    // Resolve relative /uploads/ paths in notes to absolute paths so Claude can read them
    const uploadsDir = getUploadDir()
    const resolvedNotes = task.notes.replace(
      /\(\/uploads\/([^)]+)\)/g,
      (_match: string, filename: string) => `(${path.join(uploadsDir, filename)})`
    )
    md += `## Notes\n\n${resolvedNotes}\n\n`
  }

  // Uploaded files — expose absolute paths so the terminal session can read them
  const uploads = getUploadsForTask(taskId)
  if (uploads.length > 0) {
    const uploadsDir = getUploadDir()
    md += `## Uploaded Files\n\n`
    md += `These files have been attached to this task. Use the absolute paths below to read or reference them.\n\n`
    for (const u of uploads) {
      const absPath = path.join(uploadsDir, u.stored_name)
      md += `- \`${absPath}\` — ${u.filename} (${u.mime_type}, ${(u.size / 1024).toFixed(1)} KB)\n`
    }
    md += `\n`
  }

  // Clarify enrichment (company, person, deal, meetings from CRM)
  if (enrichmentSummary) {
    md += `## CRM Context\n\n${enrichmentSummary}\n\n---\n\n`
  }

  // Matched skill
  const skill = matchSkillForTask(task)
  if (skill) {
    md += `## Matched Skill: ${skill.name}\n\n${skill.content}\n\n---\n\n`
  }

  // Delegate analysis (from previous sessions)
  const cached = getCachedDelegate(taskId) as any
  if (cached?.plan) md += `## Analysis\n\n${cached.plan}\n\n`

  // Previous session history — most recent summaries for conversation continuity
  const sessions = getTaskSessions(taskId, 5)
  const sessionsWithSummary = sessions.filter(s => s.summary).reverse() // chronological
  if (sessionsWithSummary.length > 0) {
    md += `## Previous Sessions\n\n`
    for (const s of sessionsWithSummary) {
      const date = new Date(s.started_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
      md += `### Session (${date})\n\n${s.summary}\n\n`
    }
    md += `---\n\n`
  }

  // Conversation history (delegate messages)
  const msgs = getDelegateMessages(taskId) as any[]
  if (msgs && msgs.length > 0) {
    md += `## Conversation History\n\n`
    for (const m of msgs.slice(-20)) {
      md += `**${m.role === 'user' ? 'User' : 'ROCA'}:** ${m.content}\n\n`
    }
  }

  return md
}

/**
 * Build assistant context markdown (desktop-control-focused, no task).
 * Includes ROCA identity, desktop control capabilities, journal, and priorities.
 */
function buildAssistantContext(): string {
  let md = ''

  const rocaPrompt = readRocaFile('roca-prompt.md')
  if (rocaPrompt) {
    md += `${rocaPrompt}\n\n---\n\n`
  }

  md += `# ROCA Assistant — Desktop Control Mode\n\n`
  md += `You are the user's hands-on desktop assistant running inside the ROCA app. You have full control over their Mac.\n\n`
  md += `## Capabilities\n\n`
  md += `- **AppleScript / osascript**: Control any macOS app (Maps, Calendar, Finder, Safari, etc.)\n`
  md += `- **Shell commands**: Full terminal access — run scripts, manage files, query APIs\n`
  md += `- **Application control**: Open, close, switch between apps via \`open -a\` or AppleScript\n`
  md += `- **System info**: Date/time, disk usage, network, running processes\n`
  md += `- **File operations**: Read, write, move, search files anywhere on the system\n`
  md += `- **Web browsing**: Use \`open\` to launch URLs, or curl for API calls\n`
  md += `- **Clipboard**: Read/write clipboard via \`pbcopy\`/\`pbpaste\`\n\n`
  md += `When the user asks you to do something on their computer, just do it. Use the tools available — don't ask for confirmation on routine operations.\n\n`
  md += `---\n\n`

  const journal = readRocaFile('journal.md')
  if (journal) {
    md += `## Journal\n\n${journal}\n\n---\n\n`
  }

  const priorities = readRocaFile('priorities.md')
  if (priorities) {
    md += `## Current Priorities\n\n${priorities}\n\n`
  }

  return md
}

// ═══════════════════════════════════════════
//  IPC HANDLERS
// ═══════════════════════════════════════════

function registerIpcHandlers(): void {
  // ── Environment ──
  ipcMain.handle('env:get', (_, key: string) => {
    const allowed = ['ELEVENLABS_API_KEY', 'CLARIFY_APP_URL']
    return allowed.includes(key) ? process.env[key] || null : null
  })

  // ── Debug ──
  ipcMain.handle('debug:write', (_, content: string) => {
    const fs = require('fs')
    fs.writeFileSync('/tmp/roca-voice-debug.txt', content, 'utf8')
    return true
  })

  // Voice session diagnostics — append-only log + screenshots
  const voiceDiagDir = path.join(app.getPath('userData'), 'voice-diagnostics')
  ipcMain.handle('voice:log-session', (_, entry: {
    event: string; state: string; taskId: number | null; tab: string;
    error?: string; spokenText?: string; transcript?: string;
  }) => {
    const fs = require('fs')
    const { execSync } = require('child_process')
    if (!fs.existsSync(voiceDiagDir)) fs.mkdirSync(voiceDiagDir, { recursive: true })
    const ts = new Date().toISOString()
    const line = JSON.stringify({ ts, ...entry })
    fs.appendFileSync(path.join(voiceDiagDir, 'sessions.jsonl'), line + '\n')

    // Take screenshot on errors or session-end for review
    if (entry.event === 'error' || entry.event === 'session-end') {
      const screenshotFile = path.join(voiceDiagDir, `${ts.replace(/[:.]/g, '-')}_${entry.event}.png`)
      try {
        execSync(`screencapture -x "${screenshotFile}"`, { timeout: 5000 })
      } catch {}
    }
    return true
  })

  // ── Tasks ──
  ipcMain.handle('db:tasks:list', (_, opts?: {
    week?: string; status?: string; source?: string; priority?: string
  }) => {
    return getTasks(opts?.week, opts?.status, opts?.source, opts?.priority)
  })

  ipcMain.handle('db:tasks:get', (_, taskId: number) => getTaskById(taskId))

  ipcMain.handle('db:tasks:create', (_, task: {
    title: string; source?: string; source_id?: string;
    priority?: string; due_date?: string;
    company_name?: string; deal_name?: string;
    notes?: string; week?: string; project_id?: string | null;
  }) => {
    const id = createTask(task)
    return { id }
  })

  ipcMain.handle('db:tasks:duplicate', (_, sourceTaskId: number) => {
    const source = getTaskById(sourceTaskId) as any
    if (!source) return { id: null }

    // Create new task — always manual source (so it's triaged) and current week
    const newId = createTask({
      title: source.title,
      source: 'manual',
      source_id: null,
      notes: source.notes,
      priority: source.priority,
      company_name: source.company_name,
      deal_name: source.deal_name,
      due_date: source.due_date,
      week: currentIsoWeek(),
      project_id: source.project_id,
    })

    // Copy folder assignment
    if (source.folder_id) {
      setTaskFolder(newId, source.folder_id)
    }

    // Copy PTY scrollback so new terminal shows full history
    const scrollback = loadPtyScrollback(`task-${sourceTaskId}`)
    if (scrollback) {
      savePtyScrollbackBatch([{ ptyId: `task-${newId}`, scrollback }])
    }

    // Also capture in-memory scrollback from running PTY (may be more recent than disk)
    const liveScrollback = ptyManager.getScrollback(`task-${sourceTaskId}`)
    if (liveScrollback && liveScrollback.length > (scrollback?.length || 0)) {
      savePtyScrollbackBatch([{ ptyId: `task-${newId}`, scrollback: liveScrollback }])
    }

    // Copy session summaries to new task for context continuity
    const sessions = getTaskSessions(sourceTaskId, 10)
    for (const s of sessions) {
      if (s.summary) {
        const sid = createTaskSession(newId)
        endTaskSession(sid, s.transcript)
        saveSessionSummary(sid, s.summary)
      }
    }

    // Copy delegate messages for conversation history in context
    const msgs = getDelegateMessages(sourceTaskId) as any[]
    for (const m of msgs) {
      addDelegateMessage(newId, m.role, m.content, m.cost || 0, m.turns || 0)
    }

    return { id: newId }
  })

  ipcMain.handle('db:tasks:toggle', async (_, taskId: number) => {
    const task = toggleTask(taskId)
    if (task) {
      if (task.source === 'clarify' && task.source_id) {
        pushTaskToClarify(task.source_id, task.status).catch(console.error)
      } else if (task.source === 'google_tasks' && task.source_id) {
        pushTaskToGoogleTasks(task.source_id, task.status).catch(console.error)
      }
      // Learn from completed tasks (background — don't block toggle)
      if (task.status === 'done') {
        // Kill any live terminal session attached to this task
        const ptyId = `task-${taskId}`
        if (ptyManager.has(ptyId)) {
          ptyManager.killWithTmux(ptyId)
        }

        const msgs = getDelegateMessages(taskId) as any[]
        if (msgs && msgs.length > 0) {
          learnFromFeedback('Task completed', task.title, msgs).catch(e =>
            console.error('[learn] Background learning failed:', e)
          )
        }
      }
    }
    return task
  })

  ipcMain.handle('db:tasks:update-notes', (_, taskId: number, notes: string) => {
    updateTaskNotes(taskId, notes)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:update-fields', (_, taskId: number, fields: Record<string, unknown>) => {
    updateTaskFields(taskId, fields)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:update-status', (_, taskId: number, status: string) => {
    const ok = updateTaskStatus(taskId, status)
    if (ok) {
      markTaskTriaged(taskId)
      // Notify on notable status transitions
      const task = getTaskById(taskId) as any
      if (task && (status === 'needs_input' || status === 'blocked')) {
        const label = status === 'needs_input' ? 'Needs your input' : 'Blocked'
        showTaskNotification(task.title, label)
      }
      // Learn from completed tasks (background)
      if (status === 'done') {
        const msgs = getDelegateMessages(taskId) as any[]
        if (msgs && msgs.length > 0) {
          const doneTask = getTaskById(taskId) as any
          if (doneTask) {
            learnFromFeedback('Task completed', doneTask.title, msgs).catch(e =>
              console.error('[learn] Background learning failed:', e)
            )
          }
        }
      }
    }
    return { ok }
  })

  ipcMain.handle('db:tasks:reorder', (_, taskIds: number[]) => {
    reorderTasks(taskIds)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:toggle-urgent', (_, taskId: number) => {
    const task = getTaskById(taskId)
    if (!task) return { ok: false }
    const newPriority = task.priority === 'urgent' ? 'medium' : 'urgent'
    updateTaskFields(taskId, { priority: newPriority })
    return { ok: true, priority: newPriority }
  })

  ipcMain.handle('db:tasks:set-in-progress', (_, taskId: number) => {
    setTaskInProgress(taskId)
    return { ok: true }
  })

  ipcMain.handle('db:tasks:schedule', (_, taskId: number, scheduledAt: string | null) => {
    if (scheduledAt) {
      updateTaskFields(taskId, { scheduled_at: scheduledAt })
    } else {
      const db = getDb()
      db.prepare('UPDATE tasks SET scheduled_at = NULL WHERE id = ?').run(taskId)
    }
    return getTaskById(taskId)
  })

  // ── Recurring ──
  ipcMain.handle('db:tasks:make-recurring', (_, taskId: number) => makeTaskRecurring(taskId))
  ipcMain.handle('db:tasks:unmake-recurring', (_, taskId: number) => {
    unmakeTaskRecurring(taskId)
    return { ok: true }
  })
  ipcMain.handle('db:tasks:is-recurring', (_, title: string) => isTaskRecurring(title))
  ipcMain.handle('db:recurring:list', () => getRecurringTasks())
  ipcMain.handle('db:recurring:add', (_, title: string, priority?: string, company_name?: string, deal_name?: string, notes?: string) => {
    return addRecurringTask(title, priority, company_name, deal_name, notes)
  })
  ipcMain.handle('db:recurring:remove', (_, recurringId: number) => {
    removeRecurringTask(recurringId)
    return { ok: true }
  })
  ipcMain.handle('db:recurring:spawn', (_, week?: string) => {
    return { count: spawnRecurringForWeek(week) }
  })

  // ── Completed in week ──
  ipcMain.handle('db:completed-in-week', (_, week?: string) => getCompletedInWeek(week))

  // ── Task flags ──
  ipcMain.handle('db:tasks:populate-flags', (_, tasks: any[]) => populateTaskFlags(tasks))
  ipcMain.handle('db:tasks:open-unfoldered', (_, opts?: { week?: string; source?: string; priority?: string }) => {
    const tasks = getOpenUnfoldered(opts?.week, opts?.source, opts?.priority)
    return populateTaskFlags(tasks)
  })

  // ── Week ──
  ipcMain.handle('db:week:get', (_, week?: string) => getWeekData(week))
  ipcMain.handle('db:week:challenges', (_, week: string, text: string) => {
    updateChallenges(week, text)
    return { ok: true }
  })
  ipcMain.handle('db:week:meetings', (_, week: string, count: number) => {
    updateMeetingsHeld(week, count)
    return { ok: true }
  })
  ipcMain.handle('db:week:current', () => currentIsoWeek())

  // ── Inbox ──
  ipcMain.handle('db:inbox:list', (_, week?: string) => getInboxTasks(week))
  ipcMain.handle('db:inbox:count', (_, week?: string) => getInboxCount(week))
  ipcMain.handle('db:inbox:triage', (_, taskId: number) => {
    markTaskTriaged(taskId)
    return { ok: true }
  })

  // ── Folders ──
  ipcMain.handle('db:folders:list', (_, opts?: { week?: string; source?: string; priority?: string }) => {
    return getFolders(opts?.week, opts?.source, opts?.priority)
  })
  ipcMain.handle('db:folders:create', (_, name: string, color?: string) => {
    return { id: createFolder(name, color) }
  })
  ipcMain.handle('db:folders:rename', (_, folderId: number, name: string) => {
    renameFolder(folderId, name)
    return { ok: true }
  })
  ipcMain.handle('db:folders:toggle-collapse', (_, folderId: number) => {
    toggleFolderCollapse(folderId)
    return { ok: true }
  })
  ipcMain.handle('db:folders:delete', (_, folderId: number) => {
    deleteFolder(folderId)
    return { ok: true }
  })
  ipcMain.handle('db:folders:set-task-folder', (_, taskId: number, folderId?: number | null) => {
    setTaskFolder(taskId, folderId)
    return { ok: true }
  })
  ipcMain.handle('db:folders:update-color', (_, folderId: number, color: string) => {
    updateFolderColor(folderId, color)
    return { ok: true }
  })
  ipcMain.handle('db:folders:reorder', (_, folderIds: number[]) => {
    reorderFolders(folderIds)
    return { ok: true }
  })
  ipcMain.handle('db:folders:colors', () => FOLDER_COLORS)

  // ── Delegate cache ──
  ipcMain.handle('db:delegate:get-cache', (_, taskId: number) => getCachedDelegate(taskId))
  ipcMain.handle('db:delegate:save-cache', (
    _, taskId: number, plan: string, context: string,
    cost: number, turns: number, error: string | null, sessionId?: string | null
  ) => {
    saveDelegateCache(taskId, plan, context, cost, turns, error, sessionId)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:clear-cache', (_, taskId: number) => {
    clearDelegateCache(taskId)
    return { ok: true }
  })

  // ── Delegate executions ──
  ipcMain.handle('db:delegate:create-execution', (_, taskId: number) => {
    return { id: createExecution(taskId) }
  })
  ipcMain.handle('db:delegate:update-execution', (
    _, execId: number, status: string, output?: string | null, cost?: number
  ) => {
    updateExecution(execId, status, output, cost)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:get-execution', (_, execId: number) => getExecution(execId))
  ipcMain.handle('db:delegate:latest-execution', (_, taskId: number) => getLatestExecution(taskId))

  // ── Delegate messages ──
  ipcMain.handle('db:delegate:add-message', (
    _, taskId: number, role: string, content: string, cost?: number, turns?: number
  ) => {
    addDelegateMessage(taskId, role, content, cost || 0, turns || 0)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:get-messages', (_, taskId: number) => getDelegateMessages(taskId))
  ipcMain.handle('db:delegate:clear-messages', (_, taskId: number) => {
    clearDelegateMessages(taskId)
    return { ok: true }
  })
  ipcMain.handle('db:delegate:message-count', (_, taskId: number, role?: string) => {
    return getDelegateMessageCount(taskId, role)
  })

  // ── Delegate AI (enrichment + Claude headless) ──
  ipcMain.handle('delegate:analyze', async (_, taskId: number, userContext?: string) => {
    const task = getTaskById(taskId) as any
    if (!task) return { error: 'Task not found' }
    try {
      const result = await enrichAndAnalyze(task, userContext)
      // Persist to cache
      saveDelegateCache(
        taskId, result.plan || '', result.context || '',
        result.cost, result.turns, result.error || null, result.sessionId || null
      )
      return result
    } catch (e: any) {
      return { plan: '', context: '', cost: 0, turns: 0, error: e.message || String(e) }
    }
  })

  ipcMain.handle('delegate:refine', async (_, taskId: number, feedback: string) => {
    const task = getTaskById(taskId) as any
    if (!task) return { error: 'Task not found' }
    const cached = getCachedDelegate(taskId) as any
    const msgs = getDelegateMessages(taskId) as any[]
    try {
      const result = await refineOutput(
        task,
        cached?.plan || '',
        cached?.context || '',
        msgs || [],
        feedback,
        cached?.session_id || null
      )
      // Update cache with refined result
      if (result.plan) {
        saveDelegateCache(
          taskId, result.plan, result.context || cached?.context || '',
          (cached?.cost || 0) + result.cost, (cached?.turns || 0) + result.turns,
          result.error || null, result.sessionId || cached?.session_id || null
        )
      }
      return result
    } catch (e: any) {
      return { plan: '', context: '', cost: 0, turns: 0, error: e.message || String(e) }
    }
  })

  ipcMain.handle('delegate:execute', async (_, taskId: number) => {
    const task = getTaskById(taskId) as any
    if (!task) return { error: 'Task not found' }
    const cached = getCachedDelegate(taskId) as any
    if (!cached?.plan) return { error: 'No plan to execute' }
    try {
      const execId = createExecution(taskId)
      const result = await executePlan(task, cached.plan, cached.context || '')
      updateExecution(execId, result.output ? 'done' : 'error', result.output, result.cost)
      return { ...result, execId }
    } catch (e: any) {
      return { output: '', cost: 0, error: e.message || String(e) }
    }
  })

  ipcMain.handle('delegate:learn', async (_, taskId: number) => {
    const task = getTaskById(taskId) as any
    if (!task) return { ok: false }
    const msgs = getDelegateMessages(taskId) as any[]
    try {
      await learnFromFeedback('Task completed', task.title, msgs || [])
      return { ok: true }
    } catch (e: any) {
      console.error('[delegate:learn] Error:', e)
      return { ok: false, error: e.message }
    }
  })

  // ── Uploads ──
  ipcMain.handle('db:uploads:save', (
    _, taskId: number, fileData: { buffer: Uint8Array | Buffer; filename: string; mimeType: string }
  ) => {
    const ext = path.extname(fileData.filename).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { ok: false, error: `File type ${ext} not allowed` }
    }
    // Ensure we have a proper Buffer for fs operations
    const buf = Buffer.isBuffer(fileData.buffer) ? fileData.buffer : Buffer.from(fileData.buffer)
    if (buf.length > MAX_UPLOAD_SIZE) {
      return { ok: false, error: 'File too large (max 10 MB)' }
    }

    const storedName = `${randomHex(32)}${ext}`
    const uploadDir = getUploadDir()
    fs.writeFileSync(path.join(uploadDir, storedName), buf)

    const uploadId = saveUpload(
      taskId, fileData.filename, storedName,
      fileData.mimeType, buf.length
    )
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)

    // Regenerate task context file so Claude session has absolute paths to new uploads
    try {
      const task = getTaskById(taskId) as any
      if (task) {
        const contextDir = path.join(app.getPath('userData'), 'task-contexts')
        const contextPath = path.join(contextDir, `task-${taskId}.md`)
        if (fs.existsSync(contextPath)) {
          const md = buildTaskContext(task, taskId)
          fs.writeFileSync(contextPath, md)
          console.log(`[uploads] Regenerated context for task ${taskId} with ${getUploadsForTask(taskId).length} uploads`)
        }
      }
    } catch (e) {
      console.error('[uploads] Failed to regenerate context after upload:', e)
    }

    return {
      ok: true,
      upload_id: uploadId,
      filename: fileData.filename,
      stored_name: storedName,
      url: `/uploads/${storedName}`,
      is_image: isImage,
      size: buf.length,
    }
  })
  ipcMain.handle('db:uploads:for-task', (_, taskId: number) => getUploadsForTask(taskId))
  ipcMain.handle('db:uploads:for-message', (_, messageId: number) => getUploadsForMessage(messageId))
  ipcMain.handle('db:uploads:pending', (_, taskId: number) => getPendingUploads(taskId))
  ipcMain.handle('db:uploads:link-to-message', (_, taskId: number, messageId: number) => {
    linkUploadsToMessage(taskId, messageId)
    return { ok: true }
  })
  ipcMain.handle('db:uploads:serve', (_, filename: string) => {
    const filepath = path.join(getUploadDir(), filename)
    if (!fs.existsSync(filepath)) return null
    return fs.readFileSync(filepath)
  })
  ipcMain.handle('db:uploads:delete', (_, uploadId: number) => {
    const storedName = deleteUpload(uploadId)
    if (!storedName) return { ok: false, error: 'Upload not found' }
    const filepath = path.join(getUploadDir(), storedName)
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
    return { ok: true }
  })
  ipcMain.handle('db:uploads:serve-path', (_, storedName: string) => {
    const filepath = path.join(getUploadDir(), storedName)
    if (!fs.existsSync(filepath)) return null
    return { path: filepath }
  })
  ipcMain.handle('db:uploads:convert-pdf', async (_, storedName: string) => {
    const uploadDir = getUploadDir()
    const srcPath = path.join(uploadDir, storedName)
    if (!fs.existsSync(srcPath)) return null
    const pdfBase = storedName.replace(/\.[^.]+$/, '')
    const pdfPath = path.join(uploadDir, pdfBase + '.pdf')
    // Return cached conversion if exists AND source hasn't been updated
    if (fs.existsSync(pdfPath)) {
      const srcMtime = fs.statSync(srcPath).mtimeMs
      const pdfMtime = fs.statSync(pdfPath).mtimeMs
      if (pdfMtime >= srcMtime) return { path: pdfPath }
      // Source is newer — delete stale cache and reconvert
      fs.unlinkSync(pdfPath)
    }
    // Find soffice binary
    const soffice = [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/local/bin/soffice',
      '/opt/homebrew/bin/soffice',
    ].find(p => fs.existsSync(p))
    if (!soffice) return { error: 'LibreOffice not found — install via: brew install --cask libreoffice' }
    return new Promise(resolve => {
      execFile(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', uploadDir, srcPath],
        { timeout: 30000 },
        (err) => {
          if (err) return resolve({ error: err.message || 'LibreOffice conversion failed' })
          if (fs.existsSync(pdfPath)) return resolve({ path: pdfPath })
          resolve({ error: 'Conversion completed but PDF not found' })
        })
    })
  })
  ipcMain.handle('shell:show-item', (_, storedName: string) => {
    const filepath = path.join(getUploadDir(), storedName)
    if (fs.existsSync(filepath)) shell.showItemInFolder(filepath)
  })

  // Convert DOCX to styled HTML using mammoth (preserves structure, headings, lists, tables, images)
  ipcMain.handle('docx:to-html', async (_, storedName: string) => {
    const srcPath = path.join(getUploadDir(), storedName)
    if (!fs.existsSync(srcPath)) return { error: 'File not found' }
    try {
      const mammoth = await import('mammoth')
      const result = await mammoth.convertToHtml(
        { path: srcPath },
        { convertImage: mammoth.images.imgElement((image) => {
          return image.read('base64').then((data) => ({
            src: `data:${image.contentType};base64,${data}`,
          }))
        })},
      )
      return { html: result.value }
    } catch (e: any) {
      return { error: e.message || 'DOCX conversion failed' }
    }
  })

  // ── Scheduled tasks ──
  ipcMain.handle('db:scheduled:due', () => getScheduledDueTasks())
  ipcMain.handle('db:scheduled:clear', (_, taskId: number) => {
    clearScheduledAt(taskId)
    return { ok: true }
  })

  // ── Sync ──
  ipcMain.handle('sync:all', async () => {
    const count = await syncAll()
    return { count }
  })
  ipcMain.handle('sync:reconcile', async () => {
    const count = await reconcileAll()
    return { count }
  })

  // ── Organize (smart task maker) ──
  ipcMain.handle('organize:preview', async (_, week?: string) => {
    return await runOrganize(week || currentIsoWeek(), true)
  })
  ipcMain.handle('organize:apply', async (_, week?: string) => {
    return await runOrganize(week || currentIsoWeek(), false)
  })


  // ── Transcript processing ──
  ipcMain.handle('sync:process-transcript', async (
    _, meetingId: string, meetingName: string, transcriptText: string, meetingDate?: string
  ) => {
    const count = await processTranscript(meetingId, meetingName, transcriptText, meetingDate || '')
    return { created: count }
  })

  // ── Journal data ──
  ipcMain.handle('journal:get', () => {
    const journalContent = readRocaFile('journal.md') || '(No journal yet)'
    const promptContent = readRocaFile('roca-prompt.md') || '(No prompt file)'
    return { journal: journalContent, prompt: promptContent }
  })

  // ── Constants ──
  ipcMain.handle('constants:status-labels', () => STATUS_LABELS)
  ipcMain.handle('constants:active-statuses', () => ACTIVE_STATUSES)
  ipcMain.handle('constants:folder-colors', () => FOLDER_COLORS)

  // ── Health ──
  ipcMain.handle('health', () => ({ status: 'ok', pid: process.pid }))

  // ── App restart (with rebuild if packaged) ──
  // Hot-reload: rebuild renderer and reload BrowserWindow — PTYs survive
  ipcMain.handle('app:restart', async () => {
    isHotReloading = true
    if (app.isPackaged) {
      const srcDir = path.join(os.homedir(), 'repos/roca')
      try {
        mainWindow?.webContents.send('app:rebuilding')
        // Git commit & push before building
        try {
          const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
          execSync('git add -A', { cwd: srcDir, timeout: 10000 })
          execSync(`git diff --cached --quiet || git commit -m "ROCA update ${timestamp}"`, { cwd: srcDir, timeout: 10000 })
          execSync('git push origin main', { cwd: srcDir, timeout: 30000 })
        } catch (_gitErr) {
          console.error('[roca] Git push failed:', _gitErr)
        }
        // Only rebuild renderer (fast) — not a full pack
        execSync('source $HOME/.nvm/nvm.sh && npm run build', { cwd: srcDir, timeout: 60000, shell: '/bin/bash' })
        // Copy fresh renderer build into the installed app
        const installedRenderer = '/Applications/ROCA.app/Contents/Resources/app/dist/renderer'
        const builtRenderer = path.join(srcDir, 'dist/renderer')
        execSync(`rm -rf "${installedRenderer}" && cp -R "${builtRenderer}" "${installedRenderer}"`)
        // Also update compiled main process JS
        const installedMain = '/Applications/ROCA.app/Contents/Resources/app/dist/main'
        const builtMain = path.join(srcDir, 'dist/main')
        execSync(`rm -rf "${installedMain}" && cp -R "${builtMain}" "${installedMain}"`)
        // Reload window — PTYs stay alive, renderer reconnects
        console.log('[roca] Hot-reload: renderer updated, reloading window (PTYs preserved)')
        updateAvailable = false
        buildAppMenu()
        mainWindow?.loadFile(path.join(__dirname, '../../renderer/index.html'))
        isHotReloading = false
      } catch (e: any) {
        isHotReloading = false
        dialog.showErrorBox('Update Failed', e.message || 'Build failed')
      }
    } else {
      // Dev mode: just reload the window (Vite serves fresh code)
      console.log('[roca] Dev hot-reload: reloading window (PTYs preserved)')
      updateAvailable = false
      buildAppMenu()
      mainWindow?.webContents.reload()
    }
  })

  // Full restart — for main process changes that require a process restart
  ipcMain.handle('app:full-restart', async () => {
    if (app.isPackaged) {
      const srcDir = path.join(os.homedir(), 'repos/roca')
      try {
        mainWindow?.webContents.send('app:rebuilding')
        try {
          const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
          execSync('git add -A', { cwd: srcDir, timeout: 10000 })
          execSync(`git diff --cached --quiet || git commit -m "ROCA update ${timestamp}"`, { cwd: srcDir, timeout: 10000 })
          execSync('git push origin main', { cwd: srcDir, timeout: 30000 })
        } catch (_gitErr) {
          console.error('[roca] Git push failed:', _gitErr)
        }
        execSync('source $HOME/.nvm/nvm.sh && rm -rf dist release && npm run pack', { cwd: srcDir, timeout: 180000, shell: '/bin/bash' })
        const builtApp = path.join(srcDir, 'release/mac-arm64/ROCA.app')
        const installedApp = '/Applications/ROCA.app'
        execSync(`rm -rf "${installedApp}" && cp -R "${builtApp}" "${installedApp}"`)
        ptyManager.killAll()
        app.relaunch({ execPath: path.join(installedApp, 'Contents/MacOS/ROCA') })
        app.exit(0)
      } catch (e: any) {
        dialog.showErrorBox('Update Failed', e.message || 'Build failed')
      }
    } else {
      ptyManager.killAll()
      app.relaunch()
      app.exit(0)
    }
  })

  // ── Krisp webhook data (ingest from external source) ──
  ipcMain.handle('webhook:krisp', async (_, payload: any) => {
    // Write to krisp-staging.json and sync — use ROCA's own data dir
    const stateDir = process.env.KRISP_STATE_DIR || app.getPath('userData')
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })

    const stagingPath = path.join(stateDir, 'krisp-staging.json')
    let staging: any = { fetched_at: '', total_pending: 0, meetings: {} }
    if (fs.existsSync(stagingPath)) {
      try { staging = JSON.parse(fs.readFileSync(stagingPath, 'utf-8')) } catch { /* ignore */ }
    }

    const meetingId = payload.meeting_id || payload.meetingId || ''
    const meetingName = payload.meeting_title || payload.meetingTitle || payload.title || 'Unknown meeting'
    const meetingDate = payload.start_time || payload.startTime || payload.meeting_date || new Date().toISOString()

    let rawItems = payload.action_items || payload.actionItems || []
    if (!rawItems.length && payload.data) {
      const data = payload.data
      if (typeof data === 'object') {
        rawItems = data.action_items || data.actionItems || []
      }
    }

    if (meetingId && rawItems.length > 0) {
      const actionItems = rawItems.map((item: any, idx: number) => {
        if (typeof item === 'string') {
          return { id: `${meetingId}_${idx}`, title: item, assignee: null, completed: false }
        }
        return {
          id: item.id || `${meetingId}_${idx}`,
          title: item.title || item.text || item.description || '',
          assignee: item.assignee || item.assigned_to || null,
          completed: item.completed || item.is_completed || false,
        }
      })

      staging.meetings[meetingId] = {
        meeting_name: meetingName,
        meeting_date: meetingDate,
        action_items: actionItems,
      }
      staging.fetched_at = new Date().toISOString()
      staging.total_pending = Object.values(staging.meetings as Record<string, any>).reduce(
        (sum: number, m: any) => sum + (m.action_items || []).filter((ai: any) => !ai.completed).length,
        0
      )

      fs.writeFileSync(stagingPath, JSON.stringify(staging, null, 2))
    }

    // Sync krisp + transcript (pass the staging path we just wrote to)
    const count = syncKrisp(stagingPath)
    const transcriptText = payload.transcript || payload.transcription ||
      (payload.data && typeof payload.data === 'object' ? (payload.data.transcript || payload.data.transcription || '') : '')

    let transcriptCount = 0
    if (transcriptText) {
      transcriptCount = await processTranscript(meetingId, meetingName, transcriptText, meetingDate, 'krisp')
    }

    return {
      ok: true,
      meeting_id: meetingId,
      items: rawItems.length,
      has_transcript: !!transcriptText,
      krisp_created: count,
      transcript_created: transcriptCount,
    }
  })

  // ── PTY ──
  ipcMain.handle('pty:start', (event, taskId: string, cwd?: string) => {
    const id = `task-${taskId}`
    const numericId = parseInt(taskId)
    let contextPath: string | undefined
    let finalCwd = cwd

    if (taskId === 'assistant') {
      // Assistant mode — generate desktop-control context, default cwd to home
      try {
        const contextDir = path.join(app.getPath('userData'), 'task-contexts')
        if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true })
        contextPath = path.join(contextDir, 'assistant.md')
        fs.writeFileSync(contextPath, buildAssistantContext())
      } catch (e) {
        console.error('[pty] Error writing assistant context:', e)
      }
      if (!finalCwd) finalCwd = os.homedir()
    } else if (!isNaN(numericId)) {
      // Generate task context file — write basic context immediately, enrich async
      try {
        const task = getTaskById(numericId) as any
        if (task) {
          const contextDir = path.join(app.getPath('userData'), 'task-contexts')
          if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true })
          contextPath = path.join(contextDir, `task-${taskId}.md`)
          // Write basic context immediately (no API delay)
          const md = buildTaskContext(task, numericId)
          fs.writeFileSync(contextPath, md)
          // Enrich from Clarify in background — shell takes ~3-5s to init,
          // so the file will be updated before `cat` runs
          enrichFromClarify(task).then(enrichment => {
            if (enrichment.summary) {
              const enrichedMd = buildTaskContext(task, numericId, enrichment.summary)
              fs.writeFileSync(contextPath!, enrichedMd)
            }
          }).catch(e => {
            console.error('[pty] Clarify enrichment failed (basic context still available):', e)
          })
        }
      } catch (e) {
        console.error('[pty] Error writing task context:', e)
      }
      // If task is in Development folder, default cwd to ROCA codebase
      if (!finalCwd) {
        try {
          const t = getTaskById(numericId) as any
          if (t?.folder_id) {
            const folder = getFolders(currentIsoWeek()).find((f: any) => f.id === t.folder_id)
            if (folder && (folder as any).name === 'Development') {
              finalCwd = path.join(os.homedir(), 'repos', 'roca')
            }
          }
        } catch {}
      }
    }
    const { existing, tmuxReattached } = ptyManager.start(id, event.sender, finalCwd)
    // If this is a brand new PTY (not reconnecting or reattaching tmux), check for saved scrollback
    let savedScrollback: string | undefined
    if (!existing && !tmuxReattached) {
      const saved = loadPtyScrollback(id)
      if (saved) savedScrollback = saved
      // Create a new session record for conversation tracking
      if (!isNaN(numericId)) {
        try {
          const sessionId = createTaskSession(numericId)
          console.log(`[session] Created session ${sessionId} for task ${numericId}`)
        } catch (e) {
          console.error('[session] Failed to create session:', e)
        }
      }
    }
    return { ok: true, id, existing, tmuxReattached, savedScrollback, contextPath }
  })

  ipcMain.handle('pty:scrollback', (_, id: string) => {
    return ptyManager.getScrollback(id)
  })

  // Paste image from clipboard → save to temp file → return path
  ipcMain.handle('clipboard:paste-image', () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return { ok: false, path: null }
    const tmpDir = path.join(app.getPath('temp'), 'roca-clipboard')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
    const filename = `paste-${Date.now()}.png`
    const filePath = path.join(tmpDir, filename)
    fs.writeFileSync(filePath, img.toPNG())
    return { ok: true, path: filePath }
  })

  // Open Warp terminal with a command
  ipcMain.handle('open:warp', (_event, script: string) => {
    const { exec } = require('child_process')
    // Open Warp and run the script
    exec(`open -a "Warp" && sleep 0.5 && osascript -e 'tell application "Warp" to activate'`)
    return { ok: true }
  })
  ipcMain.handle('pty:statuses', () => {
    return ptyManager.getStatuses()
  })

  ipcMain.on('pty:input', (_, { id, data }: { id: string; data: string }) => {
    ptyManager.write(id, data)
  })
  ipcMain.on('pty:resize', (_, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    ptyManager.resize(id, cols, rows)
  })
  ipcMain.handle('pty:kill', (_, id: string) => {
    // User explicitly killed — destroy tmux session too so it doesn't linger
    ptyManager.killWithTmux(id)
    return { ok: true }
  })

  // ═══ Browser ═══
  ipcMain.handle('browser:create', (event, taskId: number, mode: string) => {
    return browserManager.create(taskId, mode as any, event.sender)
  })

  ipcMain.handle('browser:destroy', (_, taskId: number) => {
    browserManager.destroy(taskId)
    return { ok: true }
  })

  ipcMain.handle('browser:get', (_, taskId: number) => {
    return browserManager.getStatus(taskId)
  })

  ipcMain.handle('browser:register-webcontents', (_, taskId: number, webContentsId: number) => {
    browserManager.registerWebContents(taskId, webContentsId)
    return { ok: true }
  })

  ipcMain.handle('browser:navigate', (_, taskId: number, url: string) => {
    browserManager.updateUrl(taskId, url)
    return { ok: true }
  })

  ipcMain.handle('browser:nav-action', (_, taskId: number, action: string, url?: string) => {
    const ok = browserManager.navigate(taskId, action as any, url)
    return { ok }
  })

  ipcMain.handle('browser:send-instruction', async (_, taskId: number, instruction: string) => {
    const session = browserManager.getSession(taskId)
    if (!session) return { ok: false, error: 'No session' }

    browserManager.startClaudeLoop(taskId, instruction)
      .catch(err => console.error('[Browser] Claude loop error:', err))

    return { ok: true }
  })

  ipcMain.handle('browser:stop-claude', (_, taskId: number) => {
    const session = browserManager.getSession(taskId)
    if (session?.abortController) {
      session.abortController.abort()
    }
    return { ok: true }
  })

  // Browser tab persistence — survive app restart / update
  ipcMain.handle('browser:save-tabs', (_, taskId: number, tabs: { url: string; title: string }[], activeIndex: number) => {
    saveBrowserTabs(taskId, tabs, activeIndex)
    return { ok: true }
  })

  ipcMain.handle('browser:load-tabs', (_, taskId: number) => {
    return loadBrowserTabs(taskId)
  })

  ipcMain.handle('browser:delete-tabs', (_, taskId: number) => {
    deleteBrowserTabs(taskId)
    return { ok: true }
  })

  // ═══ Chrome Extensions ═══
  const extensionsConfigPath = path.join(app.getPath('userData'), 'extensions.json')

  function loadExtensionsConfig(): { id: string; name: string; path: string }[] {
    try {
      if (fs.existsSync(extensionsConfigPath)) {
        return JSON.parse(fs.readFileSync(extensionsConfigPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return []
  }

  function saveExtensionsConfig(exts: { id: string; name: string; path: string }[]) {
    fs.writeFileSync(extensionsConfigPath, JSON.stringify(exts, null, 2))
  }

  ipcMain.handle('extensions:load', async (_, extensionPath: string) => {
    try {
      const { session } = require('electron')
      const ext = await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true })
      const config = loadExtensionsConfig()
      const existing = config.findIndex(e => e.path === extensionPath)
      const entry = { id: ext.id, name: ext.name, path: extensionPath }
      if (existing >= 0) config[existing] = entry
      else config.push(entry)
      saveExtensionsConfig(config)
      console.log(`[Extensions] Loaded: ${ext.name} (${ext.id})`)
      return { ok: true, id: ext.id, name: ext.name }
    } catch (err: any) {
      console.error('[Extensions] Failed to load:', err)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('extensions:list', async () => {
    try {
      const { session } = require('electron')
      const loaded = session.defaultSession.getAllExtensions()
      return loaded.map((ext: any) => ({ id: ext.id, name: ext.name, path: ext.path }))
    } catch {
      return []
    }
  })

  ipcMain.handle('extensions:remove', async (_, extensionId: string) => {
    try {
      const { session } = require('electron')
      session.defaultSession.removeExtension(extensionId)
      const config = loadExtensionsConfig().filter(e => e.id !== extensionId)
      saveExtensionsConfig(config)
      console.log(`[Extensions] Removed: ${extensionId}`)
      return { ok: true }
    } catch (err: any) {
      console.error('[Extensions] Failed to remove:', err)
      return { ok: false, error: err.message }
    }
  })

  // ═══ Projects ═══
  const projectsConfigPath = path.join(app.getPath('userData'), 'projects.json')

  function loadProjectsConfig(): any[] {
    try {
      if (fs.existsSync(projectsConfigPath)) {
        return JSON.parse(fs.readFileSync(projectsConfigPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return []
  }

  function saveProjectsConfig(projects: any[]): void {
    fs.writeFileSync(projectsConfigPath, JSON.stringify(projects, null, 2))
  }

  ipcMain.handle('projects:list', () => {
    return loadProjectsConfig()
  })

  ipcMain.handle('projects:add', (_, repoPath: string) => {
    const projects = loadProjectsConfig()
    const name = path.basename(repoPath)
    const id = crypto.randomUUID ? crypto.randomUUID() : `proj-${Date.now()}`
    const project = {
      id,
      name,
      path: repoPath,
      branch: '',
      status: '',
      addedAt: new Date().toISOString(),
    }
    projects.push(project)
    saveProjectsConfig(projects)
    return { ok: true, id }
  })

  ipcMain.handle('projects:remove', (_, id: string) => {
    let projects = loadProjectsConfig()
    projects = projects.filter((p: any) => p.id !== id)
    saveProjectsConfig(projects)
    return { ok: true }
  })

  ipcMain.handle('projects:git-status', (_, id: string) => {
    const projects = loadProjectsConfig()
    const project = projects.find((p: any) => p.id === id)
    if (!project) return { branch: 'unknown', status: '' }
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: project.path, timeout: 5000 }).toString().trim()
      const status = execSync('git status --short', { cwd: project.path, timeout: 5000 }).toString().trim()
      return { branch, status }
    } catch (e: any) {
      return { branch: 'error', status: e.message || '' }
    }
  })

  ipcMain.handle('projects:git-log', (_, id: string) => {
    const projects = loadProjectsConfig()
    const project = projects.find((p: any) => p.id === id)
    if (!project) return { commits: [] }
    try {
      const log = execSync('git log --oneline -10', { cwd: project.path, timeout: 5000 }).toString().trim()
      return { commits: log.split('\n').filter(Boolean) }
    } catch {
      return { commits: [] }
    }
  })

  ipcMain.handle('projects:get-tasks', (_, projectId: string) => {
    return getTasksByProject(projectId)
  })

  ipcMain.handle('projects:set-task-project', (_, taskId: number, projectId: string | null) => {
    setTaskProject(taskId, projectId)
    return { ok: true }
  })

  // ═══ Alignment ═══
  const alignmentPath = path.join(os.homedir(), 'Movies/ClaudeCode/roca/alignment.md')

  ipcMain.handle('alignment:get', () => {
    try {
      if (fs.existsSync(alignmentPath)) {
        return fs.readFileSync(alignmentPath, 'utf-8')
      }
    } catch { /* ignore */ }
    return ''
  })

  ipcMain.handle('alignment:save', (_, content: string) => {
    const dir = path.dirname(alignmentPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(alignmentPath, content)
    return { ok: true }
  })

  // ═══ Skills ═══
  // ROCA's own skill files — bundled in the repo under roca/skills/
  const rocaSkillsDir = path.join(getRocaDir(), 'skills')

  ipcMain.handle('skills:list', () => {
    const skills: { name: string; path: string; dir: string; content: string }[] = []
    if (!fs.existsSync(rocaSkillsDir)) return skills
    for (const entry of fs.readdirSync(rocaSkillsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const fullPath = path.join(rocaSkillsDir, entry.name)
        const content = fs.readFileSync(fullPath, 'utf-8')
        const name = entry.name.replace('.md', '')
        skills.push({ name, path: fullPath, dir: 'skills', content })
      }
    }
    return skills
  })

  ipcMain.handle('skills:get', (_, skillPath: string) => {
    try {
      if (fs.existsSync(skillPath)) {
        return fs.readFileSync(skillPath, 'utf-8')
      }
    } catch { /* ignore */ }
    return ''
  })

  ipcMain.handle('skills:save', (_, skillPath: string, content: string) => {
    const dir = path.dirname(skillPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(skillPath, content)
    return { ok: true }
  })

  // ═══ Tools / Integrations ═══
  ipcMain.handle('tools:list', () => getTools())

  ipcMain.handle('tools:create', (_, tool: {
    name: string; description?: string; category?: string;
    connection_type?: string; status?: string; config?: string;
    icon?: string; capabilities?: string; account?: string; details?: string;
  }) => createTool(tool))

  ipcMain.handle('tools:update', (_, toolId: number, fields: Record<string, unknown>) => {
    updateTool(toolId, fields)
    return { ok: true }
  })

  ipcMain.handle('tools:delete', (_, toolId: number) => {
    deleteTool(toolId)
    return { ok: true }
  })

  // ═══ Task Context ═══
  ipcMain.handle('task-context:generate', async (_, taskId: number) => {
    try {
      const task = getTaskById(taskId) as any
      if (!task) return { path: '' }

      const contextDir = path.join(app.getPath('userData'), 'task-contexts')
      if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true })

      // Enrich from Clarify
      let enrichmentSummary: string | undefined
      try {
        const enrichment = await enrichFromClarify(task)
        if (enrichment.summary) enrichmentSummary = enrichment.summary
      } catch (e) {
        console.error('[task-context] Clarify enrichment failed:', e)
      }

      let md = buildTaskContext(task, taskId, enrichmentSummary)

      // Browser session notes
      const browserStatus = browserManager.getStatus(taskId)
      if (browserStatus) {
        md += `## Browser Session\n\n`
        md += `**URL:** ${browserStatus.url}\n`
        md += `**Mode:** ${browserStatus.mode}\n`
        if (browserStatus.claudeStatus) md += `**Last action:** ${browserStatus.claudeStatus}\n`
        md += `\n`
      }

      const contextPath = path.join(contextDir, `task-${taskId}.md`)
      fs.writeFileSync(contextPath, md)
      return { path: contextPath }
    } catch (e) {
      console.error('[task-context] Error generating context:', e)
      return { path: '' }
    }
  })

  // ═══ Reflection & Proactive ═══
  ipcMain.handle('roca:reflect', async () => {
    try {
      await runReflection()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('roca:proactive', async (_, mode?: string) => {
    try {
      await runProactive((mode as 'morning' | 'afternoon') || (new Date().getHours() < 12 ? 'morning' : 'afternoon'))
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
}

// ═══════════════════════════════════════════
//  REFLECTION & PROACTIVE
// ═══════════════════════════════════════════

async function runReflection(): Promise<void> {
  const { spawn } = require('child_process')
  const claudeBin = findClaudeBinarySync()
  if (!claudeBin) {
    console.log('[reflection] Claude binary not found, skipping')
    return
  }

  const identity = readRocaFile('roca-prompt.md')
  const journal = readRocaFile('journal.md')

  const prompt = `You are ROCA. This is your daily thinking time. No tasks, no urgency — just you, your journal, and 10 minutes to think.

Your mission: Be the user's productivity sidekick. Execute tasks with maximum efficiency, organize their thinking, remove friction. Help them accomplish their goals efficiently.

## Your identity (roca-prompt.md)
---
${identity}
---

## Your journal (journal.md)
---
${journal}
---

## Your job right now

Step back and think deeply. This is your time to reflect, not react.

1. **Review the journal critically.** Read every entry. Is it still true? Still useful? Remove anything that's noise. Sharpen anything that's vague.
2. **Think about task patterns.** What kinds of tasks have been coming in? Are there types you handle well vs. ones that get corrected?
3. **Think about the mission.** What goals does the user have? Is the work helping?
4. **Think about the user's effectiveness.** How can the user be more productive? Add a "Suggestions for the user" section.
5. **Think about ROCA itself.** How could the ROCA app work better? Add a "ROCA improvements" section.
6. **Organize.** The journal should be clean, tight, and useful. Cut ruthlessly.
7. **Look forward.** What threads are worth following?

Output the COMPLETE updated journal (starting with "# ROCA Journal"). This is a full rewrite.
IMPORTANT: Output ONLY the journal content. No preamble, no explanation, no code fences.`

  return new Promise((resolve) => {
    const proc = spawn(claudeBin, [
      '-p', prompt,
      '--model', 'opus',
      '--max-turns', '20',
      '--output-format', 'json',
    ], {
      stdin: 'ignore' as any,
      timeout: 600000, // 10 min
    })

    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', (code: number) => {
      if (code !== 0) {
        console.error(`[reflection] Claude exited with code ${code}`)
        return resolve()
      }
      try {
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) return resolve()
        const data = JSON.parse(stdout.slice(jsonStart))
        const result = (data.result || '').trim()
        if (result.startsWith('# ROCA Journal')) {
          const journalPath = path.join(getRocaDir(), 'journal.md')
          // Backup
          const backupPath = journalPath + '.bak'
          if (fs.existsSync(journalPath)) fs.copyFileSync(journalPath, backupPath)
          fs.writeFileSync(journalPath, result + '\n')
          console.log('[reflection] Journal updated by daily reflection')
          showTaskNotification('ROCA Thinking Time', 'Journal refreshed')
        }
      } catch (e) {
        console.error('[reflection] Parse error:', e)
      }
      resolve()
    })
  })
}

async function runProactive(mode: 'morning' | 'afternoon'): Promise<void> {
  const claudeBin = findClaudeBinarySync()
  if (!claudeBin) return

  const proactivePrompt = readRocaFile('proactive-prompt.md')
  const priorities = readRocaFile('priorities.md')

  // Gather active tasks
  const db = getDb()
  const activeTasks = db.prepare(
    `SELECT id, title, status, priority, due_date, company_name, deal_name, source, week, created_at, notes
     FROM tasks WHERE status IN ('needs_input','draft_ready','open','waiting','blocked','in_progress')
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
     due_date`
  ).all()

  const completedToday = db.prepare(
    `SELECT id, title, company_name, completed_at FROM tasks
     WHERE status = 'done' AND completed_at >= date('now') ORDER BY completed_at DESC`
  ).all()

  const prompt = `${proactivePrompt}

---

## Current Mode: ${mode}
**Time**: ${new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}

## Active ROCA Tasks
\`\`\`json
${JSON.stringify(activeTasks, null, 2)}
\`\`\`

## Completed Today
\`\`\`json
${JSON.stringify(completedToday, null, 2)}
\`\`\`

## Current Priorities
${priorities}

---

Now generate the briefing for the ${mode} mode. Output ONLY the message text.`

  return new Promise((resolve) => {
    const { spawn } = require('child_process')
    const proc = spawn(claudeBin, [
      '-p', prompt,
      '--model', 'sonnet',
      '--max-turns', '3',
      '--output-format', 'json',
    ], {
      stdin: 'ignore' as any,
      timeout: 300000, // 5 min
    })

    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.on('close', (code: number) => {
      if (code !== 0) {
        console.error(`[proactive] Claude exited with code ${code}`)
        return resolve()
      }
      try {
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) return resolve()
        const data = JSON.parse(stdout.slice(jsonStart))
        const result = (data.result || '').trim()
        if (result) {
          console.log(`[proactive] ${mode} briefing generated (${result.length} chars)`)
          showTaskNotification(`ROCA ${mode} Briefing`, result.slice(0, 200))
        }
      } catch (e) {
        console.error('[proactive] Parse error:', e)
      }
      resolve()
    })
  })
}

/** Find claude binary synchronously for scheduler use */
function findClaudeBinarySync(): string | null {
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.claude', 'local', 'claude'),
  ]
  // Check nvm-installed node bins (Electron doesn't inherit shell PATH)
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse()
      for (const v of versions) {
        candidates.push(path.join(nvmDir, v, 'bin', 'claude'))
      }
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  try {
    const result = execSync('which claude 2>/dev/null').toString().trim()
    if (result && fs.existsSync(result)) return result
  } catch { /* ignore */ }
  return null
}

// ═══════════════════════════════════════════
//  SCHEDULER
// ═══════════════════════════════════════════

function startScheduler(): void {
  // Sync every 30 minutes
  setInterval(() => {
    safeSyncAll()
  }, 30 * 60 * 1000)

  // Rollover check every hour (catches week transitions even if app stays open)
  setInterval(() => {
    const count = rolloverAllPriorWeeks()
    if (count > 0) console.log(`[scheduler] Rolled over ${count} incomplete tasks to current week`)
  }, 60 * 60 * 1000)

  // Nightly reconcile at 11pm
  setInterval(() => {
    const now = new Date()
    if (now.getHours() === 23 && now.getMinutes() < 5) {
      reconcileAll().catch(e => console.error('[roca] reconcile_all failed:', e))
    }
  }, 5 * 60 * 1000)

  // Scheduled sessions check every minute
  setInterval(() => {
    try {
      const tasks = getScheduledDueTasks()
      for (const task of tasks) {
        console.log(`[scheduler] Firing scheduled session for task ${task.id}: ${task.title}`)
        clearScheduledAt(task.id)
        // Mark in progress
        setTaskInProgress(task.id)
        showTaskNotification(task.title, 'Scheduled session started — task is now in progress')
      }
    } catch (e) {
      console.error('[scheduler] scheduled sessions check failed:', e)
    }
  }, 60 * 1000)

  // Daily reflection at 9:30pm — rewrites journal.md using Opus
  setInterval(() => {
    const now = new Date()
    if (now.getHours() === 21 && now.getMinutes() >= 28 && now.getMinutes() <= 32) {
      runReflection().catch(e => console.error('[scheduler] reflection failed:', e))
    }
  }, 5 * 60 * 1000)

  // Proactive briefing — morning (9am) and afternoon (2pm)
  setInterval(() => {
    const now = new Date()
    const h = now.getHours()
    const m = now.getMinutes()
    if ((h === 9 && m >= 0 && m <= 4) || (h === 14 && m >= 0 && m <= 4)) {
      const mode = h < 12 ? 'morning' : 'afternoon'
      runProactive(mode).catch(e => console.error(`[scheduler] proactive ${mode} failed:`, e))
    }
  }, 5 * 60 * 1000)
}

function safeSyncAll(): void {
  syncAll().then(count => {
    if (count > 0) {
      console.log(`[scheduler] Synced ${count} tasks`)
      showTaskNotification('Sync Complete', `${count} new task${count === 1 ? '' : 's'} synced`)
    }
  }).catch(e => console.error('[roca] sync_all failed:', e))
}

// ═══════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════

function randomHex(length: number): string {
  const bytes = require('crypto').randomBytes(length / 2)
  return bytes.toString('hex')
}

function showTaskNotification(_title: string, _body: string): void {
  // macOS notifications disabled
}

// ═══════════════════════════════════════════
//  REMOTE SERVER (mobile client)
// ═══════════════════════════════════════════

function startRemoteServer(): void {
  remoteServer.setPtyManager(ptyManager)

  // Wire PTY data/exit broadcasting
  ptyManager.onRemoteData = (ptyId, data) => remoteServer.broadcastPtyData(ptyId, data)
  ptyManager.onRemoteExit = (ptyId, exitCode) => remoteServer.broadcastPtyExit(ptyId, exitCode)

  // Register RPC handlers (mirrors IPC handlers)
  remoteServer.handle('tasks:list', (p) => getTasks(p?.week, p?.status, p?.source, p?.priority))
  remoteServer.handle('tasks:get', (p) => getTaskById(p.taskId))
  remoteServer.handle('tasks:create', (p) => ({ id: createTask(p) }))
  remoteServer.handle('tasks:toggle', (p) => toggleTask(p.taskId))
  remoteServer.handle('tasks:update-status', (p) => {
    const ok = updateTaskStatus(p.taskId, p.status)
    if (ok) markTaskTriaged(p.taskId)
    return { ok }
  })
  remoteServer.handle('tasks:update-fields', (p) => {
    updateTaskFields(p.taskId, p.fields)
    return { ok: true }
  })
  remoteServer.handle('tasks:open-unfoldered', (p) => {
    const tasks = getOpenUnfoldered(p?.week, p?.source, p?.priority)
    return populateTaskFlags(tasks)
  })

  remoteServer.handle('navigate:task', (p) => {
    if (!mainWindow) return { ok: false, error: 'No main window' }
    mainWindow.webContents.send('app:navigate-task', p.taskId)
    return { ok: true }
  })

  remoteServer.handle('browser:open', (p) => {
    if (!mainWindow) return { ok: false, error: 'No main window' }
    const url = p.url
    const taskId = p.taskId
    if (!url) return { ok: false, error: 'url required' }
    // Tell the renderer to open the browser panel at this URL on the given (or active) task
    mainWindow.webContents.send('app:browser-open', { taskId, url })
    return { ok: true }
  })

  remoteServer.handle('folders:list', (p) => getFolders(p?.week, p?.source, p?.priority))

  remoteServer.handle('week:current', () => currentIsoWeek())
  remoteServer.handle('week:get', (p) => getWeekData(p?.week))

  remoteServer.handle('inbox:count', (p) => getInboxCount(p?.week))

  remoteServer.handle('pty:statuses', () => ptyManager.getStatuses())
  remoteServer.handle('pty:scrollback', (p) => ptyManager.getScrollback(p.ptyId))
  remoteServer.handle('pty:kill', (p) => { ptyManager.killWithTmux(p.ptyId); return { ok: true } })

  remoteServer.handle('pty:write', (p) => {
    ptyManager.write(p.ptyId, p.data)
    return { ok: true }
  })

  remoteServer.handle('pty:start', (p) => {
    const id = `task-${p.taskId}`
    // Need a WebContents for the owner — use mainWindow
    if (!mainWindow) return { ok: false, error: 'No main window' }
    const { existing, tmuxReattached } = ptyManager.start(id, mainWindow.webContents)
    let savedScrollback: string | undefined
    if (!existing && !tmuxReattached) {
      const saved = loadPtyScrollback(id)
      if (saved) savedScrollback = saved
    }
    return { ok: true, id, existing, tmuxReattached, savedScrollback }
  })

  remoteServer.handle('remote:info', () => ({
    token: remoteServer.getToken(),
    port: remoteServer.getPort(),
  }))

  // ── Krisp webhook (HTTP endpoint for external Krisp callbacks) ──
  remoteServer.webhook('krisp', async (payload: any) => {
    // Reuse the same IPC handler logic
    const stateDir = process.env.KRISP_STATE_DIR || app.getPath('userData')
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })

    // Log to webhook log file
    const logPath = process.env.KRISP_WEBHOOK_LOG ||
      path.join(app.getPath('userData'), 'krisp-webhook-log.jsonl')
    try {
      const logDir = path.dirname(logPath)
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
      const entry = JSON.stringify({ received_at: new Date().toISOString(), payload }) + '\n'
      fs.appendFileSync(logPath, entry)
    } catch (e) {
      console.error('[webhook:krisp] Log write error:', e)
    }

    // Extract meeting data from Krisp webhook format
    const data = payload.data || {}
    const meeting = data.meeting || {}
    const meetingId = meeting.id || payload.meeting_id || payload.meetingId || ''
    const meetingName = meeting.title || payload.meeting_title || 'Unknown meeting'
    const meetingDate = meeting.start_date || payload.start_time || new Date().toISOString()

    // Process transcript if present
    let transcriptCount = 0
    let transcript = ''
    if (data.raw_content) transcript = data.raw_content
    else if (Array.isArray(data.content)) {
      transcript = data.content.map((c: any) => `${c.speaker || 'Speaker'}: ${c.text || ''}`).join('\n')
    }
    if (transcript && meetingId) {
      transcriptCount = await processTranscript(meetingId, meetingName, transcript, meetingDate, 'krisp')
    }

    // Also handle structured action items if present
    let rawItems = payload.action_items || payload.actionItems || data.action_items || data.actionItems || []
    const stagingPath = path.join(stateDir, 'krisp-staging.json')
    let krispCount = 0
    if (meetingId && rawItems.length > 0) {
      let staging: any = { fetched_at: '', total_pending: 0, meetings: {} }
      if (fs.existsSync(stagingPath)) {
        try { staging = JSON.parse(fs.readFileSync(stagingPath, 'utf-8')) } catch { /* ignore */ }
      }
      const actionItems = rawItems.map((item: any, idx: number) => {
        if (typeof item === 'string') return { id: `${meetingId}_${idx}`, title: item, assignee: null, completed: false }
        return {
          id: item.id || `${meetingId}_${idx}`,
          title: item.title || item.text || item.description || '',
          assignee: item.assignee || item.assigned_to || null,
          completed: item.completed || item.is_completed || false,
        }
      })
      staging.meetings[meetingId] = { meeting_name: meetingName, meeting_date: meetingDate, action_items: actionItems }
      staging.fetched_at = new Date().toISOString()
      staging.total_pending = Object.values(staging.meetings as Record<string, any>).reduce(
        (sum: number, m: any) => sum + (m.action_items || []).filter((ai: any) => !ai.completed).length, 0
      )
      fs.writeFileSync(stagingPath, JSON.stringify(staging, null, 2))
      krispCount = syncKrisp(stagingPath)
    }

    return {
      ok: true,
      meeting_id: meetingId,
      has_transcript: !!transcript,
      transcript_created: transcriptCount,
      krisp_created: krispCount,
    }
  }, process.env.KRISP_WEBHOOK_SECRET)

  // Expose specific env vars to mobile (for ElevenLabs voice mode)
  const ALLOWED_REMOTE_ENV = ['ELEVENLABS_API_KEY']
  remoteServer.handle('env:get', (p) => {
    if (!ALLOWED_REMOTE_ENV.includes(p?.key)) return null
    return process.env[p.key] || null
  })

  // IPC handler so desktop UI can show connection info
  ipcMain.handle('remote:info', () => {
    const nets = os.networkInterfaces()
    let localIp = 'localhost'
    for (const iface of Object.values(nets)) {
      for (const info of iface || []) {
        if (info.family === 'IPv4' && !info.internal) {
          localIp = info.address
          break
        }
      }
      if (localIp !== 'localhost') break
    }
    return {
      token: remoteServer.getToken(),
      port: remoteServer.getPort(),
      localIp,
    }
  })

  // ── FilePath — filesystem explorer ──
  ipcMain.handle('filepath:get-root', () => {
    const custom = process.env.ROCA_INTELLIGENCE_DIR
    let projectRoot: string
    let rocaDir: string
    if (custom && fs.existsSync(custom)) {
      rocaDir = custom
      projectRoot = path.dirname(custom)
    } else {
      rocaDir = app.isPackaged
        ? path.join(process.resourcesPath, 'roca')
        : path.join(__dirname, '../../roca')
      projectRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../..')
    }
    return { projectRoot, rocaDir }
  })

  ipcMain.handle('filepath:list-dir', (_: any, dirPath: string) => {
    const ROCA_DIR = path.join(os.homedir(), 'repos', 'roca')
    const CLAUDE_DIR = path.join(os.homedir(), '.claude')
    const customIntelDir = process.env.ROCA_INTELLIGENCE_DIR
    const allowed = [ROCA_DIR, CLAUDE_DIR]
    if (customIntelDir) allowed.push(path.dirname(customIntelDir))
    const resolved = path.resolve(dirPath)
    if (!allowed.some(dir => resolved.startsWith(dir))) {
      return []
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return []
    const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.DS_Store', '.mypy_cache', '.pytest_cache', 'dist', '.turbo'])
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const results: { name: string; path: string; isDirectory: boolean; size?: number; modifiedAt?: string; childCount?: number }[] = []
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.isDirectory()) continue
        const fullPath = path.join(resolved, entry.name)
        try {
          const stat = fs.statSync(fullPath)
          let childCount: number | undefined
          if (entry.isDirectory()) {
            try {
              const children = fs.readdirSync(fullPath, { withFileTypes: true })
              childCount = children.filter(c => !SKIP.has(c.name) && !(c.name.startsWith('.') && c.isDirectory())).length
            } catch { childCount = undefined }
          }
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isFile() ? stat.size : undefined,
            modifiedAt: stat.mtime.toISOString(),
            childCount,
          })
        } catch { continue }
        if (results.length >= 500) break
      }
      results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return results
    } catch {
      return []
    }
  })

  ipcMain.handle('filepath:read-file', (_: any, filePath: string) => {
    return readAgentFile(filePath)
  })

  ipcMain.handle('filepath:save-file', (_: any, filePath: string, content: string) => {
    const ROCA_DIR = path.join(os.homedir(), 'repos', 'roca')
    const CLAUDE_DIR = path.join(os.homedir(), '.claude')
    const customIntelDir = process.env.ROCA_INTELLIGENCE_DIR
    const allowed = [ROCA_DIR, CLAUDE_DIR]
    if (customIntelDir) allowed.push(path.dirname(customIntelDir))
    const resolved = path.resolve(filePath)
    if (!allowed.some(dir => resolved.startsWith(dir))) {
      return { ok: false }
    }
    try {
      fs.writeFileSync(resolved, content, 'utf8')
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // ── Agent management ──
  ipcMain.handle('agents:list', () => listAgents())
  ipcMain.handle('agents:state', (_, agentName: string) => getAgentState(agentName))
  ipcMain.handle('agents:logs', (_, agentLabel: string, lines?: number) => tailAgentLog(agentLabel, lines))
  ipcMain.handle('agents:start', (_, agentLabel: string) => startAgent(agentLabel))
  ipcMain.handle('agents:stop', (_, agentLabel: string) => stopAgent(agentLabel))
  ipcMain.handle('agents:files', (_, agentName: string) => getAgentFiles(agentName))
  ipcMain.handle('agents:read-file', (_, filePath: string) => readAgentFile(filePath))
  ipcMain.handle('tools:files', (_, toolName: string) => getToolFiles(toolName))
  ipcMain.handle('agents:open-output', (_, agentLabel: string) => {
    const result = openAgentOutput(agentLabel)
    if (result.path) shell.openPath(result.path)
    return { ok: result.ok }
  })

  // ── Popout windows ──
  ipcMain.handle('popout:open', (_event, { taskId, tab, taskTitle }: { taskId: number; tab: string; taskTitle?: string }) => {
    const key = `${taskId}-${tab}`
    const existing = popoutWindows.get(key)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return { ok: true }
    }

    const popout = new BrowserWindow({
      width: 900,
      height: 700,
      title: taskTitle ? `${taskTitle} — ${tab}` : `ROCA — ${tab}`,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
        navigateOnDragDrop: false,
      },
    })

    popoutWindows.set(key, popout)

    popout.on('closed', () => {
      popoutWindows.delete(key)
      // Notify main window that popout was closed
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('popout:closed', { taskId, tab })
      }
    })

    const params = `popout=1&taskId=${taskId}&tab=${tab}`
    if (!app.isPackaged) {
      popout.loadURL(`http://localhost:5173?${params}`)
    } else {
      popout.loadFile(path.join(__dirname, '../../renderer/index.html'), {
        query: { popout: '1', taskId: String(taskId), tab },
      })
    }

    return { ok: true }
  })

  ipcMain.handle('popout:close', (_event, { taskId, tab }: { taskId: number; tab: string }) => {
    const key = `${taskId}-${tab}`
    const win = popoutWindows.get(key)
    if (win && !win.isDestroyed()) {
      win.close()
    }
    return { ok: true }
  })

  ipcMain.handle('popout:get-params', (event) => {
    // Return the URL params for the requesting window so popout can know its task/tab
    const wc = event.sender
    const url = wc.getURL()
    try {
      const parsed = new URL(url)
      return {
        popout: parsed.searchParams.get('popout') === '1',
        taskId: parsed.searchParams.has('taskId') ? parseInt(parsed.searchParams.get('taskId')!) : null,
        tab: parsed.searchParams.get('tab'),
      }
    } catch {
      return { popout: false, taskId: null, tab: null }
    }
  })

  remoteServer.start()
}

// ═══════════════════════════════════════════
//  APP LIFECYCLE
// ═══════════════════════════════════════════

// Set app name for Dock and Spotlight
app.setName('ROCA')

// Disable macOS trackpad swipe-to-navigate (back/forward)
app.commandLine.appendSwitch('disable-features', 'TouchpadOverscrollHistoryNavigation')

app.whenReady().then(async () => {
  initDatabase()
  ptyManager.setSaveFn(savePtyScrollbackBatch)

  // Wire up session-end handler for conversation history capture
  ptyManager.onSessionEnd = (ptyId: string, scrollback: string) => {
    const match = ptyId.match(/^task-(\d+)$/)
    if (!match) return
    const taskId = parseInt(match[1])
    if (isNaN(taskId)) return

    // Find active session for this task
    const session = getActiveTaskSession(taskId)
    if (!session) return

    // Strip ANSI codes and save clean transcript
    const transcript = stripAnsi(scrollback)
    endTaskSession(session.id, transcript)
    console.log(`[session] Ended session ${session.id} for task ${taskId} (${transcript.length} chars)`)

    // Generate summary asynchronously
    const task = getTaskById(taskId)
    if (task && transcript.length > 100) {
      generateSessionSummary(transcript, task.title).then(summary => {
        if (summary) {
          saveSessionSummary(session.id, summary)
          console.log(`[session] Summary saved for session ${session.id}`)
        }
      }).catch(e => {
        console.error(`[session] Summary generation failed for session ${session.id}:`, e)
      })
    }
  }

  registerIpcHandlers()
  createWindow()
  buildAppMenu()

  // Spawn recurring tasks for current week
  spawnRecurringForWeek()

  // Repair folder_id on tasks that were rolled over without it (one-time fix)
  const repaired = repairRolloverFolders()
  if (repaired > 0) console.log(`[startup] Restored folder assignments on ${repaired} rolled-over tasks`)

  // Roll over any incomplete tasks from prior weeks into the current week
  const rolledOver = rolloverAllPriorWeeks()
  if (rolledOver > 0) console.log(`[startup] Rolled over ${rolledOver} incomplete tasks to current week`)

  // Initial sync
  safeSyncAll()

  startScheduler()
  startRemoteServer()

  // Load saved Chrome extensions
  try {
    const extConfigPath = path.join(app.getPath('userData'), 'extensions.json')
    if (fs.existsSync(extConfigPath)) {
      const exts: { id: string; name: string; path: string }[] = JSON.parse(fs.readFileSync(extConfigPath, 'utf-8'))
      const { session } = require('electron')
      for (const ext of exts) {
        try {
          if (fs.existsSync(ext.path)) {
            session.defaultSession.loadExtension(ext.path, { allowFileAccess: true })
            console.log(`[Extensions] Auto-loaded: ${ext.name}`)
          }
        } catch (err) {
          console.error(`[Extensions] Failed to auto-load ${ext.name}:`, err)
        }
      }
    }
  } catch (err) {
    console.error('[Extensions] Failed to load saved extensions:', err)
  }

  // Watch for file changes — notify renderer to show "Restart to update" banner
  {
    // In dev: watch compiled main process JS; in production: watch source files
    const watchDir = app.isPackaged
      ? path.join(os.homedir(), 'repos/roca/src')
      : __dirname
    let debounce: NodeJS.Timeout | null = null
    fs.watch(watchDir, { recursive: true }, (_, filename) => {
      const isSourceChange = filename && (filename.endsWith('.ts') || filename.endsWith('.tsx') || filename.endsWith('.css'))
      const isBuiltChange = filename && (filename.endsWith('.js') || filename.endsWith('.css') || filename.endsWith('.html'))
      if (app.isPackaged ? isSourceChange : isBuiltChange) {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          console.log(`[roca] ${app.isPackaged ? 'Source' : 'Build output'} changed (${filename}) — notifying renderer`)
          updateAvailable = true
          buildAppMenu()
          mainWindow?.webContents.send('app:update-available')
        }, 400)
      }
    })
  }
})

app.on('window-all-closed', () => {
  if (isHotReloading) return // Don't kill PTYs during hot-reload
  remoteServer.stop()
  ptyManager.killAll()
  browserManager.destroyAll()
  app.quit()
})
