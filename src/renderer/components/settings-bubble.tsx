import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FilePathView } from './file-path-view'

// ═══════════════════════════════════════════
//  SETTINGS
//
//  A full-window overlay (like Claude's settings) with a left sidebar of
//  sections and a right content pane. Triggered by a small gear bubble
//  pinned to the bottom-left corner.
//
//  Sections:
//   - Connections — CRM / Google Workspace / Slack / Outreach with
//     Reconfigure + Disconnect (backed by connections IPC).
//   - Integrations — every webview tool (Gmail, Sheets, Calendar, …) +
//     any custom tools the user added through the + tab.
//   - Agents — launchd background processes; start/stop in place.
//   - Hooks — Claude Code hooks parsed from ~/.claude/settings.json,
//     grouped by event.
//   - Files — embedded FilePathView (was the old pinned 'Files' tab).
// ═══════════════════════════════════════════

type SectionId = 'integrations' | 'messaging' | 'mcp' | 'agents' | 'hooks' | 'files'

interface SectionMeta {
  id: SectionId
  label: string
  // Inline SVG path data (24x24) — keeps the bundle dependency-free
  icon: string
  // Plain-language description shown at the top of the section.
  description: string
}

const SECTIONS: SectionMeta[] = [
  {
    id: 'integrations',
    label: 'Integrations',
    icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
    description:
      'External services ROCA reads from or writes to. Each row shows whether the connection is live, the account it\'s using, and how to reconfigure or disconnect.',
  },
  {
    id: 'messaging',
    label: 'Messaging',
    icon: 'M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    description:
      'The credentials your agents use to send messages — Slack as you, Slack as a bot, or email from your Gmail. Each one is independent.',
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: 'M4 5h16M4 12h16M4 19h16',
    description:
      'Model Context Protocol servers Claude Code talks to — tools, data sources, integrations. Add a server here and Claude in this repo (and any new session) sees it on next launch.',
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z',
    description:
      'Background processes that run on a schedule (like cron jobs). They keep your CRM in sync, evaluate companies, send daily reports, etc. Stop one if it\'s misbehaving, start it back up when you\'re ready.',
  },
  {
    id: 'hooks',
    label: 'Hooks',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    description:
      'Scripts that Claude Code runs automatically when something happens — e.g., when you submit a prompt, before a tool call, when a session ends. They enforce rules and inject context without you having to remember.',
  },
  {
    id: 'files',
    label: 'Files',
    icon: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
    description:
      'Browse the project files behind ROCA — agent prompts, skills, state files, daily notes. Same view as the old Files tab.',
  },
]

// Plain-language descriptions for each launchd agent. Hardcoded by label so
// they stay accurate even if the backend roster reshuffles. Falls back to a
// generic message for any unknown label.
const AGENT_DESCRIPTIONS: Record<string, string> = {
  'com.example.data-sync':
    'Pulls records from an external source on a schedule and adds new items to a queue.',
  'com.example.scorer':
    'Scores each item in the queue against your criteria and writes a verdict.',
  'com.example.enrichment':
    'Enriches records with extra data. Verifies the matches and flags weak ones.',
  'com.example.sync-back':
    'Syncs activity back into your source system so it reflects real-world changes.',
  'com.example.audit':
    'Sweeps your records for inconsistencies — duplicates, missing fields, stale entries.',
  'com.example.slack-monitor':
    'Slack monitor — answers DMs, surfaces alerts, posts summaries to the channels you watch.',
  'com.example.daily-digest':
    'End-of-day digest emailed to you: what happened and what\'s queued for tomorrow.',
  'com.example.watchdog':
    'Watchdog that keeps the full pipeline running end-to-end.',
  'com.example.bug-catcher':
    'Scans app outputs for crashes/errors and files repro reports so you don\'t lose silent failures.',
}

// Plain-language descriptions for each Claude Code hook event.
const HOOK_EVENT_DESCRIPTIONS: Record<string, string> = {
  SessionStart:
    'Runs once when you open a new Claude Code session. Good for injecting context, fetching daily notes, etc.',
  SessionEnd:
    'Runs once when the session ends. Often used to persist state or log the session.',
  UserPromptSubmit:
    'Runs every time you submit a prompt. Can inject extra context or log the message.',
  PreToolUse:
    'Runs before Claude calls any tool. Can block dangerous calls or rewrite parameters.',
  PostToolUse:
    'Runs after a tool call returns. Often used to log outcomes or trigger follow-ups.',
  PreCompact:
    'Runs before Claude compresses old conversation history. Saves whatever you need to keep around.',
  Stop:
    'Runs when Claude finishes responding. Often saves a session handoff for next time.',
}

// Per-script descriptions for the hooks the user has wired up. Keyed by
// filename (what listHooks puts in `label`) so the dictionary survives a
// move of the script as long as the filename is stable.
const HOOK_SCRIPT_DESCRIPTIONS: Record<string, string> = {
  'session-core.sh':
    'Session header + app token + archive pointers. Tiny, always-on; per-stream content lives in the sibling session-*.sh hooks.',
  'session-calendar.sh':
    'Injects a rolling Google Calendar window summary from memory/calendar/.',
  'session-slack.sh':
    'Injects the last 10 days of Slack activity (summary; full archive at memory/slack/).',
  'session-gmail.sh':
    'Injects the last 7 days of Gmail (summary; full archive at memory/gmail/).',
  'session-meeting-notes.sh':
    'Injects the last 5 days of meeting-notes summaries (full archive at memory/meeting-notes/).',
  'session-claude.sh':
    'Injects a rollup of the last 7 days of Claude sessions (full transcripts at memory/claude/sessions/).',
  'session-tools.sh':
    'Injects the CLI tool inventory from agents/system/TOOLS.md so the agent knows what scripts it can run.',
  'context.sh':
    'Injects which app tab the user is currently looking at — fires on every prompt submit (~50ms RPC call).',
  'crm-guard.py':
    'Blocks dangerous CRM writes that violate the campaign-field rules (C1→C2→C3→C4 sequential, never overwrite from responses).',
  'pre-compact-flush.sh':
    'Re-runs every SessionStart hook before /compact so post-compaction context stays fresh.',
  'session-handoff.py':
    'On Stop, saves a lightweight session-state snapshot to state/handoffs/ so context survives across sessions.',
}

// ─── Settings entry: floating bubble + full overlay ───────────────────────────
export function SettingsBubble() {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SectionId>('integrations')

  // Cmd+, opens settings, like every other Mac app. ⌘⇧A is owned by app.tsx
  // (toggles the assistant) — Settings deliberately does not handle it so the
  // user stays in Settings while the assistant slides in on top
  // (AssistantOverlay sits at z-[55], above this overlay's z-50).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setOpen(v => !v)
        return
      }
      if (e.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      {/* Trigger bubble — bottom-left */}
      <button
        onClick={() => setOpen(v => !v)}
        title="Settings (⌘,)"
        aria-label="Open settings"
        aria-expanded={open}
        className={`fixed bottom-4 left-4 z-40 w-10 h-10 rounded-full flex items-center justify-center shadow-md transition-all ${
          open
            ? 'bg-purple-1 text-white'
            : 'bg-surface-1 text-text-2 hover:bg-surface-2 hover:text-text-1 border border-roca-border-1'
        }`}
      >
        <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {open && <SettingsOverlay section={section} onSection={setSection} onClose={() => setOpen(false)} />}
    </>
  )
}

