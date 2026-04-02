import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import type {
  Task, Week, RecurringTask, DelegateCache, DelegateExecution,
  DelegateMessage, Upload, Folder, TaskStatus, Tool,
} from '../shared/types'
export {
  ACTIVE_STATUSES, STATUS_LABELS, INBOX_SOURCES, FOLDER_COLORS,
} from '../shared/constants'
import { ACTIVE_STATUSES, STATUS_LABELS, FOLDER_COLORS, INBOX_SOURCES } from '../shared/constants'

// ═══════════════════════════════════════════
//  DATABASE INIT
// ═══════════════════════════════════════════

let db: Database.Database

export function getDb(): Database.Database {
  return db
}

export function initDatabase(): void {
  const dbPath = path.join(app.getPath('userData'), 'roca.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      due_date TEXT,
      company_name TEXT,
      deal_name TEXT,
      notes TEXT,
      week TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS weeks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week TEXT UNIQUE NOT NULL,
      challenges TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_week ON tasks(week);
    CREATE INDEX IF NOT EXISTS idx_tasks_source_id ON tasks(source_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS recurring_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      company_name TEXT,
      deal_name TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_tasks_title ON recurring_tasks(title);

    CREATE TABLE IF NOT EXISTS delegate_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL UNIQUE,
      plan TEXT,
      context TEXT,
      cost REAL DEFAULT 0,
      turns INTEGER DEFAULT 0,
      error TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delegate_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      status TEXT DEFAULT 'running',
      output TEXT,
      cost REAL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS delegate_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      cost REAL DEFAULT 0,
      turns INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_delegate_messages_task ON delegate_messages(task_id);

    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      message_id INTEGER,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_task ON uploads(task_id);
    CREATE INDEX IF NOT EXISTS idx_uploads_message ON uploads(message_id);

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#BF5AF2',
      sort_order INTEGER DEFAULT 0,
      collapsed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pty_scrollback (
      pty_id TEXT PRIMARY KEY,
      scrollback TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      transcript TEXT NOT NULL DEFAULT '',
      summary TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_sessions_task ON task_sessions(task_id);

    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Custom',
      connection_type TEXT NOT NULL DEFAULT 'MCP',
      status TEXT NOT NULL DEFAULT 'disconnected',
      config TEXT,
      icon TEXT,
      capabilities TEXT,
      account TEXT,
      details TEXT,
      is_builtin INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // ── ALTER TABLE migrations ──
  const alterSafe = (sql: string) => {
    try { db.exec(sql) } catch { /* column already exists */ }
  }
  alterSafe('ALTER TABLE weeks ADD COLUMN meetings_held INTEGER DEFAULT 0')
  alterSafe('ALTER TABLE delegate_cache ADD COLUMN session_id TEXT')
  alterSafe('ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT 0')
  alterSafe('ALTER TABLE tasks ADD COLUMN scheduled_at TEXT')
  alterSafe('ALTER TABLE tasks ADD COLUMN folder_id INTEGER REFERENCES folders(id)')
  alterSafe('ALTER TABLE tasks ADD COLUMN triaged_at TEXT')
  alterSafe('ALTER TABLE tasks ADD COLUMN project_id TEXT')

  // ── New tables (idempotent) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_tabs (
      task_id INTEGER PRIMARY KEY,
      tabs_json TEXT NOT NULL DEFAULT '[]',
      active_index INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // ── Hot-path indexes ──
  const indexStatements = [
    'CREATE INDEX IF NOT EXISTS idx_tasks_source_source_id ON tasks(source, source_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_week_title ON tasks(week, title)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_week_status_sort ON tasks(week, status, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_status_scheduled_at ON tasks(status, scheduled_at)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_folder_status_sort ON tasks(folder_id, status, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_inbox_source_triaged ON tasks(source, triaged_at, status)',
  ]
  for (const stmt of indexStatements) {
    try { db.exec(stmt) } catch { /* ignore */ }
  }

  // ── Seed onboarding tasks for first-time users ──
  const taskCount = (db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }).count
  if (taskCount === 0) {
    const week = currentIsoWeek()
    const now = new Date().toISOString()
    const seeds = [
      {
        title: 'Welcome to ROCA — Start here',
        priority: 'high',
        notes: [
          '## Welcome to ROCA',
          '',
          'ROCA is your productivity sidekick — a desktop app with an embedded Claude terminal per task, voice mode, a built-in browser, file handling, and a skill system that gets smarter the more you use it.',
          '',
          '### How it works',
          '',
          '1. **Create a task** — type a title in the task input at the top and press Enter',
          '2. **Open the terminal** — click the terminal icon on the right panel. This starts a full Claude Code session scoped to your task. The task title, notes, and any uploaded files are automatically injected as context.',
          '3. **Talk to ROCA** — the terminal is a real Claude session. Ask it to do things, and it will. It has full access to your Mac (shell commands, AppleScript, file system, APIs).',
          '4. **Complete the task** — click the checkbox when done. Move on.',
          '',
          '### Try it now',
          '',
          'Click the terminal icon on the right side of this task. You\'ll see a Claude session start up with this task\'s context loaded. Try asking it something.',
          '',
          '### What\'s in these onboarding tasks',
          '',
          'Work through the tasks below to set up ROCA for your workflow:',
          '',
          '1. **Connect your tools** — hook up your CRM, calendar, email, etc.',
          '2. **Integrate task sources** — pull tasks from your to-do apps and meeting recorders',
          '3. **Learn the terminal** — slash commands, voice mode, browser control',
          '4. **Document handling** — Word, Excel, PowerPoint, PDF support',
          '5. **Learn the skill system** — how roca-prompt.md and journal.md work',
          '6. **Create your first skill** — build a skill for something you do repeatedly',
          '7. **Set up your intelligence directory** — customize ROCA for your workflow',
          '8. **Learn all the features** — weekly view, folders, delegation, file browser, mobile access',
        ].join('\n'),
      },
      {
        title: 'Connect Claude CLI to your tools',
        priority: 'high',
        notes: [
          '## Connect Your Tools',
          '',
          'ROCA runs Claude Code under the hood. The more tools you connect, the more ROCA can do for you autonomously.',
          '',
          '### MCP Servers (recommended)',
          '',
          'MCP (Model Context Protocol) lets Claude read and write to external tools directly. Set these up in your Claude Code config (`~/.claude/settings.json`):',
          '',
          '- **CRM** — Salesforce, HubSpot, Pipedrive, or any CRM with an MCP server',
          '- **Calendar** — Google Calendar, Outlook',
          '- **Email** — Gmail, Outlook',
          '- **Notes** — Notion, Obsidian, Apple Notes',
          '- **Project management** — Linear, Jira, Asana, Todoist',
          '- **Communication** — Slack, Discord',
          '- **Code** — GitHub, GitLab',
          '',
          'See https://docs.anthropic.com/en/docs/claude-code/mcp for setup instructions.',
          '',
          '### API Keys',
          '',
          'Set environment variables in your shell profile (`~/.zshrc` or `~/.bashrc`) for any APIs you want ROCA to access:',
          '',
          '```bash',
          'export ELEVENLABS_API_KEY="your-key"  # Required for voice mode',
          'export YOUR_CRM_API_KEY="your-key"     # For CRM access',
          '```',
          '',
          '### What this unlocks',
          '',
          'Once connected, ROCA can:',
          '- Look up people/companies in your CRM before drafting emails',
          '- Check your calendar and create events',
          '- Draft and send emails',
          '- Create tasks in your project management tool',
          '- Pull meeting transcripts and extract action items',
          '- Read and update documents in Notion/Obsidian',
        ].join('\n'),
      },
      {
        title: 'Integrate your task sources & note-taker apps',
        priority: 'high',
        notes: [
          '## Connect Your Task Sources',
          '',
          'ROCA can pull tasks from external tools so everything lives in one place.',
          '',
          '### To-Do Apps',
          '',
          '- **Google Tasks** — Set `GOOGLE_TOKEN_PATH` env var pointing to your OAuth token to sync tasks automatically',
          '- **Todoist** — Connect via MCP server (search for "todoist MCP" for community servers)',
          '- **Linear / Asana / Jira** — Same approach — connect via MCP and tasks sync into ROCA',
          '',
          '### Meeting Recorders / Note-Takers',
          '',
          'ROCA can receive webhooks from meeting recorders to auto-extract action items:',
          '',
          '- **Meeting recorders (Otter, Fireflies, Fathom, etc.)** — Set up a webhook pointing to ROCA\'s local server',
          '- **Manual transcripts** — Paste or upload a meeting transcript into any task, and ROCA will extract action items',
          '',
          '### How it works',
          '',
          '- Tasks from external sources appear in your **inbox** for triage',
          '- You review and accept/dismiss them',
          '- Accepted tasks join your weekly task list',
          '- Manual tasks can always be created directly in ROCA by typing in the task input',
          '',
          '### Sync',
          '',
          'Click the **Sync** button in the weekly view (or use `/sync` in any terminal) to pull new tasks from all connected sources.',
        ].join('\n'),
      },
      {
        title: 'Learn the terminal — slash commands, voice, and browser',
        priority: 'high',
        notes: [
          '## The ROCA Terminal',
          '',
          'Every task gets its own embedded Claude Code terminal. When you click the terminal icon, ROCA:',
          '',
          '1. Spawns a PTY (pseudo-terminal) session via tmux',
          '2. Starts Claude Code with your task context injected (title, notes, uploads)',
          '3. Gives you a full Claude session with access to your Mac',
          '',
          'Terminal sessions persist — close the app and reopen, your session is still there.',
          '',
          '### Slash Commands',
          '',
          'Type these in any terminal:',
          '',
          '| Command | What it does |',
          '|---------|-------------|',
          '| `/voice` | Toggle voice mode — talk to ROCA hands-free |',
          '| `/browse <instruction>` | Claude controls the built-in browser autonomously |',
          '| `/notes` | Toggle the notes panel |',
          '| `/files` | Toggle the file upload sidebar |',
          '| `/sync` | Pull tasks from all connected sources |',
          '| `/new <title>` | Create a new task |',
          '| `/done` | Complete the current task |',
          '| `/status <status>` | Set task status (open, in_progress, waiting, blocked) |',
          '| `/priority <level>` | Set priority (low, medium, high, urgent) |',
          '| `/week [next\\|prev]` | Navigate between weeks |',
          '| `/tab <week\\|filepath>` | Switch main view |',
          '| `/popout` | Pop the right panel into a separate window |',
          '| `/organize` | Smart task organizer reviews your open tasks |',
          '| `/clear` | Clear terminal screen |',
          '| `/help` | Show all commands |',
          '',
          '### Voice Mode',
          '',
          'Click the mic icon or type `/voice` to start voice mode. Requires `ELEVENLABS_API_KEY` env var.',
          '',
          'How it works:',
          '- Speak naturally — ROCA transcribes via ElevenLabs STT',
          '- Claude processes your request',
          '- ROCA speaks the response via ElevenLabs TTS',
          '- You can interrupt mid-response by speaking again',
          '',
          '### Built-in Browser',
          '',
          'Click the browser tab or type `/browse <instruction>` to give Claude control of a built-in Chromium browser.',
          '',
          'Claude will:',
          '1. Take a screenshot of the page',
          '2. Decide what action to take (click, type, scroll, navigate)',
          '3. Execute the action',
          '4. Repeat until done (up to 15 steps)',
          '',
          'Examples:',
          '- `/browse search Google for "best CRM for startups"`',
          '- `/browse go to linkedin.com and find John Smith`',
          '- `/browse fill out the form on this page with my info`',
        ].join('\n'),
      },
      {
        title: 'Document handling — Word, Excel, PowerPoint, PDF',
        priority: 'medium',
        notes: [
          '## Working with Documents',
          '',
          'ROCA can handle all major document formats. Drag and drop files into any task, or click the upload button in the file sidebar.',
          '',
          '### Supported Formats',
          '',
          '| Format | What ROCA does |',
          '|--------|---------------|',
          '| **Word (.docx)** | Converts to styled HTML — preserves headings, lists, tables, images. Viewable inline. |',
          '| **Excel (.xlsx)** | Parses all sheets into HTML tables. View data, ask Claude to analyze it. |',
          '| **PowerPoint (.pptx)** | Upload for Claude to read, analyze, or create new presentations. |',
          '| **PDF** | Viewable inline in the preview pane. Claude can read and analyze content. |',
          '| **Images** | Displayed inline. Claude can see and analyze images (screenshots, diagrams, charts). |',
          '| **CSV** | Parsed and displayed. Great for data analysis tasks. |',
          '| **Any text file** | Displayed with syntax highlighting. |',
          '',
          '### How to use',
          '',
          '1. Click into a task',
          '2. Click the **Files** tab or drag a file onto the task detail panel',
          '3. The file uploads and a preview appears',
          '4. Open the terminal — Claude automatically has access to the uploaded file',
          '5. Ask Claude to analyze, summarize, edit, or create documents',
          '',
          '### Creating Documents',
          '',
          'Claude can create new documents from scratch in the terminal:',
          '- "Create a PowerPoint presentation about Q3 results"',
          '- "Build an Excel spreadsheet tracking my sales pipeline"',
          '- "Draft a Word doc with the meeting notes from today"',
          '- "Generate a PDF report from this data"',
          '',
          'Files are saved to your task\'s upload directory and appear in the file sidebar.',
        ].join('\n'),
      },
      {
        title: 'Learn the skill system — roca-prompt.md & journal.md',
        priority: 'medium',
        notes: [
          '## How ROCA\'s Brain Works',
          '',
          'ROCA\'s intelligence comes from two files that work together:',
          '',
          '### roca-prompt.md — Identity & Methodology',
          '',
          'This file defines WHO ROCA is and HOW it works. It tells Claude:',
          '',
          '- What ROCA\'s mission is (your productivity sidekick)',
          '- The 4-step loop for every task: **Classify → Gather → Execute → Verify**',
          '- How the skill system works (Rules + Checklist + Cases)',
          '- That user corrections become rules in skill files',
          '',
          'You can customize this file to give ROCA your context — your role, your goals, your working style. The more context ROCA has, the better it performs.',
          '',
          '### journal.md — Task Routing',
          '',
          'This file is ROCA\'s task router. When you give ROCA a task, it:',
          '',
          '1. **Scans the Patterns table** in journal.md for a match',
          '2. **Loads the matching skill file** from `skills/[key].md`',
          '3. **Follows the skill\'s rules and checklist** to execute',
          '',
          'If no pattern matches, ROCA gathers context and executes anyway — then **adds a new pattern** so the next occurrence is faster.',
          '',
          '### The Learning Loop',
          '',
          '```',
          'You give ROCA a task',
          '  → ROCA classifies it (journal.md)',
          '  → ROCA loads the skill (skills/*.md)',
          '  → ROCA executes (following rules + checklist)',
          '  → You correct something',
          '  → The correction becomes a new rule in the skill file',
          '  → Next time, ROCA gets it right',
          '```',
          '',
          'Over time, your skills accumulate rules and cases that make ROCA increasingly precise for YOUR specific workflow. No two ROCA setups are alike.',
          '',
          '### Where these files live',
          '',
          '- Bundled: `roca/` directory in the app',
          '- Custom: wherever `ROCA_INTELLIGENCE_DIR` env var points to',
          '- The app reads from `ROCA_INTELLIGENCE_DIR` if set, otherwise falls back to the bundled `roca/` directory',
        ].join('\n'),
      },
      {
        title: 'Create your first skill',
        priority: 'medium',
        notes: [
          '## Build Your First Skill',
          '',
          'Skills teach ROCA how to do a specific type of task. Start with something you do repeatedly — the payoff compounds every time.',
          '',
          '### Step 1: Pick a task type',
          '',
          'Good first skills:',
          '- Follow-up emails after meetings',
          '- Weekly status reports',
          '- Meeting prep / call briefs',
          '- Company or person research',
          '- Document drafting (proposals, memos, summaries)',
          '',
          '### Step 2: Create the skill file',
          '',
          '1. Open `roca/skills/_template.md`',
          '2. Copy it and rename (e.g., `email-follow-up.md`)',
          '3. Fill in:',
          '   - **Name** — the pattern key (e.g., `email:follow-up`)',
          '   - **Description** — what the user says that triggers this skill',
          '   - **Rules** — hard constraints (add these as you get corrected)',
          '   - **Checklist** — step-by-step execution plan',
          '   - **Cases** — real examples of past executions',
          '',
          '### Step 3: Add the pattern to journal.md',
          '',
          'Add a row to the matching section in `journal.md`:',
          '',
          '```',
          '| `email:follow-up` | Follow-up after a meeting or call | `skills/email-follow-up.md` |',
          '```',
          '',
          '### Step 4: Use it',
          '',
          'Next time you ask ROCA to do that task type, it will automatically route to your skill file and follow the rules.',
          '',
          '### How skills get better',
          '',
          'When ROCA gets something wrong, correct it. The correction becomes a rule:',
          '',
          '- "Don\'t include the company address in follow-up emails" → new rule in the skill file',
          '- "Always check the calendar before prepping a brief" → new checklist step',
          '- Each case (real example) shows ROCA what good output looks like',
        ].join('\n'),
      },
      {
        title: 'Set up your intelligence directory',
        priority: 'medium',
        notes: [
          '## Custom Intelligence Directory',
          '',
          'The bundled `roca/` directory has the starter framework. To customize ROCA for your workflow, create your own intelligence directory.',
          '',
          '### Setup',
          '',
          '1. Create a directory:',
          '```bash',
          'mkdir ~/roca-intelligence',
          'cp -r /path/to/roca/roca/* ~/roca-intelligence/',
          '```',
          '',
          '2. Set the env var in `~/.zshrc` (or `~/.bashrc`):',
          '```bash',
          'export ROCA_INTELLIGENCE_DIR="$HOME/roca-intelligence"',
          '```',
          '',
          '3. Restart ROCA to pick up the change.',
          '',
          '### What to customize',
          '',
          '- **roca-prompt.md** — Add your mission, role, and working context. Example: "You are ROCA. My name is [Name]. I\'m a [role] at [company]. My goal is [goal]."',
          '- **journal.md** — Add patterns as you build skills',
          '- **skills/** — Build skill files for your recurring tasks',
          '',
          '### Why a separate directory?',
          '',
          '- **App updates don\'t overwrite your customizations**',
          '- **Version it with git** — track how your skills evolve over time',
          '- **Share across machines** — sync via git or cloud storage',
          '- **Keep it private** — your intelligence is yours, separate from the open-source app',
        ].join('\n'),
      },
      {
        title: 'Explore all ROCA features',
        priority: 'low',
        notes: [
          '## Everything ROCA Can Do',
          '',
          '### Weekly View',
          'Your home base. See all tasks for the current week, organized by priority.',
          '- **Objectives** — high-priority tasks at the top',
          '- **Results** — completed tasks',
          '- **Challenges** — free-form notes about the week',
          '- Navigate weeks with the arrows or `/week next`',
          '- Filter tasks by source (manual, synced, transcripts, etc.)',
          '',
          '### Folders',
          'Organize tasks into color-coded folders.',
          '- Create folders in the left panel',
          '- Drag tasks into folders',
          '- Collapse/expand folders',
          '- Reorder by dragging',
          '',
          '### Delegation / Assistant Mode',
          'Click the Assistant button in the weekly view to have ROCA autonomously analyze tasks.',
          '- ROCA reads the task, gathers context from your connected tools, and generates an execution plan',
          '- Plans include actual output (email drafts, research summaries, analysis)',
          '- Results cached per task so you don\'t re-run',
          '',
          '### File Browser (FilePath tab)',
          'Click the FilePath tab to browse your project files.',
          '- Navigate directory trees',
          '- Preview files inline with token count estimates',
          '- Edit and save files directly',
          '- Open a terminal at any directory',
          '',
          '### Smart Organizer',
          'Click Organize (or `/organize`) to have ROCA review your open tasks and suggest which to close vs. keep.',
          '',
          '### Popout Panel',
          'Type `/popout` to detach the right panel into a separate window. Great for multi-monitor setups.',
          '',
          '### Mobile Access',
          'ROCA runs a local server you can access from your phone/tablet on the same network.',
          '- View and manage tasks',
          '- Access terminal sessions remotely',
          '- Voice mode works on mobile too',
          '',
          '### Building Your Own Updates',
          'ROCA is open source. You can modify the app directly:',
          '- Source code is in `src/` (Electron + React + TypeScript)',
          '- `src/main/` — backend (PTY management, sync, delegation, database)',
          '- `src/renderer/` — frontend (React components, UI)',
          '- Run `npm run dev` for development mode',
          '- The app rebuilds itself — use the Feature Request task type to track what you want to build',
          '',
          '### Feature Requests & Bug Reports',
          'Use the feedback modal (in the app menu) to report issues or request features. It captures a screenshot and creates a task automatically.',
        ].join('\n'),
      },
    ]

    let sortOrder = 1
    const insertStmt = db.prepare(
      `INSERT INTO tasks (title, source, priority, status, notes, week, sort_order, created_at, triaged_at)
       VALUES (?, 'manual', ?, 'open', ?, ?, ?, ?, ?)`
    )
    for (const seed of seeds) {
      insertStmt.run(seed.title, seed.priority, seed.notes, week, sortOrder++, now, now)
    }
  }
}

// ═══════════════════════════════════════════
//  DATE / WEEK HELPERS
// ═══════════════════════════════════════════

export function currentIsoWeek(): string {
  // Sunday-start: shift boundary so Sunday begins new week (add 1 day)
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const year = d.getFullYear()
  const jan4 = new Date(year, 0, 4)
  const startOfW1 = new Date(jan4)
  startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7)) // Monday of ISO W1
  const diff = d.getTime() - startOfW1.getTime()
  const weekNum = 1 + Math.floor(diff / (7 * 86400000))
  return `${year}-W${String(weekNum).padStart(2, '0')}`
}

