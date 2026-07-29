export interface WebviewToolSpec {
  kind: string
  label: string
  hint: string
  url: string
  partition: string
  userAgent?: string
  // Initial favicon URL shown on the tab chip before the guest page finishes
  // loading. Gets replaced by the guest's own favicon once `page-favicon-
  // updated` fires.
  iconUrl: string
  // If set, called whenever the guest's <title> changes. Return the number
  // of unread/pending items encoded in the title (Gmail does this as
  // "Inbox (5) - ..."), or null/0 if none.
  parseUnreadFromTitle?: (title: string) => number | null
}

// Optional override for the example CRM tab's URL. The renderer runs with
// nodeIntegration off, so `process` may be undefined — read it defensively.
const CRM_WEB_URL =
  (typeof process !== 'undefined' ? process.env?.CRM_WEB_URL : undefined) || ''

const favicon = (domain: string) => `https://www.google.com/s2/favicons?sz=64&domain=${domain}`

// Google's s2/favicons service collapses every *.google.com subdomain to the
// generic Google "G" — Gmail, Sheets, Docs, Drive, and Calendar all come back
// looking identical. Use Google's official branded product PNGs from gstatic
// so each service shows its real color/logo.
const GOOGLE_PRODUCT_ICON = (slug: string) =>
  `https://www.gstatic.com/images/branding/product/2x/${slug}_2020q4_48dp.png`

// Pretending to be Chrome desktop — Google sometimes blocks sign-in from
// unrecognized or embedded-looking user agents. Matching Chrome's real UA
// sidesteps that check for Gmail/Drive/Sheets/Docs/Calendar.
const CHROME_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// Chrome OS UA — needed ONLY by Slack's signin page, which blocks every
// non-CrOS browser (Chromebook users can't be pushed to "install the desktop
// app," so Slack exempts CrOS). Scoped to slack.com because a CrOS identity
// contradicts the real macOS host and makes Cloudflare Turnstile / bot checks
// fail with "unsupported browser" on other sites. Everything else falls
// through to the honest macOS Chrome default (session-config.ts).
const CROS_UA =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// The UA a given tab should present. An explicit per-tool userAgent wins;
// otherwise Slack tabs get the CrOS exemption UA, and every other tab returns
// undefined so the webview inherits the session default (macOS Chrome).
export function effectiveUserAgent(tool: WebviewToolSpec): string | undefined {
  if (tool.userAgent) return tool.userAgent
  try {
    if (/(^|\.)slack\.com$/i.test(new URL(tool.url).hostname)) return CROS_UA
  } catch { /* malformed URL — fall through to the session default */ }
  return undefined
}

// All Google services share cookies on *.google.com, so unifying them under
// one partition means one login → everything logged in.
const GOOGLE_PARTITION = 'persist:google-workspace'

export const WEBVIEW_TOOLS: WebviewToolSpec[] = [
  // Example non-Google built-in tab. Point this at your own CRM (or any web
  // app) — each custom tab gets its own persistent partition so logins stick.
  // Users can also add their own tabs at runtime via the `+` picker.
  {
    kind: 'crm',
    label: 'CRM',
    hint: 'CRM',
    url: CRM_WEB_URL || 'https://example.com',
    partition: 'persist:crm',
    iconUrl: favicon('example.com'),
  },
  {
    kind: 'gmail',
    label: 'Gmail',
    hint: 'mail.google.com',
    url: 'https://mail.google.com',
    partition: GOOGLE_PARTITION,
    userAgent: CHROME_DESKTOP_UA,
    iconUrl: GOOGLE_PRODUCT_ICON('gmail'),
    // Gmail sets <title> to e.g. "Inbox (3) - user@gmail.com - Gmail"
    // when unread mail exists. Pull the number in parens.
    parseUnreadFromTitle: (title) => {
      const m = title.match(/\((\d+)\)/)
      return m ? parseInt(m[1], 10) : 0
    },
  },
  {
    kind: 'gsheets',
    label: 'Google Sheets',
    hint: 'sheets.google.com',
    url: 'https://sheets.google.com',
    partition: GOOGLE_PARTITION,
    userAgent: CHROME_DESKTOP_UA,
    iconUrl: GOOGLE_PRODUCT_ICON('sheets'),
  },
  {
    kind: 'gdocs',
    label: 'Google Docs',
    hint: 'docs.google.com',
    url: 'https://docs.google.com',
    partition: GOOGLE_PARTITION,
    userAgent: CHROME_DESKTOP_UA,
    iconUrl: GOOGLE_PRODUCT_ICON('docs'),
  },
  {
    kind: 'gdrive',
    label: 'Google Drive',
    hint: 'drive.google.com',
    url: 'https://drive.google.com',
    partition: GOOGLE_PARTITION,
    userAgent: CHROME_DESKTOP_UA,
    iconUrl: GOOGLE_PRODUCT_ICON('drive'),
  },
  {
    kind: 'gcal',
    label: 'Google Calendar',
    hint: 'calendar.google.com',
    url: 'https://calendar.google.com',
    partition: GOOGLE_PARTITION,
    userAgent: CHROME_DESKTOP_UA,
    iconUrl: GOOGLE_PRODUCT_ICON('calendar'),
  },
  // Default destination for the `+` (new-tab) button — behaves like a
  // browser's homepage. Shares the Google partition so the user is signed
  // in across Google search and the Workspace tabs.
  {
    kind: 'google',
    label: 'Google',
    hint: 'google.com',
    url: 'https://www.google.com',
    partition: GOOGLE_PARTITION,
    userAgent: CHROME_DESKTOP_UA,
    iconUrl: favicon('google.com'),
  },
]

// ── Custom tools (user-added via the `+` picker) ────────────────────────────
// Stored in localStorage so they persist across app restarts. Each tool gets
// its own `persist:custom-<domain>` partition — re-adding the same domain
// reuses the same partition, so logins survive a remove/re-add cycle.

const CUSTOM_TOOLS_KEY = 'roca:customTools'

export function loadCustomTools(): WebviewToolSpec[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TOOLS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t: unknown): t is WebviewToolSpec =>
      !!t && typeof t === 'object' &&
      'kind' in t && 'label' in t && 'url' in t && 'partition' in t
    )
  } catch { return [] }
}

export function saveCustomTools(tools: WebviewToolSpec[]) {
  localStorage.setItem(CUSTOM_TOOLS_KEY, JSON.stringify(tools))
}

// Normalise a user-entered URL: add https:// if missing, reject invalid input.
export function normaliseUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withProto)
    if (!u.hostname.includes('.')) return null
    return u.toString()
  } catch {
    return null
  }
}

export function createCustomTool(inputUrl: string, label?: string): WebviewToolSpec | null {
  const normalised = normaliseUrl(inputUrl)
  if (!normalised) return null
  const u = new URL(normalised)
  const domain = u.hostname.replace(/^www\./, '')
  return {
    kind: `custom-${domain}`,
    label: (label?.trim() || domain.split('.')[0].replace(/^./, c => c.toUpperCase())),
    hint: u.hostname,
    url: normalised,
    partition: `persist:custom-${domain}`,
    iconUrl: favicon(domain),
  }
}

export function getAllTools(): WebviewToolSpec[] {
  return [...WEBVIEW_TOOLS, ...loadCustomTools()]
}

export function getToolByKind(kind: string): WebviewToolSpec | undefined {
  return getAllTools().find(t => t.kind === kind)
}