// ─── Overlay shell ────────────────────────────────────────────────────────────
function SettingsOverlay({
  section, onSection, onClose,
}: {
  section: SectionId
  onSection: (s: SectionId) => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-surface-0 flex flex-col"
      role="dialog"
      aria-label="Settings"
      aria-modal="true"
    >
      {/* Header — leading padding clears the macOS traffic-light buttons so
          the back arrow stays clickable. Whole bar is window-draggable, only
          the interactive controls opt out. */}
      <div
        className="flex items-center gap-3 pl-[88px] pr-6 py-3 border-b border-roca-border-1 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-black/[0.06] text-text-2 hover:text-text-1 transition-colors"
          title="Back to ROCA (Esc)"
          aria-label="Close settings"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          <span className="text-[12px]">Back</span>
        </button>
        <div>
          <h1 className="text-[15px] font-semibold text-text-1 leading-tight">Settings</h1>
          <p className="text-[11px] text-text-3 leading-tight">
            Everything ROCA connects to or runs in the background — in one place.
          </p>
        </div>
      </div>

      <SettingsBody section={section} onSection={onSection} />
    </div>
  )
}

// Inner body owns cross-section deep-link state (e.g. Messaging → Integrations
// → open the "Google Workspace" setup modal directly).
function SettingsBody({
  section, onSection,
}: {
  section: SectionId
  onSection: (s: SectionId) => void
}) {
  const [autoOpenConnectionId, setAutoOpenConnectionId] = useState<ConnectionId | null>(null)

  const jumpToIntegration = useCallback((id: ConnectionId) => {
    setAutoOpenConnectionId(id)
    onSection('integrations')
  }, [onSection])

  useEffect(() => {
    const listener = () => onSection('mcp')
    document.addEventListener('roca:open-mcp-section', listener)
    return () => document.removeEventListener('roca:open-mcp-section', listener)
  }, [onSection])

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <nav className="w-[200px] shrink-0 border-r border-roca-border-1 overflow-y-auto py-3">
          <ul>
            {SECTIONS.map(s => (
              <li key={s.id}>
                <button
                  onClick={() => onSection(s.id)}
                  className={`w-full text-left flex items-center gap-2 px-5 py-1.5 text-[12px] transition-colors ${
                    section === s.id
                      ? 'bg-surface-2 text-text-1 font-semibold'
                      : 'text-text-2 hover:bg-black/[0.04] hover:text-text-1'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d={s.icon} />
                  </svg>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {section === 'integrations' && (
            <IntegrationsSection
              autoOpenId={autoOpenConnectionId}
              onAutoOpenConsumed={() => setAutoOpenConnectionId(null)}
            />
          )}
          {section === 'messaging'    && <MessagingSection onJumpToIntegration={jumpToIntegration} />}
          {section === 'mcp'          && <McpSection />}
          {section === 'agents'       && <AgentsSection />}
          {section === 'hooks'        && <HooksSection />}
          {section === 'files'        && <FilesSection />}
        </div>
      </div>
  )
}

// ═══════════════════════════════════════════
//  INTEGRATIONS section — external services with credentials/status.
//  (Webview-tool browsing tabs live in the top tab strip's `+` picker.)
// ═══════════════════════════════════════════

type ConnectionId = string
type KeyId = 'crm' | 'outreach' | 'slack-bot'

type SetupSpec =
  | { kind: 'api-key'; keyId: KeyId; envKey: string; placeholder: string; getKeyUrl: string; docsUrl?: string; help: string }
  | { kind: 'slack-oauth'; getKeyUrl: string; help: string }
  | { kind: 'google-oauth'; tokenPath: string; getKeyUrl: string; help: string }
  | { kind: 'external-app'; appName: string; downloadUrl: string; help: string }
  | { kind: 'cli-tool'; binaryPath?: string; version?: string; installUrl: string; help: string }
  | { kind: 'custom-api'; envVarName: string; getKeyUrl?: string; verify?: { url: string; headerName: string; headerTemplate: string }; help: string }
  | { kind: 'custom-cli'; binaryPath?: string; version?: string; installUrl: string; help: string }

interface Connection {
  id: ConnectionId
  name: string
  category: 'CRM' | 'Google Workspace' | 'Messaging' | 'Outreach' | 'Meetings' | 'Developer' | 'Custom'
  status: 'connected' | 'disconnected' | 'unverified'
  account?: string
  details?: string
  disconnectable?: boolean
  isCustom?: boolean
  setup: SetupSpec
}

function IntegrationsSection({
  autoOpenId, onAutoOpenConsumed,
}: {
  autoOpenId?: ConnectionId | null
  onAutoOpenConsumed?: () => void
} = {}) {
  const [items, setItems] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [reconfiguring, setReconfiguring] = useState<Connection | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [addingKind, setAddingKind] = useState<null | 'picker' | 'api' | 'cli'>(null)

  // Deep-link from another section: open the requested integration's setup
  // modal as soon as we have the data for it.
  useEffect(() => {
    if (!autoOpenId || items.length === 0) return
    const target = items.find(i => i.id === autoOpenId)
    if (target) {
      setReconfiguring(target)
      onAutoOpenConsumed?.()
    }
  }, [autoOpenId, items, onAutoOpenConsumed])

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setItems(await window.electronAPI.connectionsList()) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleDisconnect = useCallback(async (c: Connection) => {
    setActionError(null)
    if (!window.confirm(`Disconnect ${c.name}?`)) return
    const result = await window.electronAPI.connectionsDisconnect(c.id)
    if (!result.ok) { setActionError(result.error || 'Disconnect failed'); return }
    await refresh()
  }, [refresh])

  const grouped = useMemo(() => {
    const order: Connection['category'][] = [
      'CRM', 'Google Workspace', 'Messaging', 'Meetings', 'Outreach', 'Developer', 'Custom',
    ]
    const m = new Map<Connection['category'], Connection[]>()
    for (const it of items) {
      if (!m.has(it.category)) m.set(it.category, [])
      m.get(it.category)!.push(it)
    }
    return order.filter(c => m.has(c)).map(c => ({ category: c, items: m.get(c)! }))
  }, [items])

  return (
    <SectionFrame
      title="Integrations"
      subtitle={loading ? 'Loading…' : `${items.filter(i => i.status === 'connected').length} of ${items.length} active`}
      description={descriptionFor('integrations')}
      onRefresh={refresh}
      actions={
        <button
          onClick={() => setAddingKind('picker')}
          className="text-[11px] font-semibold text-white bg-purple-1 hover:opacity-90 px-3 py-1 rounded-md transition-opacity"
        >
          + Add Connection
        </button>
      }
    >
      {actionError && <p className="text-[11px] text-red-1 mb-3">{actionError}</p>}
      {grouped.map(g => (
        <div key={g.category} className="mb-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-2">{g.category}</h3>
          <div className="border border-roca-border-1 rounded-xl overflow-hidden bg-surface-1/50 divide-y divide-roca-border-1">
            {g.items.map(c => (
              <ConnectionRow
                key={c.id}
                connection={c}
                onReconfigure={() => { setReconfiguring(c); setActionError(null) }}
                onDisconnect={() => handleDisconnect(c)}
              />
            ))}
          </div>
        </div>
      ))}
      {reconfiguring && (
        <ReconfigureModal
          connection={reconfiguring}
          onClose={() => setReconfiguring(null)}
          afterAction={refresh}
        />
      )}
      {addingKind === 'picker' && (
        <AddConnectionPicker
          onPick={(k) => setAddingKind(k)}
          onClose={() => setAddingKind(null)}
        />
      )}
      {addingKind === 'api' && (
        <AddApiConnectionModal
          onClose={() => setAddingKind(null)}
          afterAdd={() => { setAddingKind(null); refresh() }}
        />
      )}
      {addingKind === 'cli' && (
        <AddCliConnectionModal
          onClose={() => setAddingKind(null)}
          afterAdd={() => { setAddingKind(null); refresh() }}
        />
      )}
    </SectionFrame>
  )
}

function ConnectionRow({
  connection, onReconfigure, onDisconnect,
}: {
  connection: Connection
  onReconfigure: () => void
  onDisconnect: () => void
}) {
  return (
    <div className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-surface-1 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-1 truncate">{connection.name}</span>
          <StatusBadge status={connection.status} />
        </div>
        {connection.account && <p className="text-[11px] text-text-2 truncate mt-0.5">{connection.account}</p>}
        {connection.details && <p className="text-[10px] text-text-3 truncate mt-0.5">{connection.details}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onReconfigure}
          className={`text-[11px] font-semibold px-3 py-1 rounded-md transition-colors ${
            connection.status === 'connected'
              ? 'text-text-1 hover:bg-black/[0.06]'
              : 'text-white bg-purple-1 hover:opacity-90'
          }`}
        >
          {connection.status === 'connected' ? 'Configure' : 'Set up'}
        </button>
        {connection.status === 'connected' && connection.disconnectable !== false && (
          <button
            onClick={onDisconnect}
            className="text-[11px] font-medium text-red-1 px-2 py-1 rounded-md hover:bg-red-2 transition-colors"
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════
//  MESSAGING section — the credentials that bots use to send messages.
//  Slack: both the user-OAuth token (acts as you) and the bot token
//  (acts as the bot). Email: the shared Google Workspace OAuth used
//  by every agent that sends mail.
// ═══════════════════════════════════════════

interface MessagingToken {
  channel: 'slack' | 'email'
  label: string
  status: 'configured' | 'unconfigured'
  details: string
  managedBy?: ConnectionId
  envKey?: string
  getKeyUrl?: string
  instructions: string
}

function MessagingSection({ onJumpToIntegration }: { onJumpToIntegration: (id: ConnectionId) => void }) {
  const [tokens, setTokens] = useState<MessagingToken[]>([])
  const [loading, setLoading] = useState(true)
  // For the bot token we pop the same inline ApiKeySetup form used in
  // Integrations. We synthesize a Connection-shaped object for the modal.
  const [botSetupOpen, setBotSetupOpen] = useState(false)
  const [connections, setConnections] = useState<Connection[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [t, c] = await Promise.all([
        window.electronAPI.connectionsListMessagingTokens(),
        window.electronAPI.connectionsList(),
      ])
      setTokens(t)
      setConnections(c)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  const slackTokens = tokens.filter(t => t.channel === 'slack')
  const emailTokens = tokens.filter(t => t.channel === 'email')
  const configuredCount = tokens.filter(t => t.status === 'configured').length

  // Synthetic "Slack bot token" connection so we can reuse the ApiKeySetup form.
  const slackBotConnection: Connection = {
    id: 'slack',
    name: 'Slack bot token',
    category: 'Messaging',
    status: slackTokens.find(t => t.label === 'Slack bot token')?.status === 'configured' ? 'connected' : 'disconnected',
    account: undefined,
    details: slackTokens.find(t => t.label === 'Slack bot token')?.details,
    disconnectable: true,
    setup: {
      kind: 'api-key',
      keyId: 'slack-bot',
      envKey: 'SLACK_BOT_TOKEN',
      placeholder: 'xoxb-...',
      getKeyUrl: 'https://api.slack.com/apps',
      help:
        'Create or open your Slack app at api.slack.com/apps → OAuth & Permissions → install to ' +
        'workspace, then paste the Bot User OAuth Token (xoxb-...) here. ROCA verifies it via ' +
        'auth.test before saving.',
    },
  }

  const onConfigureToken = (t: MessagingToken) => {
    if (t.managedBy) {
      onJumpToIntegration(t.managedBy)
      return
    }
    if (t.label === 'Slack bot token') {
      setBotSetupOpen(true)
    }
  }

  return (
    <SectionFrame
      title="Messaging"
      subtitle={loading ? 'Loading…' : `${configuredCount} of ${tokens.length} credentials configured`}
      description={descriptionFor('messaging')}
      onRefresh={refresh}
    >
      <div className="mb-5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-2">Slack</h3>
        <div className="space-y-2">
          {slackTokens.map((t, i) => (
            <TokenRow key={`${t.channel}-${i}`} token={t} onConfigure={() => onConfigureToken(t)} />
          ))}
        </div>
      </div>

      <div className="mb-5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-2">Email</h3>
        <div className="space-y-2">
          {emailTokens.map((t, i) => (
            <TokenRow key={`${t.channel}-${i}`} token={t} onConfigure={() => onConfigureToken(t)} />
          ))}
        </div>
      </div>

      {botSetupOpen && (
        <ReconfigureModal
          connection={slackBotConnection}
          onClose={() => setBotSetupOpen(false)}
          afterAction={refresh}
        />
      )}
      {/* Touch connections so the unused-var lint doesn't fire if we add more uses later. */}
      <span className="hidden">{connections.length}</span>
    </SectionFrame>
  )
}

function TokenRow({ token, onConfigure }: { token: MessagingToken; onConfigure: () => void }) {
  const configured = token.status === 'configured'
  return (
    <div className={`px-3 py-2 rounded-lg border flex items-center justify-between gap-3 ${
      configured ? 'border-roca-border-1 bg-surface-1/50' : 'border-red-2 bg-red-2/30'
    }`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-text-1 truncate">{token.label}</span>
          <StatusBadge status={configured} labelOn="Active" labelOff="Not set" />
        </div>
        <p className="text-[11px] text-text-2 truncate mt-0.5">{token.details}</p>
        <p className="text-[10px] text-text-3 mt-1 leading-snug">{token.instructions}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <button
          onClick={onConfigure}
          className={`text-[11px] font-semibold px-3 py-1 rounded-md transition-colors ${
            configured
              ? 'text-text-1 hover:bg-black/[0.06]'
              : 'text-white bg-purple-1 hover:opacity-90'
          }`}
        >
          {configured ? 'Reconfigure' : 'Set up'}
        </button>
        {token.getKeyUrl && (
          <button
            onClick={() => window.electronAPI.connectionsOpenExternal(token.getKeyUrl!)}
            className="text-[10px] text-purple-1 hover:underline"
          >
            Get key ↗
          </button>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════
//  AGENTS section
// ═══════════════════════════════════════════

interface AgentItem {
  name: string
  label: string
  running: boolean
  pid: number | null
  lastExitCode: number | null
  schedule: string | null
  stateFile: string | null
  alertOwner: boolean
  outputDir: string | null
}

function AgentsSection() {
  const [agents, setAgents] = useState<AgentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setAgents(await window.electronAPI.agentsList()) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  const toggle = useCallback(async (a: AgentItem) => {
    setActionError(null)
    setBusyLabel(a.label)
    try {
      const r = a.running
        ? await window.electronAPI.agentsStop(a.label)
        : await window.electronAPI.agentsStart(a.label)
      if (!r.ok) setActionError(r.error || `Failed to ${a.running ? 'stop' : 'start'} ${a.name}`)
      await refresh()
    } finally {
      setBusyLabel(null)
    }
  }, [refresh])

  const runningCount = agents.filter(a => a.running).length

  return (
    <SectionFrame
      title="Agents"
      subtitle={loading ? 'Loading…' : `${runningCount} of ${agents.length} running`}
      description={descriptionFor('agents')}
      onRefresh={refresh}
    >
      {actionError && <p className="text-[11px] text-red-1 mb-3">{actionError}</p>}
      <div className="border border-roca-border-1 rounded-xl overflow-hidden bg-surface-1/50 divide-y divide-roca-border-1">
        {agents.map(a => (
          <div key={a.label} className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-surface-1 transition-colors">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-text-1 truncate">{a.name}</span>
                <StatusBadge status={a.running} labelOn="Running" labelOff="Stopped" />
                {a.alertOwner && (
                  <span
                    className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded text-red-1 bg-red-2"
                    title="This agent is alerting — check the logs"
                  >
                    Alert
                  </span>
                )}
              </div>
              <p className="text-[11px] text-text-2 mt-0.5 leading-snug">
                {AGENT_DESCRIPTIONS[a.label] ?? 'Background process registered with launchd.'}
              </p>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {a.schedule && (
                  <span className="text-[10px] text-text-3" title="When the agent next runs">
                    ⏱ {a.schedule}
                  </span>
                )}
                {a.pid !== null && (
                  <span className="text-[10px] text-text-3" title="Active process ID">
                    pid {a.pid}
                  </span>
                )}
                {a.lastExitCode !== null && a.lastExitCode !== 0 && (
                  <span className="text-[10px] text-red-1" title="The last run failed with this exit code">
                    last exit {a.lastExitCode}
                  </span>
                )}
                <span className="text-[10px] font-mono text-text-3/70 truncate" title="launchd service label">
                  {a.label}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {a.outputDir && (
                <button
                  onClick={() => window.electronAPI.agentsOpenOutput(a.label)}
                  className="text-[11px] font-medium text-text-2 px-2 py-1 rounded-md hover:bg-black/[0.06] hover:text-text-1 transition-colors"
                  title="Open output folder"
                >
                  Logs
                </button>
              )}
              <button
                onClick={() => toggle(a)}
                disabled={busyLabel === a.label}
                className={`text-[11px] font-medium px-2 py-1 rounded-md transition-colors disabled:opacity-50 ${
                  a.running
                    ? 'text-red-1 hover:bg-red-2'
                    : 'text-green-1 hover:bg-green-2'
                }`}
              >
                {busyLabel === a.label ? '…' : a.running ? 'Stop' : 'Start'}
              </button>
            </div>
          </div>
        ))}
        {!loading && agents.length === 0 && (
          <p className="p-4 text-[12px] text-text-3">No agents registered.</p>
        )}
      </div>
    </SectionFrame>
  )
}

// ═══════════════════════════════════════════
//  HOOKS section
// ═══════════════════════════════════════════

interface HookEntry { event: string; matcher: string; command: string; type: string; label: string }

function HooksSection() {
  const [hooks, setHooks] = useState<HookEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setHooks(await window.electronAPI.connectionsListHooks()) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const grouped = useMemo(() => {
    const m = new Map<string, HookEntry[]>()
    for (const h of hooks) {
      if (!m.has(h.event)) m.set(h.event, [])
      m.get(h.event)!.push(h)
    }
    return Array.from(m.entries())
  }, [hooks])

  return (
    <SectionFrame
      title="Hooks"
      subtitle={loading ? 'Loading…' : `${hooks.length} active across ${grouped.length} events`}
      description={descriptionFor('hooks')}
      onRefresh={refresh}
    >
      <p className="text-[11px] text-text-3 mb-4">
        Read from <code className="bg-surface-1 px-1 rounded">~/.claude/settings.json</code>.
        Edit that file to add or remove hooks; ROCA reflects whatever's there on refresh.
      </p>
      {grouped.map(([event, entries]) => (
        <div key={event} className="mb-4">
          <div className="mb-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-3">{event}</h3>
            {HOOK_EVENT_DESCRIPTIONS[event] && (
              <p className="text-[11px] text-text-2 mt-0.5 leading-snug max-w-[600px]">
                {HOOK_EVENT_DESCRIPTIONS[event]}
              </p>
            )}
          </div>
          <div className="border border-roca-border-1 rounded-xl overflow-hidden bg-surface-1/50 divide-y divide-roca-border-1">
            {entries.map((h, i) => (
              <div key={`${event}-${i}`} className="px-4 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-medium text-text-1 truncate">{h.label}</span>
                  {h.matcher && h.matcher !== '*' ? (
                    <span
                      className="text-[9px] font-mono text-text-2 bg-surface-2 px-1.5 py-0.5 rounded truncate max-w-[280px]"
                      title={`Only fires when the tool name matches: ${h.matcher}`}
                    >
                      matches: {h.matcher}
                    </span>
                  ) : (
                    <span
                      className="text-[9px] font-medium uppercase tracking-wide text-text-3"
                      title="Fires on every event of this type"
                    >
                      always
                    </span>
                  )}
                </div>
                {HOOK_SCRIPT_DESCRIPTIONS[h.label] && (
                  <p className="text-[11px] text-text-2 mt-1 leading-snug max-w-[640px]">
                    {HOOK_SCRIPT_DESCRIPTIONS[h.label]}
                  </p>
                )}
                <p className="text-[10px] font-mono text-text-3 truncate mt-1" title={h.command}>{h.command}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!loading && hooks.length === 0 && (
        <p className="text-[12px] text-text-3">No hooks configured.</p>
      )}
    </SectionFrame>
  )
}

// ═══════════════════════════════════════════
//  FILES section — embedded file browser with an intro line
// ═══════════════════════════════════════════

function FilesSection() {
  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-4 border-b border-roca-border-1 shrink-0">
        <h2 className="text-[16px] font-semibold text-text-1">Files</h2>
        <p className="text-[12px] text-text-2 leading-relaxed mt-1 max-w-[600px]">
          {descriptionFor('files')}
        </p>
      </div>
      <div className="flex-1 overflow-hidden">
        <FilePathView />
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════
//  MCP section
// ═══════════════════════════════════════════

function McpSection() {
  const [data, setData] = useState<{ available: boolean; servers: Array<{ name: string; scope: 'user' | 'project'; command: string; args: string[]; status: 'connected' | 'failed' | 'unknown' }> }>({ available: false, servers: [] })
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setData(await window.electronAPI.connectionsListMcp()) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleRemove = useCallback(async (name: string, scope: 'user' | 'project') => {
    setActionError(null)
    if (!window.confirm(`Remove MCP server "${name}"?`)) return
    const r = await window.electronAPI.connectionsRemoveMcp(name, scope)
    if (!r.ok) { setActionError(r.error || 'Remove failed'); return }
    await refresh()
  }, [refresh])

  const grouped = useMemo(() => {
    const byScope: Record<'user' | 'project', typeof data.servers> = { user: [], project: [] }
    for (const s of data.servers) byScope[s.scope].push(s)
    return [
      { scope: 'user' as const, label: 'User scope (~/.claude.json)', items: byScope.user },
      { scope: 'project' as const, label: 'Project scope (.mcp.json)', items: byScope.project },
    ].filter(g => g.items.length > 0)
  }, [data.servers])

  return (
    <SectionFrame
      title="MCP"
      subtitle={loading ? 'Loading…' : !data.available ? 'Claude CLI not found' : `${data.servers.length} server${data.servers.length === 1 ? '' : 's'}`}
      description={descriptionFor('mcp')}
      onRefresh={refresh}
      actions={
        <button
          onClick={() => setShowAdd(true)}
          disabled={!data.available}
          className="text-[11px] font-semibold text-white bg-purple-1 hover:opacity-90 px-3 py-1 rounded-md transition-opacity disabled:opacity-40"
        >
          + Add MCP server
        </button>
      }
    >
      {!data.available && (
        <p className="text-[11px] text-text-3 mb-3">
          The <code className="bg-surface-1 px-1 rounded">claude</code> CLI isn't on PATH. Install Claude Code from the Developer row under Integrations, then refresh.
        </p>
      )}
      {actionError && <p className="text-[11px] text-red-1 mb-3">{actionError}</p>}
      {grouped.map(g => (
        <div key={g.scope} className="mb-5">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-3 mb-2">{g.label}</h3>
          <div className="border border-roca-border-1 rounded-xl overflow-hidden bg-surface-1/50 divide-y divide-roca-border-1">
            {g.items.map(s => (
              <div key={`${g.scope}-${s.name}`} className="px-4 py-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-text-1 truncate">{s.name}</span>
                    <StatusBadge status={s.status === 'connected' ? 'connected' : s.status === 'failed' ? 'disconnected' : 'unverified'} labelOn="Connected" labelOff="Failed" labelUnverified="Unknown" />
                  </div>
                  <p className="text-[10px] font-mono text-text-3 truncate mt-0.5" title={`${s.command} ${s.args.join(' ')}`}>{s.command} {s.args.join(' ')}</p>
                </div>
                <button
                  onClick={() => handleRemove(s.name, s.scope)}
                  className="text-[11px] font-medium text-red-1 px-2 py-1 rounded-md hover:bg-red-2 transition-colors"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!loading && data.available && data.servers.length === 0 && (
        <p className="text-[12px] text-text-3">No MCP servers configured. Click + Add MCP server to set one up.</p>
      )}
      {showAdd && (
        <AddMcpServerModal
          onClose={() => setShowAdd(false)}
          afterAdd={() => { setShowAdd(false); refresh() }}
        />
      )}
    </SectionFrame>
  )
}

function AddMcpServerModal({
  onClose, afterAdd,
}: { onClose: () => void; afterAdd: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('npx')
  const [args, setArgs] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [envRows, setEnvRows] = useState<{ k: string; v: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = name.trim() && command.trim() && !busy

  const handleSave = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const env: Record<string, string> = {}
      for (const row of envRows) {
        const k = row.k.trim()
        if (k) env[k] = row.v
      }
      const r = await window.electronAPI.connectionsAddMcp({
        name: name.trim(),
        command: command.trim(),
        args: args.split(/\s+/).filter(Boolean),
        scope,
        env,
      })
      if (!r.ok) { setError(r.error || 'Add failed'); return }
      afterAdd()
    } finally { setBusy(false) }
  }, [name, command, args, scope, envRows, afterAdd])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-surface-0 rounded-2xl shadow-2xl w-full max-w-lg p-6 border border-roca-border-1 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold text-text-1 mb-1">Add MCP server</h2>
        <p className="text-[12px] text-text-2 mb-4">Calls <code className="bg-surface-1 px-1 rounded">claude mcp add</code> behind the scenes. Use User scope for personal tools, Project scope to commit it to <code className="bg-surface-1 px-1 rounded">.mcp.json</code>.</p>

        <div className="space-y-3">
          <Field label="Name" required>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="notion" className={inputCls} />
          </Field>
          <Field label="Command" required>
            <input value={command} onChange={e => setCommand(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Args" hint="Space-separated.">
            <input value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @notionhq/notion-mcp-server" className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Scope" required>
            <div className="flex gap-3 text-[12px]">
              <label className="flex items-center gap-1.5"><input type="radio" checked={scope === 'user'} onChange={() => setScope('user')} /> User</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} /> Project</label>
            </div>
          </Field>
          <div>
            <label className="text-[11px] font-medium text-text-2 mb-1 block">Env vars</label>
            <div className="space-y-1.5">
              {envRows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={row.k}
                    onChange={e => { const next = [...envRows]; next[i] = { ...row, k: e.target.value }; setEnvRows(next) }}
                    placeholder="NOTION_TOKEN"
                    className={`${inputCls} font-mono flex-1`}
                  />
                  <input
                    value={row.v}
                    onChange={e => { const next = [...envRows]; next[i] = { ...row, v: e.target.value }; setEnvRows(next) }}
                    placeholder="secret_..."
                    className={`${inputCls} font-mono flex-1`}
                  />
                  <button
                    onClick={() => setEnvRows(envRows.filter((_, j) => j !== i))}
                    className="text-[11px] text-red-1 px-2 rounded-md hover:bg-red-2"
                  >×</button>
                </div>
              ))}
              <button
                onClick={() => setEnvRows([...envRows, { k: '', v: '' }])}
                className="text-[11px] text-purple-1 hover:underline"
              >+ Add env var</button>
            </div>
          </div>

          {error && <p className="text-[11px] text-red-1">{error}</p>}
          <div className="flex justify-end gap-2 pt-3 border-t border-roca-border-1">
            <button onClick={onClose} className="text-[12px] text-text-2 px-3 py-1.5 rounded-lg hover:bg-black/[0.04]">Cancel</button>
            <button onClick={handleSave} disabled={!canSave} className="text-[12px] font-semibold text-white bg-purple-1 hover:opacity-90 px-3 py-1.5 rounded-lg disabled:opacity-40">
              {busy ? 'Saving…' : 'Add server'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════
//  Shared bits
// ═══════════════════════════════════════════

function SectionFrame({
  title, subtitle, description, onRefresh, actions, children,
}: {
  title: string
  subtitle?: string
  description?: string
  onRefresh?: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-8 py-4 border-b border-roca-border-1 shrink-0">
        <div>
          <h2 className="text-[16px] font-semibold text-text-1">{title}</h2>
          {subtitle && <p className="text-[11px] text-text-3 mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="p-1.5 rounded-md hover:bg-black/[0.06] text-text-3 hover:text-text-1 transition-colors"
              title="Refresh"
              aria-label="Refresh"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-8 py-5">
        {description && (
          <p className="text-[12px] text-text-2 leading-relaxed mb-5 max-w-[600px]">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

// Small helper for the section descriptions — looks up the SectionMeta entry
// so each section component doesn't have to hard-code its own copy.
function descriptionFor(id: SectionId): string {
  return SECTIONS.find(s => s.id === id)?.description ?? ''
}

function StatusBadge({
  status, labelOn = 'Active', labelOff = 'Inactive', labelUnverified = 'Saved',
}: { status: 'connected' | 'disconnected' | 'unverified' | boolean; labelOn?: string; labelOff?: string; labelUnverified?: string }) {
  // Legacy boolean callers map true→connected, false→disconnected.
  const s = typeof status === 'boolean' ? (status ? 'connected' : 'disconnected') : status
  const cls = s === 'connected'
    ? 'text-green-1 bg-green-2'
    : s === 'unverified'
      ? 'text-yellow-700 bg-yellow-100'
      : 'text-text-3 bg-surface-2'
  const label = s === 'connected' ? labelOn : s === 'unverified' ? labelUnverified : labelOff
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  )
}

function AddConnectionPicker({
  onPick, onClose,
}: {
  onPick: (kind: 'api' | 'cli') => void
  onClose: () => void
}) {
  // MCP picks jump straight to the MCP section's add form; this keeps the
  // picker focused on credentials that land in custom-connections.json.
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-surface-0 rounded-2xl shadow-2xl w-full max-w-md p-6 border border-roca-border-1"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold text-text-1 mb-1">Add Connection</h2>
        <p className="text-[12px] text-text-2 mb-4">Pick the kind of integration you're adding.</p>
        <div className="grid grid-cols-3 gap-3">
          <PickerTile
            label="API"
            description="Store an API key for any service. Lands in api-keys.json and process.env."
            onClick={() => onPick('api')}
          />
          <PickerTile
            label="MCP"
            description="Add an MCP server Claude Code can call as a tool."
            onClick={() => { onClose(); document.dispatchEvent(new CustomEvent('roca:open-mcp-section')) }}
          />
          <PickerTile
            label="CLI"
            description="Track a CLI binary (probe + install link). No secret stored."
            onClick={() => onPick('cli')}
          />
        </div>
        <div className="flex justify-end mt-5 pt-4 border-t border-roca-border-1">
          <button
            onClick={onClose}
            className="text-[12px] text-text-2 px-3 py-1.5 rounded-lg hover:bg-black/[0.04] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function PickerTile({
  label, description, onClick,
}: { label: string; description: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left border border-roca-border-1 hover:border-purple-1 rounded-xl p-3 bg-surface-1/50 hover:bg-surface-1 transition-colors"
    >
      <div className="text-[14px] font-semibold text-text-1 mb-1">{label}</div>
      <div className="text-[10px] text-text-2 leading-snug">{description}</div>
    </button>
  )
}

function ReconfigureModal({
  connection, onClose, afterAction,
}: {
  connection: Connection
  onClose: () => void
  afterAction: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reconfigure-title"
        className="bg-surface-0 rounded-2xl shadow-2xl w-full max-w-lg p-6 border border-roca-border-1 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 id="reconfigure-title" className="text-[16px] font-semibold text-text-1">
            {connection.status === 'connected' ? `Reconfigure ${connection.name}` : `Set up ${connection.name}`}
          </h2>
          <StatusBadge status={connection.status} />
        </div>
        <p className="text-[12px] text-text-2 mb-4">
          {connection.status === 'connected' && connection.account
            ? <>Currently connected as <strong>{connection.account}</strong>.</>
            : connection.details}
        </p>

        <SetupBody connection={connection} onSuccess={() => { afterAction(); onClose() }} />

        <div className="flex items-center justify-end mt-5 pt-4 border-t border-roca-border-1">
          <button
            onClick={onClose}
            className="text-[12px] text-text-2 px-3 py-1.5 rounded-lg hover:bg-black/[0.04] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Per-kind setup bodies — each one walks the user from zero to working ────

function SetupBody({ connection, onSuccess }: { connection: Connection; onSuccess: () => void }) {
  const s = connection.setup
  if (s.kind === 'api-key') return <ApiKeySetup spec={s} connectionName={connection.name} onSuccess={onSuccess} />
  if (s.kind === 'slack-oauth') return <SlackOAuthSetup spec={s} onSuccess={onSuccess} />
  if (s.kind === 'google-oauth') return <GoogleOAuthSetup spec={s} />
  if (s.kind === 'external-app') return <ExternalAppSetup spec={s} name={connection.name} />
  if (s.kind === 'cli-tool') return <CliToolSetup spec={s} name={connection.name} />
  if (s.kind === 'custom-api') return <CustomApiReconfigureSetup connection={connection} spec={s} onSuccess={onSuccess} />
  if (s.kind === 'custom-cli') return <CliToolSetup spec={{ kind: 'cli-tool', binaryPath: s.binaryPath, version: s.version, installUrl: s.installUrl, help: s.help }} name={connection.name} />
  return null
}

// Reusable "Get your key from <link>" row
function GetKeyLink({ url, label }: { url: string; label: string }) {
  return (
    <button
      onClick={() => window.electronAPI.connectionsOpenExternal(url)}
      className="inline-flex items-center gap-1 text-[11px] font-semibold text-purple-1 hover:underline"
    >
      {label}
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </button>
  )
}

function CustomApiReconfigureSetup({
  connection, spec, onSuccess,
}: {
  connection: Connection
  spec: Extract<SetupSpec, { kind: 'custom-api' }>
  onSuccess: () => void
}) {
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const handleSave = useCallback(async () => {
    if (!keyInput.trim()) return
    setBusy(true); setResult(null)
    try {
      // For custom connections we re-add via the same handler — passing the
      // existing envVarName overwrites the stored key in api-keys.json. We
      // don't replace the connection metadata, so we just call save-key style
      // via add-custom with the existing config.
      const r = await window.electronAPI.connectionsAddCustom({
        kind: 'api',
        name: connection.name,
        envVarName: spec.envVarName,
        apiKey: keyInput.trim(),
        getKeyUrl: spec.getKeyUrl,
        verify: spec.verify,
      })
      setResult({ ok: r.ok, error: r.error })
      if (r.ok) setTimeout(onSuccess, 600)
    } finally { setBusy(false) }
  }, [keyInput, connection.name, spec, onSuccess])

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface-1/60 border border-roca-border-1 px-3 py-2">
        <p className="text-[11px] text-text-2 leading-snug">
          Env var: <code className="bg-surface-1 px-1 rounded font-mono">{spec.envVarName}</code>
          {spec.verify ? ' — verified on save.' : ' — stored without a verification probe.'}
        </p>
        {spec.getKeyUrl && (
          <div className="mt-2">
            <button
              onClick={() => window.electronAPI.connectionsOpenExternal(spec.getKeyUrl!)}
              className="text-[11px] font-semibold text-purple-1 hover:underline"
            >
              Get key ↗
            </button>
          </div>
        )}
      </div>
      <div>
        <label className="text-[11px] font-medium text-text-2 mb-1 block">New API key</label>
        <div className="flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={keyInput}
            onChange={e => { setKeyInput(e.target.value); setResult(null) }}
            placeholder="paste new key"
            className={`${inputCls} font-mono flex-1`}
            autoFocus
          />
          <button onClick={() => setShowKey(v => !v)} className="text-[11px] text-text-2 px-2 py-1 rounded-md hover:bg-black/[0.04]">{showKey ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      <button
        onClick={handleSave}
        disabled={!keyInput.trim() || busy}
        className="w-full text-[12px] font-semibold text-white px-3 py-2 rounded-lg bg-purple-1 hover:opacity-90 disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      {result && !result.ok && <p className="text-[11px] text-red-1">{result.error}</p>}
    </div>
  )
}

function ApiKeySetup({
  spec, connectionName, onSuccess,
}: {
  spec: Extract<SetupSpec, { kind: 'api-key' }>
  connectionName: string
  onSuccess: () => void
}) {
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; account?: string; details?: string; error?: string } | null>(null)

  const handleTest = useCallback(async () => {
    if (!keyInput.trim()) return
    setBusy('test'); setResult(null)
    try {
      const r = await window.electronAPI.connectionsTestKey(spec.keyId, keyInput)
      setResult(r)
    } finally { setBusy(null) }
  }, [keyInput, spec.keyId])

  const handleSave = useCallback(async () => {
    if (!keyInput.trim()) return
    setBusy('save'); setResult(null)
    try {
      const r = await window.electronAPI.connectionsSaveKey(spec.keyId, keyInput)
      setResult(r)
      if (r.ok) {
        // Give the user a beat to see the success state, then close.
        setTimeout(onSuccess, 600)
      }
    } finally { setBusy(null) }
  }, [keyInput, spec.keyId, onSuccess])

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface-1/60 border border-roca-border-1 px-3 py-2">
        <p className="text-[11px] text-text-2 leading-snug">
          <strong>Step 1.</strong> Grab your API key from {connectionName}, then paste it below.
          ROCA tests the key against the live API before saving — you'll know it works before you commit to it.
        </p>
        <div className="flex items-center gap-3 mt-2">
          <GetKeyLink url={spec.getKeyUrl} label={`Open ${connectionName} API page`} />
          {spec.docsUrl && <GetKeyLink url={spec.docsUrl} label="API docs" />}
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-text-2 mb-1 block">API key</label>
        <div className="flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); setResult(null) }}
            placeholder={spec.placeholder}
            className="flex-1 text-[12px] font-mono text-text-1 bg-surface-1 rounded-lg px-3 py-2 border border-roca-border-1 focus:outline-none focus:border-purple-1/60"
            autoFocus
          />
          <button
            onClick={() => setShowKey(v => !v)}
            className="text-[11px] text-text-2 px-2 py-1 rounded-md hover:bg-black/[0.04] transition-colors"
            title={showKey ? 'Hide key' : 'Show key'}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="text-[10px] text-text-3 mt-1">
          Stored locally at <code className="bg-surface-1 px-1 rounded">~/Library/Application Support/ROCA/api-keys.json</code> (mode 600). Overrides the <code className="bg-surface-1 px-1 rounded">{spec.envKey}</code> env var if set.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleTest}
          disabled={!keyInput.trim() || !!busy}
          className="text-[12px] font-medium text-text-1 px-3 py-2 rounded-lg bg-surface-1 hover:bg-surface-2 transition-colors disabled:opacity-40"
        >
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        <button
          onClick={handleSave}
          disabled={!keyInput.trim() || !!busy}
          className="flex-1 text-[12px] font-semibold text-white px-3 py-2 rounded-lg bg-purple-1 hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {busy === 'save' ? 'Verifying & saving…' : 'Save'}
        </button>
      </div>

      {result && (
        <div className={`rounded-lg px-3 py-2 text-[11px] ${
          result.ok ? 'bg-green-2 text-green-1' : 'bg-red-2 text-red-1'
        }`}>
          {result.ok ? (
            <>✓ Verified — <strong>{result.account}</strong>{result.details ? ` · ${result.details}` : ''}</>
          ) : (
            <>✗ {result.error || 'Verification failed'}</>
          )}
        </div>
      )}

      <details className="text-[11px] text-text-3">
        <summary className="cursor-pointer hover:text-text-2">What this connection does</summary>
        <p className="mt-2 leading-snug">{spec.help}</p>
      </details>
    </div>
  )
}

function SlackOAuthSetup({
  spec, onSuccess,
}: {
  spec: Extract<SetupSpec, { kind: 'slack-oauth' }>
  onSuccess: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOAuth = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const r = await window.electronAPI.slackStartOAuth()
      if (!r.ok) { setError(r.error || 'Slack OAuth failed'); return }
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Slack OAuth failed')
    } finally {
      setBusy(false)
    }
  }, [onSuccess])

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface-1/60 border border-roca-border-1 px-3 py-2">
        <p className="text-[11px] text-text-2 leading-snug">{spec.help}</p>
        <div className="mt-2">
          <GetKeyLink url={spec.getKeyUrl} label="Manage Slack apps" />
        </div>
      </div>
      <button
        onClick={handleOAuth}
        disabled={busy}
        className="w-full text-[13px] font-semibold text-white px-4 py-2.5 rounded-lg bg-purple-1 hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {busy ? 'Opening browser…' : 'Sign in with Slack'}
      </button>
      {error && <p className="text-[11px] text-red-1">{error}</p>}
    </div>
  )
}

function GoogleOAuthSetup({ spec }: { spec: Extract<SetupSpec, { kind: 'google-oauth' }> }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface-1/60 border border-roca-border-1 px-3 py-2">
        <p className="text-[11px] text-text-2 leading-snug">{spec.help}</p>
        <div className="mt-2 flex items-center gap-3">
          <GetKeyLink url={spec.getKeyUrl} label="Open Google Cloud Console" />
          <GetKeyLink url="https://myaccount.google.com/permissions" label="Manage Google permissions" />
        </div>
      </div>
      <div>
        <label className="text-[11px] font-medium text-text-2 mb-1 block">Token file</label>
        <code className="block text-[11px] font-mono text-text-1 bg-surface-1 rounded-lg px-3 py-2 break-all border border-roca-border-1">
          {spec.tokenPath}
        </code>
        <p className="text-[10px] text-text-3 mt-1">
          ROCA reads this on every API call. Delete it (use Disconnect) and re-run the Google Tasks CLI auth flow in <code className="bg-surface-1 px-1 rounded">your agents repo</code> to refresh.
        </p>
      </div>
    </div>
  )
}

function ExternalAppSetup({ spec, name }: { spec: Extract<SetupSpec, { kind: 'external-app' }>; name: string }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-2 leading-snug">{spec.help}</p>
      <button
        onClick={() => window.electronAPI.connectionsOpenExternal(spec.downloadUrl)}
        className="w-full text-[13px] font-semibold text-white px-4 py-2.5 rounded-lg bg-purple-1 hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
      >
        Open {spec.appName} download page
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </button>
      <p className="text-[10px] text-text-3 leading-snug">
        Once you sign into {name} on this Mac, ROCA detects the session automatically on next refresh.
      </p>
    </div>
  )
}

function CliToolSetup({ spec, name }: { spec: Extract<SetupSpec, { kind: 'cli-tool' }>; name: string }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-2 leading-snug">{spec.help}</p>
      {spec.binaryPath ? (
        <div className="rounded-lg bg-green-2 border border-green-1/20 px-3 py-2">
          <p className="text-[11px] text-green-1">
            ✓ Found <code className="bg-surface-1 px-1 rounded">{spec.binaryPath}</code>
            {spec.version ? ` (${spec.version})` : ''}
          </p>
        </div>
      ) : (
        <code className="block text-[11px] font-mono text-text-1 bg-surface-1 rounded-lg px-3 py-2 break-all border border-roca-border-1">
          npm install -g @anthropic-ai/claude-code
        </code>
      )}
      <button
        onClick={() => window.electronAPI.connectionsOpenExternal(spec.installUrl)}
        className="w-full text-[12px] font-semibold text-text-1 px-3 py-2 rounded-lg bg-surface-1 hover:bg-surface-2 transition-colors flex items-center justify-center gap-2"
      >
        Open {name} install docs
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </button>
    </div>
  )
}

function AddApiConnectionModal({
  onClose, afterAdd,
}: { onClose: () => void; afterAdd: () => void }) {
  const [name, setName] = useState('')
  const [envVar, setEnvVar] = useState('')
  const [envVarEdited, setEnvVarEdited] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [getKeyUrl, setGetKeyUrl] = useState('')
  const [verifyEnabled, setVerifyEnabled] = useState(false)
  const [verifyUrl, setVerifyUrl] = useState('')
  const [verifyHeader, setVerifyHeader] = useState('Authorization')
  const [verifyTemplate, setVerifyTemplate] = useState('Bearer ${KEY}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auto-suggest env var from display name until the user edits it manually.
  useEffect(() => {
    if (envVarEdited) return
    const slug = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    setEnvVar(slug ? `${slug}_API_KEY` : '')
  }, [name, envVarEdited])

  const canSave = name.trim() && envVar.trim() && apiKey.trim() && !busy

  const handleSave = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const r = await window.electronAPI.connectionsAddCustom({
        kind: 'api',
        name: name.trim(),
        envVarName: envVar.trim(),
        apiKey: apiKey.trim(),
        getKeyUrl: getKeyUrl.trim() || undefined,
        verify: verifyEnabled && verifyUrl.trim() ? {
          url: verifyUrl.trim(),
          headerName: verifyHeader.trim(),
          headerTemplate: verifyTemplate.trim(),
        } : undefined,
      })
      if (!r.ok) { setError(r.error || 'Save failed'); return }
      afterAdd()
    } finally { setBusy(false) }
  }, [name, envVar, apiKey, getKeyUrl, verifyEnabled, verifyUrl, verifyHeader, verifyTemplate, afterAdd])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-surface-0 rounded-2xl shadow-2xl w-full max-w-lg p-6 border border-roca-border-1 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold text-text-1 mb-1">Add API connection</h2>
        <p className="text-[12px] text-text-2 mb-4">Stored locally in <code className="bg-surface-1 px-1 rounded">api-keys.json</code> (mode 600) and injected into <code className="bg-surface-1 px-1 rounded">process.env</code> at next launch.</p>

        <div className="space-y-3">
          <Field label="Display name" required>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="OpenAI"
              className={inputCls}
            />
          </Field>
          <Field label="Env var name" required hint="Auto-derived from name. Edit if your tooling expects a different variable.">
            <input
              value={envVar}
              onChange={e => { setEnvVar(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_')); setEnvVarEdited(true) }}
              placeholder="OPENAI_API_KEY"
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label="API key" required>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className={`${inputCls} font-mono flex-1`}
              />
              <button onClick={() => setShowKey(v => !v)} className="text-[11px] text-text-2 px-2 py-1 rounded-md hover:bg-black/[0.04]">{showKey ? 'Hide' : 'Show'}</button>
            </div>
          </Field>
          <Field label="Get key URL" hint="Optional. Surfaces a 'Get key ↗' deep-link on the row.">
            <input
              value={getKeyUrl}
              onChange={e => setGetKeyUrl(e.target.value)}
              placeholder="https://platform.openai.com/api-keys"
              className={inputCls}
            />
          </Field>

          <details className="border border-roca-border-1 rounded-lg p-3" open={verifyEnabled}>
            <summary
              className="text-[12px] font-medium text-text-1 cursor-pointer flex items-center gap-2"
              onClick={(e) => { e.preventDefault(); setVerifyEnabled(v => !v) }}
            >
              <input type="checkbox" checked={verifyEnabled} readOnly className="pointer-events-none" />
              Add a verifier (optional)
            </summary>
            <p className="text-[11px] text-text-2 mt-2 mb-2 leading-snug">
              ROCA will hit this URL with the header below before saving. <code className="bg-surface-1 px-1 rounded">${'{KEY}'}</code> is replaced with the API key. Without a verifier the row shows "Saved" instead of "Active".
            </p>
            <div className="space-y-2">
              <Field label="Verify URL"><input value={verifyUrl} onChange={e => setVerifyUrl(e.target.value)} placeholder="https://api.openai.com/v1/models" className={inputCls} disabled={!verifyEnabled} /></Field>
              <Field label="Header name"><input value={verifyHeader} onChange={e => setVerifyHeader(e.target.value)} className={`${inputCls} font-mono`} disabled={!verifyEnabled} /></Field>
              <Field label="Header value template"><input value={verifyTemplate} onChange={e => setVerifyTemplate(e.target.value)} className={`${inputCls} font-mono`} disabled={!verifyEnabled} /></Field>
            </div>
          </details>

          {error && <p className="text-[11px] text-red-1">{error}</p>}

          <div className="flex justify-end gap-2 pt-3 border-t border-roca-border-1">
            <button onClick={onClose} className="text-[12px] text-text-2 px-3 py-1.5 rounded-lg hover:bg-black/[0.04]">Cancel</button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="text-[12px] font-semibold text-white bg-purple-1 hover:opacity-90 px-3 py-1.5 rounded-lg disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full text-[12px] text-text-1 bg-surface-1 rounded-lg px-3 py-2 border border-roca-border-1 focus:outline-none focus:border-purple-1/60'

function Field({
  label, hint, required, children,
}: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-medium text-text-2 mb-1 block">
        {label}{required ? ' *' : ''}
      </label>
      {children}
      {hint && <p className="text-[10px] text-text-3 mt-1">{hint}</p>}
    </div>
  )
}

function AddCliConnectionModal({
  onClose, afterAdd,
}: { onClose: () => void; afterAdd: () => void }) {
  const [name, setName] = useState('')
  const [paths, setPaths] = useState('/opt/homebrew/bin/, /usr/local/bin/')
  const [installUrl, setInstallUrl] = useState('')
  const [versionArgs, setVersionArgs] = useState('--version')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = name.trim() && paths.trim() && installUrl.trim() && !busy

  const handleSave = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const r = await window.electronAPI.connectionsAddCustom({
        kind: 'cli',
        name: name.trim(),
        binaryPaths: paths.split(',').map(s => s.trim()).filter(Boolean),
        installUrl: installUrl.trim(),
        versionArgs: versionArgs.trim().split(/\s+/).filter(Boolean),
      })
      if (!r.ok) { setError(r.error || 'Save failed'); return }
      afterAdd()
    } finally { setBusy(false) }
  }, [name, paths, installUrl, versionArgs, afterAdd])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="bg-surface-0 rounded-2xl shadow-2xl w-full max-w-lg p-6 border border-roca-border-1 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold text-text-1 mb-1">Add CLI connection</h2>
        <p className="text-[12px] text-text-2 mb-4">Tracks a CLI binary on disk — the row shows ✓ Active when ROCA finds it on the path.</p>

        <div className="space-y-3">
          <Field label="Display name" required>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="ripgrep" className={inputCls} />
          </Field>
          <Field label="Binary path candidates" required hint="Comma-separated. First existing path wins.">
            <input value={paths} onChange={e => setPaths(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Install URL" required hint="Where to send the user if it's not installed.">
            <input value={installUrl} onChange={e => setInstallUrl(e.target.value)} placeholder="https://github.com/BurntSushi/ripgrep#installation" className={inputCls} />
          </Field>
          <Field label="Version probe args" hint="Defaults to --version.">
            <input value={versionArgs} onChange={e => setVersionArgs(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
          {error && <p className="text-[11px] text-red-1">{error}</p>}
          <div className="flex justify-end gap-2 pt-3 border-t border-roca-border-1">
            <button onClick={onClose} className="text-[12px] text-text-2 px-3 py-1.5 rounded-lg hover:bg-black/[0.04]">Cancel</button>
            <button onClick={handleSave} disabled={!canSave} className="text-[12px] font-semibold text-white bg-purple-1 hover:opacity-90 px-3 py-1.5 rounded-lg disabled:opacity-40">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