export function weekForDate(dateStr: string | null | undefined): string {
  if (!dateStr) return currentIsoWeek()
  try {
    const d = new Date(dateStr.slice(0, 10))
    if (isNaN(d.getTime())) return currentIsoWeek()
    d.setDate(d.getDate() + 1) // Sunday-start shift
    const year = d.getFullYear()
    const jan4 = new Date(year, 0, 4)
    const startOfW1 = new Date(jan4)
    startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
    const diff = d.getTime() - startOfW1.getTime()
    const weekNum = 1 + Math.floor(diff / (7 * 86400000))
    return `${year}-W${String(weekNum).padStart(2, '0')}`
  } catch {
    return currentIsoWeek()
  }
}

function weekDateRange(weekStr: string): [string, string] {
  const [yearStr, wkStr] = weekStr.split('-W')
  const year = parseInt(yearStr)
  const wk = parseInt(wkStr)
  const jan4 = new Date(year, 0, 4)
  const startOfW1 = new Date(jan4)
  startOfW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7)) // Monday of ISO W1
  const monday = new Date(startOfW1)
  monday.setDate(startOfW1.getDate() + (wk - 1) * 7)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() - 1) // Sunday before Monday = week start
  const nextSunday = new Date(sunday)
  nextSunday.setDate(sunday.getDate() + 7) // Following Sunday
  return [sunday.toISOString().split('T')[0], nextSunday.toISOString().split('T')[0]]
}

