// ROCA slash command definitions and parser.
// These are app-level commands intercepted in the terminal before reaching the PTY.
// Claude CLI's own slash commands (e.g. /help, /exit) pass through when unrecognized.

export interface SlashCommandDef {
  description: string
  args?: string
}

export const ROCA_COMMANDS: Record<string, SlashCommandDef> = {
  voice:    { description: 'Toggle voice mode' },
  notes:    { description: 'Toggle notes panel' },
  files:    { description: 'Toggle files sidebar' },
  terminal: { description: 'Switch to terminal tab' },
  browser:  { description: 'Switch to browser tab' },
  browse:   { description: 'Claude controls the browser', args: '<instruction>' },
  sync:     { description: 'Sync all data sources' },
  new:      { description: 'Create a new task', args: '[title]' },
  done:     { description: 'Complete current task' },
  status:   { description: 'Set task status', args: '<open|in_progress|waiting|blocked|done>' },
  priority: { description: 'Set task priority', args: '<low|medium|high|urgent>' },
  week:     { description: 'Navigate weeks', args: '[next|prev|current]' },
  tab:      { description: 'Switch main view', args: '<week|filepath>' },
  agents:   { description: 'Show agents view' },
  agent:    { description: 'Control agents', args: '<start|stop> <name>' },
  popout:   { description: 'Pop out current panel' },
  clear:    { description: 'Clear terminal screen' },
  help:     { description: 'Show available commands' },
}

export interface ParsedCommand {
  command: string
  args: string
}

export function parseSlashCommand(line: string): ParsedCommand | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.slice(1).split(/\s+/)
  const name = parts[0].toLowerCase()
  if (!(name in ROCA_COMMANDS)) return null
  return { command: name, args: parts.slice(1).join(' ') }
}

/** Detect natural language browser intent — returns browse instruction or null */
export function parseBrowseIntent(line: string): string | null {
  const trimmed = line.trim()
  const lower = trimmed.toLowerCase()

  // Strip casual prefixes: "let's", "lets", "can you", "please", "hey", "yo"
  const stripped = lower.replace(/^(?:let'?s|can\s+you|could\s+you|please|hey|yo)\s+/i, '').trim()

  // "browse ..." (without slash)
  if (/^browse\s+/.test(stripped)) {
    return stripped.slice(7).trim()
  }

  // "open [up] [a/the] browser [and/&] [instruction]"
  const openMatch = stripped.match(/^open\s+(?:up\s+)?(?:a\s+|the\s+)?browser(?:\s+(?:and\s+|&\s*|to\s+)(.+))?$/)
  if (openMatch) {
    return openMatch[1]?.trim() || ''
  }

  // "search [query] in/on browser" / "search browser for [query]"
  const searchBrowser = stripped.match(/^search\s+(?:the\s+)?browser\s+(?:for\s+)?(.+)$/i)
    || stripped.match(/^search\s+(.+?)\s+(?:in|on|using)\s+(?:the\s+)?browser$/i)
  if (searchBrowser) {
    return `search for ${searchBrowser[1].trim()}`
  }

  // "[open] browser and [instruction]" / "browser [instruction]"
  const browserFirst = stripped.match(/^(?:open\s+)?browser\s+(?:and\s+|&\s*)?(.+)$/)
  if (browserFirst) {
    return browserFirst[1].trim()
  }

  // "go to [domain]" / "navigate to [domain]" — only if it looks like a URL
  const goTo = stripped.match(/^(?:go\s+to|navigate\s+to|open\s+up?)\s+([\w.-]+\.[\w]+(?:\/\S*)?)$/i)
  if (goTo) {
    return `go to ${goTo[1]}`
  }

  return null
}

/** Detect "stop browsing" / "close browser" intent */
export function parseStopBrowseIntent(line: string): boolean {
  const lower = line.trim().toLowerCase()
  return /^(?:stop|close|exit|quit|end|hide)\s+(?:the\s+)?(?:browser|browsing)$/.test(lower)
}

export function formatHelpText(): string {
  return Object.entries(ROCA_COMMANDS)
    .map(([name, def]) => {
      const usage = `/${name}${def.args ? ' ' + def.args : ''}`
      return `  \x1b[97m${usage.padEnd(40)}\x1b[90m${def.description}\x1b[0m`
    })
    .join('\r\n')
}
