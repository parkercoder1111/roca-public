import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

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
  // forked_session_id: Claude Code session UUID a forked task should resume from.
  // When set, the task's terminal auto-launches `claude --resume <id> --fork-session`
  // so the new conversation starts from the source's context but diverges independently.
  alterSafe('ALTER TABLE tasks ADD COLUMN forked_session_id TEXT')
  // forked_source_cwd: the source task's cwd at fork time. The new task's PTY opens
  // here so `claude --resume <forked_session_id>` can find the copied JSONL (Claude
  // only looks in the current cwd's project dir, not across all of them).
  alterSafe('ALTER TABLE tasks ADD COLUMN forked_source_cwd TEXT')
  // browser_companion_of: dormant column from the abandoned "browser
  // companion" experiment. Kept so the companion_cleanup_v2 migration
  // below can reference it; fresh installs get a NULL column that
  // nothing reads. Safe to drop in a future pass once everyone has
  // booted the cleanup at least once.
  alterSafe('ALTER TABLE tasks ADD COLUMN browser_companion_of INTEGER')
  // merged_into_task_id: when set, this row is a tombstone for a task that
  // was merged into another. Preserves (source, source_id) so re-syncs from
  // meeting_notes/voice_notes/crm/google_tasks see it via taskExistsBySource()
  // and skip recreation. UI queries filter on `merged_into_task_id IS NULL` so
  // the tombstone is invisible everywhere.
  alterSafe('ALTER TABLE tasks ADD COLUMN merged_into_task_id INTEGER')

  // ── New tables (idempotent) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_tabs (
      task_id INTEGER PRIMARY KEY,
      tabs_json TEXT NOT NULL DEFAULT '[]',
      active_index INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- ── Echo dictation (fn-to-talk) ──
    -- Every edit the user makes to text Echo pasted, captured as ground truth.
    CREATE TABLE IF NOT EXISTS dictation_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      app TEXT,
      raw_transcript TEXT NOT NULL DEFAULT '',
      pasted TEXT NOT NULL DEFAULT '',
      corrected TEXT NOT NULL DEFAULT '',
      learned INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dictation_corrections_learned ON dictation_corrections(learned);

    -- Distilled proper-noun / jargon fixes (heard -> canonical spelling).
    CREATE TABLE IF NOT EXISTS dictation_dictionary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      heard TEXT NOT NULL,
      canonical TEXT NOT NULL,
      hits INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(heard, canonical)
    );

    -- Distilled durable style preferences (one note per row).
    CREATE TABLE IF NOT EXISTS dictation_style (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Scribe (meeting note-taker) ──
    -- One row per recorded meeting; audio is deleted after transcription.
    CREATE TABLE IF NOT EXISTS scribe_recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_event_id TEXT,
      title TEXT NOT NULL DEFAULT 'Untitled meeting',
      attendees_json TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'recording',
      cleaned_transcript TEXT,
      notes_md TEXT,
      summary TEXT,
      memory_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Raw me/them transcript (source of truth); cleaned text lives on the recording row.
    CREATE TABLE IF NOT EXISTS scribe_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER NOT NULL REFERENCES scribe_recordings(id),
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL DEFAULT 0,
      end_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_scribe_segments_rec ON scribe_segments(recording_id);
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

  // ── Cleanup: companion task model abandoned in favour of top-level
  // dynamic tabs. The earlier v1 backfill created '🌐 <title>' tasks
  // with source='companion' which now show up as orphan top-level rows
  // since their hide-from-weekly-view filter was removed in the pivot.
  // Re-point browser_tabs back at the original parent (if any), drop
  // standalone tabs that have no parent, then delete the companion rows.
  // Gated by its own marker so it runs exactly once.
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`)
  const COMPANION_CLEANUP_KEY = 'companion_cleanup_v2'
  const cleanupRun = db.prepare(
    'SELECT 1 FROM app_settings WHERE key = ? LIMIT 1'
  ).get(COMPANION_CLEANUP_KEY)

  if (!cleanupRun) {
    try {
      const cleanupTx = db.transaction(() => {
        // Re-point browser_tabs rows on companions back at their parent.
        db.prepare(`
          UPDATE browser_tabs SET task_id = (
            SELECT t.browser_companion_of FROM tasks t WHERE t.id = browser_tabs.task_id
          )
          WHERE EXISTS (
            SELECT 1 FROM tasks t WHERE t.id = browser_tabs.task_id
              AND t.source = 'companion' AND t.browser_companion_of IS NOT NULL
          )
        `).run()
        // Standalone companions (no parent) — drop their browser_tabs rows.
        db.prepare(`
          DELETE FROM browser_tabs WHERE task_id IN (
            SELECT id FROM tasks WHERE source = 'companion' AND browser_companion_of IS NULL
          )
        `).run()
        // Now delete the companion task rows themselves.
        db.prepare("DELETE FROM tasks WHERE source = 'companion'").run()
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, '1')")
          .run(COMPANION_CLEANUP_KEY)
      })
      cleanupTx()
    } catch (err) {
      console.error('[migration] companion_cleanup_v2 failed:', err)
    }
  }
}