function activeStatusClause(column = 'status'): string {
  const placeholders = ACTIVE_STATUSES.map(s => `'${s}'`).join(', ')
  return `${column} IN (${placeholders})`
}

// ═══════════════════════════════════════════
//  WEEK
// ═══════════════════════════════════════════

export function ensureWeek(week?: string): string {
  week = week || currentIsoWeek()
  const existing = db.prepare('SELECT id FROM weeks WHERE week = ?').get(week)
  if (!existing) {
    db.prepare('INSERT INTO weeks (week, created_at) VALUES (?, ?)').run(
      week, new Date().toISOString()
    )
  }
  return week
}

export function getWeekData(week?: string): Week | undefined {
  week = week || currentIsoWeek()
  ensureWeek(week)
  return db.prepare('SELECT * FROM weeks WHERE week = ?').get(week) as Week | undefined
}

export function updateChallenges(week: string, text: string): void {
  ensureWeek(week)
  db.prepare('UPDATE weeks SET challenges = ? WHERE week = ?').run(text, week)
}

export function updateMeetingsHeld(week: string, count: number): void {
  ensureWeek(week)
  db.prepare('UPDATE weeks SET meetings_held = ? WHERE week = ?').run(count, week)
}

// ═══════════════════════════════════════════
//  TASKS
// ═══════════════════════════════════════════

export function getTasks(
  week?: string, status?: string, source?: string, priority?: string
): Task[] {
  week = week || currentIsoWeek()
  let query = 'SELECT * FROM tasks WHERE week = ?'
  const params: (string | number)[] = [week]

  if (status) {
    query += ' AND status = ?'
    params.push(status)
  }
  if (source) {
    if (source === 'voice_notes') {
      query += " AND source IN ('voice_notes', 'transcript')"
    } else {
      query += ' AND source = ?'
      params.push(source)
    }
  }
  if (priority) {
    query += ' AND priority = ?'
    params.push(priority)
  }
  query += ` ORDER BY CASE status
    WHEN 'needs_input' THEN 0
    WHEN 'draft_ready' THEN 1
    WHEN 'in_progress' THEN 2
    WHEN 'open' THEN 3
    WHEN 'waiting' THEN 4
    WHEN 'blocked' THEN 5
    ELSE 6 END,
    sort_order ASC,
    CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
    due_date`

  return db.prepare(query).all(...params) as Task[]
}

export function getCompletedInWeek(week?: string): Task[] {
  week = week || currentIsoWeek()
  const [sun, nextSun] = weekDateRange(week)
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'done' AND completed_at >= ? AND completed_at < ? ORDER BY completed_at DESC"
  ).all(sun, nextSun) as Task[]
}

export function createTask(opts: {
  title: string; source?: string; source_id?: string | null; priority?: string;
  due_date?: string | null; company_name?: string | null; deal_name?: string | null;
  notes?: string | null; week?: string; project_id?: string | null;
}): number {
  const week = ensureWeek(opts.week)
  const createdAt = new Date().toISOString()
  const source = opts.source || 'manual'
  const triagedAt = INBOX_SOURCES.has(source) ? null : createdAt

  const maxOrderRow = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM tasks WHERE week = ?'
  ).get(week) as { max_order: number }
  const sortOrder = maxOrderRow.max_order + 1

  const result = db.prepare(
    `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
       company_name, deal_name, notes, week, sort_order, created_at, triaged_at, project_id)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.title, source, opts.source_id ?? null,
    opts.priority || 'medium', opts.due_date ?? null,
    opts.company_name ?? null, opts.deal_name ?? null,
    opts.notes ?? null, week, sortOrder, createdAt, triagedAt,
    opts.project_id ?? null
  )
  return result.lastInsertRowid as number
}

export function toggleTask(taskId: number): Task | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  if (!task) return null

  if (ACTIVE_STATUSES.includes(task.status)) {
    db.prepare(
      "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), taskId)
  } else {
    db.prepare(
      "UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?"
    ).run(taskId)
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task
}

export function setTaskInProgress(taskId: number): void {
  db.prepare(
    `UPDATE tasks SET status = 'in_progress', triaged_at = COALESCE(triaged_at, ?)
     WHERE id = ? AND ${activeStatusClause()} AND status != 'in_progress'`
  ).run(new Date().toISOString(), taskId)
}

export function getTaskById(taskId: number): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
}

export function getTasksByProject(projectId: string): Task[] {
  return db.prepare(
    `SELECT * FROM tasks WHERE project_id = ?
     ORDER BY CASE status
       WHEN 'needs_input' THEN 0 WHEN 'draft_ready' THEN 1 WHEN 'in_progress' THEN 2
       WHEN 'open' THEN 3 WHEN 'waiting' THEN 4 WHEN 'blocked' THEN 5
       WHEN 'done' THEN 6 ELSE 7 END,
     sort_order ASC,
     CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END`
  ).all(projectId) as Task[]
}

export function setTaskProject(taskId: number, projectId: string | null): void {
  db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(projectId, taskId)
}

export function reorderTasks(taskIds: number[]): void {
  const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?')
  const transaction = db.transaction(() => {
    for (let idx = 0; idx < taskIds.length; idx++) {
      stmt.run(idx, taskIds[idx])
    }
  })
  transaction()
}

export function updateTaskFields(taskId: number, fields: Record<string, unknown>): void {
  const allowed = new Set(['title', 'priority', 'company_name', 'deal_name', 'due_date', 'notes', 'scheduled_at'])
  const updates: [string, unknown][] = []
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.has(k) && v !== undefined) {
      updates.push([k, v])
    }
  }
  if (updates.length === 0) return

  const setClause = updates.map(([k]) => `${k} = ?`).join(', ')
  const values = updates.map(([, v]) => v)
  db.prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...values, taskId)
}

export function updateTaskStatus(taskId: number, status: string): boolean {
  if (!(status in STATUS_LABELS)) return false
  if (status === 'done') {
    db.prepare(
      'UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?'
    ).run(status, new Date().toISOString(), taskId)
  } else {
    db.prepare(
      'UPDATE tasks SET status = ?, completed_at = NULL WHERE id = ?'
    ).run(status, taskId)
  }
  return true
}

export function updateTaskNotes(taskId: number, notes: string): void {
  db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(notes, taskId)
}

export function taskExistsBySource(source: string, sourceId: string): boolean {
  const row = db.prepare('SELECT id FROM tasks WHERE source = ? AND source_id = ?').get(source, sourceId)
  return !!row
}

export function taskExistsByTitle(title: string, week: string): boolean {
  const row = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(title, week)
  return !!row
}

// ═══════════════════════════════════════════
//  INBOX
// ═══════════════════════════════════════════

export function markTaskTriaged(taskId: number): void {
  db.prepare(
    'UPDATE tasks SET triaged_at = COALESCE(triaged_at, ?) WHERE id = ?'
  ).run(new Date().toISOString(), taskId)
}

export function getInboxTasks(week?: string): Task[] {
  week = week || currentIsoWeek()
  const sources = [...INBOX_SOURCES].sort()
  const placeholders = sources.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM tasks WHERE week = ? AND source IN (${placeholders})
     AND triaged_at IS NULL AND ${activeStatusClause()}
     ORDER BY created_at DESC, sort_order ASC`
  ).all(week, ...sources) as Task[]
}

export function getInboxCount(week?: string): number {
  week = week || currentIsoWeek()
  const sources = [...INBOX_SOURCES].sort()
  const placeholders = sources.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM tasks WHERE week = ?
     AND source IN (${placeholders})
     AND triaged_at IS NULL AND ${activeStatusClause()}`
  ).get(week, ...sources) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

// ═══════════════════════════════════════════
//  RECURRING TASKS
// ═══════════════════════════════════════════

export function getRecurringTasks(): RecurringTask[] {
  return db.prepare('SELECT * FROM recurring_tasks ORDER BY created_at').all() as RecurringTask[]
}

export function addRecurringTask(
  title: string, priority = 'medium',
  company_name?: string | null, deal_name?: string | null, notes?: string | null
): number {
  const result = db.prepare(
    'INSERT INTO recurring_tasks (title, priority, company_name, deal_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, priority, company_name ?? null, deal_name ?? null, notes ?? null, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function removeRecurringTask(recurringId: number): void {
  db.prepare('DELETE FROM recurring_tasks WHERE id = ?').run(recurringId)
}

export function makeTaskRecurring(taskId: number): number | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  if (!task) return null
  const existing = db.prepare('SELECT id FROM recurring_tasks WHERE title = ?').get(task.title) as { id: number } | undefined
  if (existing) return existing.id
  const result = db.prepare(
    'INSERT INTO recurring_tasks (title, priority, company_name, deal_name, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(task.title, task.priority, task.company_name, task.deal_name, task.notes, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function unmakeTaskRecurring(taskId: number): void {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined
  if (task) {
    db.prepare('DELETE FROM recurring_tasks WHERE title = ?').run(task.title)
  }
}

export function isTaskRecurring(title: string): boolean {
  const row = db.prepare('SELECT id FROM recurring_tasks WHERE title = ?').get(title)
  return !!row
}

export function spawnRecurringForWeek(week?: string): number {
  week = ensureWeek(week || currentIsoWeek())
  const templates = db.prepare('SELECT * FROM recurring_tasks').all() as RecurringTask[]
  let count = 0
  for (const t of templates) {
    const existing = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(t.title, week)
    if (!existing) {
      db.prepare(
        `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
           company_name, deal_name, notes, week, created_at)
           VALUES (?, 'recurring', ?, ?, 'open', NULL, ?, ?, ?, ?, ?)`
      ).run(t.title, String(t.id), t.priority, t.company_name, t.deal_name, t.notes, week, new Date().toISOString())
      count++
    }
  }
  return count
}

// ═══════════════════════════════════════════
//  POPULATE TASK FLAGS (bulk queries)
// ═══════════════════════════════════════════

export function populateTaskFlags(tasks: Task[]): Task[] {
  if (tasks.length === 0) return tasks

  const taskIds = tasks.filter(t => t.id != null).map(t => t.id)
  const titles = [...new Set(tasks.filter(t => t.title).map(t => t.title))]

  let cachedIds = new Set<number>()
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT task_id FROM delegate_cache WHERE task_id IN (${placeholders})`
    ).all(...taskIds) as { task_id: number }[]
    cachedIds = new Set(rows.map(r => r.task_id))
  }

  let recurringTitles = new Set<string>()
  if (titles.length > 0) {
    const placeholders = titles.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT title FROM recurring_tasks WHERE title IN (${placeholders})`
    ).all(...titles) as { title: string }[]
    recurringTitles = new Set(rows.map(r => r.title))
  }

  for (const task of tasks) {
    task.has_cache = cachedIds.has(task.id)
    task.is_recurring = recurringTitles.has(task.title)
  }

  return tasks
}

// ═══════════════════════════════════════════
//  DELEGATE CACHE
// ═══════════════════════════════════════════

export function getCachedDelegate(taskId: number): DelegateCache | undefined {
  return db.prepare('SELECT * FROM delegate_cache WHERE task_id = ?').get(taskId) as DelegateCache | undefined
}

export function saveDelegateCache(
  taskId: number, plan: string, context: string,
  cost: number, turns: number, error: string | null,
  sessionId?: string | null
): void {
  db.prepare(
    `INSERT INTO delegate_cache (task_id, plan, context, cost, turns, error, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       plan=excluded.plan, context=excluded.context, cost=excluded.cost,
       turns=excluded.turns, error=excluded.error,
       session_id=COALESCE(excluded.session_id, delegate_cache.session_id),
       created_at=excluded.created_at`
  ).run(taskId, plan, context, cost, turns, error, sessionId ?? null, new Date().toISOString())
}

export function clearDelegateCache(taskId: number): void {
  db.prepare('DELETE FROM delegate_cache WHERE task_id = ?').run(taskId)
}

// ═══════════════════════════════════════════
//  DELEGATE EXECUTIONS
// ═══════════════════════════════════════════

export function createExecution(taskId: number): number {
  const result = db.prepare(
    "INSERT INTO delegate_executions (task_id, status, started_at) VALUES (?, 'running', ?)"
  ).run(taskId, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function updateExecution(execId: number, status: string, output?: string | null, cost = 0): void {
  db.prepare(
    'UPDATE delegate_executions SET status = ?, output = ?, cost = ?, completed_at = ? WHERE id = ?'
  ).run(status, output ?? null, cost, new Date().toISOString(), execId)
}

export function getExecution(execId: number): DelegateExecution | undefined {
  return db.prepare('SELECT * FROM delegate_executions WHERE id = ?').get(execId) as DelegateExecution | undefined
}

export function getLatestExecution(taskId: number): DelegateExecution | undefined {
  return db.prepare(
    'SELECT * FROM delegate_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(taskId) as DelegateExecution | undefined
}

// ═══════════════════════════════════════════
//  DELEGATE MESSAGES
// ═══════════════════════════════════════════

export function addDelegateMessage(
  taskId: number, role: string, content: string, cost = 0, turns = 0
): void {
  db.prepare(
    'INSERT INTO delegate_messages (task_id, role, content, cost, turns, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(taskId, role, content, cost, turns, new Date().toISOString())
}

export function getDelegateMessages(taskId: number): DelegateMessage[] {
  return db.prepare(
    'SELECT * FROM delegate_messages WHERE task_id = ? ORDER BY created_at'
  ).all(taskId) as DelegateMessage[]
}

export function clearDelegateMessages(taskId: number): void {
  db.prepare('DELETE FROM delegate_messages WHERE task_id = ?').run(taskId)
}

export function getDelegateMessageCount(taskId: number, role = 'user'): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM delegate_messages WHERE task_id = ? AND role = ?'
  ).get(taskId, role) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

// ═══════════════════════════════════════════
//  TASK SESSIONS (conversation history)
// ═══════════════════════════════════════════

export interface TaskSession {
  id: number
  task_id: number
  transcript: string
  summary: string | null
  started_at: string
  ended_at: string | null
}

export function createTaskSession(taskId: number): number {
  const result = db.prepare(
    'INSERT INTO task_sessions (task_id, started_at) VALUES (?, ?)'
  ).run(taskId, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function endTaskSession(sessionId: number, transcript: string): void {
  db.prepare(
    'UPDATE task_sessions SET transcript = ?, ended_at = ? WHERE id = ?'
  ).run(transcript, new Date().toISOString(), sessionId)
}

export function saveSessionSummary(sessionId: number, summary: string): void {
  db.prepare(
    'UPDATE task_sessions SET summary = ? WHERE id = ?'
  ).run(summary, sessionId)
}

export function getTaskSessions(taskId: number, limit = 10): TaskSession[] {
  return db.prepare(
    'SELECT * FROM task_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(taskId, limit) as TaskSession[]
}

export function getActiveTaskSession(taskId: number): TaskSession | undefined {
  return db.prepare(
    'SELECT * FROM task_sessions WHERE task_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
  ).get(taskId) as TaskSession | undefined
}

// ═══════════════════════════════════════════
//  UPLOADS
// ═══════════════════════════════════════════

export function saveUpload(
  taskId: number, filename: string, storedName: string,
  mimeType: string, size: number, messageId?: number | null
): number {
  const result = db.prepare(
    `INSERT INTO uploads (task_id, message_id, filename, stored_name, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(taskId, messageId ?? null, filename, storedName, mimeType, size, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function getUploadsForTask(taskId: number): Upload[] {
  return db.prepare(
    'SELECT * FROM uploads WHERE task_id = ? ORDER BY created_at'
  ).all(taskId) as Upload[]
}

export function getUploadsForMessage(messageId: number): Upload[] {
  return db.prepare(
    'SELECT * FROM uploads WHERE message_id = ? ORDER BY created_at'
  ).all(messageId) as Upload[]
}

export function getPendingUploads(taskId: number): Upload[] {
  return db.prepare(
    'SELECT * FROM uploads WHERE task_id = ? AND message_id IS NULL ORDER BY created_at'
  ).all(taskId) as Upload[]
}

export function linkUploadsToMessage(taskId: number, messageId: number): void {
  db.prepare(
    'UPDATE uploads SET message_id = ? WHERE task_id = ? AND message_id IS NULL'
  ).run(messageId, taskId)
}

export function deleteUpload(id: number): string | null {
  const row = db.prepare('SELECT stored_name FROM uploads WHERE id = ?').get(id) as { stored_name: string } | undefined
  if (!row) return null
  db.prepare('DELETE FROM uploads WHERE id = ?').run(id)
  return row.stored_name
}

// ═══════════════════════════════════════════
//  SCHEDULED TASKS
// ═══════════════════════════════════════════

export function getScheduledDueTasks(): Task[] {
  const now = new Date().toISOString()
  return db.prepare(
    `SELECT * FROM tasks WHERE ${activeStatusClause()} AND scheduled_at IS NOT NULL AND scheduled_at <= ?`
  ).all(now) as Task[]
}

export function clearScheduledAt(taskId: number): void {
  db.prepare('UPDATE tasks SET scheduled_at = NULL WHERE id = ?').run(taskId)
}

// ═══════════════════════════════════════════
//  FOLDERS
// ═══════════════════════════════════════════

export function getFolders(week?: string, source?: string, priority?: string): Folder[] {
  week = week || currentIsoWeek()
  const foldersRows = db.prepare('SELECT * FROM folders ORDER BY sort_order, created_at').all() as Folder[]

  let query = `SELECT * FROM tasks WHERE week = ? AND folder_id IS NOT NULL AND ${activeStatusClause()}`
  const params: (string | number)[] = [week]

  if (source) {
    if (source === 'voice_notes') {
      query += " AND source IN ('voice_notes', 'transcript')"
    } else {
      query += ' AND source = ?'
      params.push(source)
    }
  }
  if (priority) {
    query += ' AND priority = ?'
    params.push(priority)
  }
  query += ' ORDER BY sort_order, created_at'

  const tasksRows = db.prepare(query).all(...params) as Task[]

  // Group tasks by folder_id
  const tasksByFolder = new Map<number, Task[]>()
  for (const t of tasksRows) {
    if (t.folder_id == null) continue
    if (!tasksByFolder.has(t.folder_id)) tasksByFolder.set(t.folder_id, [])
    tasksByFolder.get(t.folder_id)!.push(t)
  }

  let folders = foldersRows.map(f => ({
    ...f,
    tasks: tasksByFolder.get(f.id) || [],
  }))

  if (source || priority) {
    folders = folders.filter(f => f.tasks!.length > 0)
  }

  return folders
}

export function getOpenUnfoldered(week?: string, source?: string, priority?: string): Task[] {
  const tasks = getTasks(week, undefined, source, priority)
  return tasks.filter(t => ACTIVE_STATUSES.includes(t.status) && !t.folder_id)
}

export function createFolder(name: string, color?: string): number {
  if (!color) {
    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM folders').get() as { cnt: number }
    color = FOLDER_COLORS[countRow.cnt % FOLDER_COLORS.length]
  }
  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM folders').get() as { max_order: number }
  const result = db.prepare(
    'INSERT INTO folders (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)'
  ).run(name, color, maxRow.max_order + 1, new Date().toISOString())
  return result.lastInsertRowid as number
}

export function renameFolder(folderId: number, name: string): void {
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, folderId)
}

export function toggleFolderCollapse(folderId: number): void {
  db.prepare('UPDATE folders SET collapsed = NOT collapsed WHERE id = ?').run(folderId)
}

export function deleteFolder(folderId: number): void {
  db.prepare('UPDATE tasks SET folder_id = NULL WHERE folder_id = ?').run(folderId)
  db.prepare('DELETE FROM folders WHERE id = ?').run(folderId)
}

export function setTaskFolder(taskId: number, folderId?: number | null): void {
  db.prepare('UPDATE tasks SET folder_id = ? WHERE id = ?').run(folderId ?? null, taskId)
}

export function updateFolderColor(folderId: number, color: string): void {
  db.prepare('UPDATE folders SET color = ? WHERE id = ?').run(color, folderId)
}

export function reorderFolders(folderIds: number[]): void {
  const stmt = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?')
  const transaction = db.transaction(() => {
    for (let idx = 0; idx < folderIds.length; idx++) {
      stmt.run(idx, folderIds[idx])
    }
  })
  transaction()
}

// ═══════════════════════════════════════════
//  ROLLOVER
// ═══════════════════════════════════════════

export function rolloverWeek(fromWeek: string, toWeek: string): number {
  ensureWeek(toWeek)
  const incomplete = db.prepare(
    `SELECT * FROM tasks WHERE week = ? AND ${activeStatusClause()}`
  ).all(fromWeek) as Task[]
  let count = 0
  for (const task of incomplete) {
    const existing = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(task.title, toWeek)
    if (existing) continue
    db.prepare(
      `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
         company_name, deal_name, notes, week, created_at, folder_id)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    ).run(task.title, task.source, task.source_id, task.priority,
      task.due_date, task.company_name, task.deal_name, task.notes,
      toWeek, new Date().toISOString(), task.folder_id ?? null)
    db.prepare("UPDATE tasks SET status = 'carried' WHERE id = ?").run(task.id)
    count++
  }
  return count
}

/** Roll over incomplete tasks from ALL prior weeks into the current week. */
export function rolloverAllPriorWeeks(): number {
  const toWeek = currentIsoWeek()
  ensureWeek(toWeek)
  const incomplete = db.prepare(
    `SELECT * FROM tasks WHERE week < ? AND ${activeStatusClause()} AND status != 'carried'`
  ).all(toWeek) as Task[]
  let count = 0
  for (const task of incomplete) {
    const existing = db.prepare('SELECT id FROM tasks WHERE title = ? AND week = ?').get(task.title, toWeek)
    if (existing) continue
    db.prepare(
      `INSERT INTO tasks (title, source, source_id, priority, status, due_date,
         company_name, deal_name, notes, week, created_at, folder_id)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
    ).run(task.title, task.source, task.source_id, task.priority,
      task.due_date, task.company_name, task.deal_name, task.notes,
      toWeek, new Date().toISOString(), task.folder_id ?? null)
    db.prepare("UPDATE tasks SET status = 'carried' WHERE id = ?").run(task.id)
    count++
  }
  return count
}

/** One-time repair: restore folder_id on rolled-over tasks that lost it. */
export function repairRolloverFolders(): number {
  // Find tasks marked 'carried' that had a folder_id — their rolled-over copies
  // (matched by title) in later weeks are missing folder_id.
  const carried = db.prepare(
    `SELECT title, folder_id, week FROM tasks WHERE status = 'carried' AND folder_id IS NOT NULL`
  ).all() as { title: string; folder_id: number; week: string }[]
  let fixed = 0
  for (const src of carried) {
    const result = db.prepare(
      `UPDATE tasks SET folder_id = ? WHERE title = ? AND week > ? AND folder_id IS NULL AND ${activeStatusClause()}`
    ).run(src.folder_id, src.title, src.week)
    fixed += result.changes
  }
  return fixed
}

// ═══════════════════════════════════════════
//  SOURCE-LEVEL STATUS UPDATE (for sync)
// ═══════════════════════════════════════════

export function updateTaskStatusBySource(source: string, sourceId: string, newStatus: string): void {
  const task = db.prepare(
    'SELECT id, status FROM tasks WHERE source = ? AND source_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(source, sourceId) as { id: number; status: string } | undefined
  if (task && task.status !== newStatus && task.status !== 'carried') {
    if (newStatus === 'done') {
      db.prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?").run(task.id)
    } else {
      db.prepare("UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?").run(task.id)
    }
  }
}

// ═══════════════════════════════════════════
//  PTY SCROLLBACK PERSISTENCE
// ═══════════════════════════════════════════

export function savePtyScrollback(ptyId: string, scrollback: string): void {
  db.prepare(
    `INSERT INTO pty_scrollback (pty_id, scrollback, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(pty_id) DO UPDATE SET scrollback = excluded.scrollback, updated_at = excluded.updated_at`
  ).run(ptyId, scrollback)
}

export function loadPtyScrollback(ptyId: string): string {
  const row = db.prepare('SELECT scrollback FROM pty_scrollback WHERE pty_id = ?').get(ptyId) as { scrollback: string } | undefined
  return row?.scrollback || ''
}

export function deletePtyScrollback(ptyId: string): void {
  db.prepare('DELETE FROM pty_scrollback WHERE pty_id = ?').run(ptyId)
}

export function savePtyScrollbackBatch(entries: Array<{ ptyId: string; scrollback: string }>): void {
  const stmt = db.prepare(
    `INSERT INTO pty_scrollback (pty_id, scrollback, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(pty_id) DO UPDATE SET scrollback = excluded.scrollback, updated_at = excluded.updated_at`
  )
  const tx = db.transaction(() => {
    for (const { ptyId, scrollback } of entries) {
      stmt.run(ptyId, scrollback)
    }
  })
  tx()
}

// ═══════════════════════════════════════════
//  BROWSER TAB PERSISTENCE
// ═══════════════════════════════════════════

export function saveBrowserTabs(taskId: number, tabs: { url: string; title: string }[], activeIndex: number): void {
  db.prepare(
    `INSERT INTO browser_tabs (task_id, tabs_json, active_index, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(task_id) DO UPDATE SET tabs_json = excluded.tabs_json, active_index = excluded.active_index, updated_at = excluded.updated_at`
  ).run(taskId, JSON.stringify(tabs), activeIndex)
}

export function loadBrowserTabs(taskId: number): { tabs: { url: string; title: string }[]; activeIndex: number } | null {
  const row = db.prepare('SELECT tabs_json, active_index FROM browser_tabs WHERE task_id = ?').get(taskId) as { tabs_json: string; active_index: number } | undefined
  if (!row) return null
  try {
    return { tabs: JSON.parse(row.tabs_json), activeIndex: row.active_index }
  } catch {
    return null
  }
}

export function deleteBrowserTabs(taskId: number): void {
  db.prepare('DELETE FROM browser_tabs WHERE task_id = ?').run(taskId)
}

// ═══════════════════════════════════════════
//  TOOLS / INTEGRATIONS
// ═══════════════════════════════════════════

export function getTools(): Tool[] {
  return db.prepare('SELECT * FROM tools ORDER BY is_builtin DESC, name ASC').all() as Tool[]
}

export function getToolById(toolId: number): Tool | undefined {
  return db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId) as Tool | undefined
}

export function createTool(tool: {
  name: string
  description?: string
  category?: string
  connection_type?: string
  status?: string
  config?: string
  icon?: string
  capabilities?: string
  account?: string
  details?: string
  is_builtin?: number
}): Tool {
  const now = new Date().toISOString()
  const result = db.prepare(
    `INSERT INTO tools (name, description, category, connection_type, status, config, icon, capabilities, account, details, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tool.name,
    tool.description || '',
    tool.category || 'Custom',
    tool.connection_type || 'MCP',
    tool.status || 'disconnected',
    tool.config || null,
    tool.icon || null,
    tool.capabilities || null,
    tool.account || null,
    tool.details || null,
    tool.is_builtin || 0,
    now,
    now,
  )
  return getToolById(result.lastInsertRowid as number)!
}

export function updateTool(toolId: number, fields: Record<string, unknown>): void {
  const allowed = new Set(['name', 'description', 'category', 'connection_type', 'status', 'config', 'icon', 'capabilities', 'account', 'details'])
  const updates: [string, unknown][] = []
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.has(k) && v !== undefined) {
      updates.push([k, v])
    }
  }
  if (updates.length === 0) return
  updates.push(['updated_at', new Date().toISOString()])

  const setClause = updates.map(([k]) => `${k} = ?`).join(', ')
  const values = updates.map(([, v]) => v)
  db.prepare(`UPDATE tools SET ${setClause} WHERE id = ?`).run(...values, toolId)
}

export function deleteTool(toolId: number): void {
  db.prepare('DELETE FROM tools WHERE id = ? AND is_builtin = 0').run(toolId)
}
