// Voice output filters — determines which terminal lines should be spoken aloud
// Extracted from TaskTerminal.tsx for testability and reuse

export function shouldSpeakLine(line: string): boolean {
  const plain = line.trim()
  if (!plain) return false
  if (/^[`]+/.test(plain)) return false
  if (/^[#>*_-]{3,}$/.test(plain)) return false
  if (/^[─━═┄┈\-]+$/.test(plain)) return false
  if (/bypass permissions|shift\+tab|ctrl\+o|Press up to edit/i.test(plain)) return false
  if (/Opus|Sonnet|Haiku|gsd:|Claude Code/i.test(plain)) return false
  if (/thinking with/i.test(plain)) return false
  // Code diffs
  if (/^[+-]\s*(const|let|var|if|else|return|import|export|function|class|\{|\}|\/\/)/.test(plain)) return false
  if (/^\s{4,}\S/.test(line)) return false
  if (/^\s*(src\/|\.\/|\/Users\/|\/Applications\/)/.test(plain)) return false
  if (/^[⎿\s]{2,}/.test(plain)) return false
  if (/^\s*_?\s*_?\s*(Added|Removed|Changed)\s+\d+\s+line/.test(plain)) return false
  // Tool calls
  if (/^[⏺⎿●_\s]*(?:◐\s*)?(Bash|Read|Edit|Grep|Glob|Write|Agent|WebFetch|WebSearch|Update|Skill|ToolSearch|NotebookEdit)\s*[\(]/.test(plain)) return false
  if (/^_\s*(Bash|Read|Edit|Grep|Glob|Write|Agent|WebFetch|WebSearch|Update|Skill|ToolSearch|mcp_|claude\.ai)\b/.test(plain)) return false
  if (/^_\s*_?\s*(Added|Removed|Changed|Update|Cooked|Worked|Sautéed)\b/.test(plain)) return false
  // Thinking/working indicators
  if (/^(Cogitated|Sautéed|Worked|Baked|Searched|Cultivating|Schlepping|Percolating|Sublimating|Cascading|Generating|Searching|Musing|Philosophising|Zesting|Baking|Puttering|Whirlpooling|Sketching|Frosting|Frosted|Cooked)\b/i.test(plain)) return false
  if (/^[✻✓✗]/.test(plain)) return false
  if (/^[\s✽✳✶✢✻·⏺◐◑◒◓⠂\-+*›❯]+\s*\w+…/.test(plain)) return false
  if (/^[$><]/.test(plain)) return false
  // Tool output summaries
  if (/Read \d+ files?/i.test(plain)) return false
  if (/ctrl\+o.*expand/i.test(plain)) return false
  if (/^\s*[_\s]*\+\d+\s+lines/i.test(plain)) return false
  // Code / diffs / line numbers
  if (/^\s*\d+\s*[+-]\s/.test(plain)) return false
  if (/\{\/\*.*\*\/\}/.test(plain)) return false
  if (/^\/\/\S/.test(plain)) return false
  if (/^\s*from\s+\w+\s+import\s+/i.test(plain)) return false
  if (/^\s*import\s+\{?\s*\w/.test(plain)) return false
  // Document parsing markers
  if (/\[(Normal|Heading \d|Title|Subtitle|Body)\]/.test(plain)) return false
  // MCP tool calls and output
  if (/\(MCP\)/.test(plain)) return false
  if (/Read \d+ records? out of \d+ records?/i.test(plain)) return false
  if (/^(entity|sql|limit|offset)\s*:/i.test(plain)) return false
  if (/SELECT\s+.*FROM\b/i.test(plain)) return false
  if (/\bGROUP BY\b.*\bORDER BY\b/i.test(plain)) return false
  if (/->>'?\w+'?\s*(as|,|FROM|WHERE|GROUP|ORDER)/i.test(plain)) return false
  if (/\bWHERE\b.*\bNOT IN\b/i.test(plain)) return false
  if (/^\s*\w+:\s*(Tier|Not a fit|Revisit|Discovery|Engaged|Outreached|Disqualified|Closed|Moved)/i.test(plain)) return false
  if (/^\s*(count|stage|tier|status|type)\s*:\s*\S/i.test(plain)) return false
  // Generic tool call pattern
  if (/^\s*_?\s*\w+\.\w+.*\(.*entity.*sql/i.test(plain)) return false
  // URLs
  if (/^\/\/\w+\.\w+\//.test(plain)) return false
  if (/^https?:\/\//.test(plain)) return false
  // Tables
  if (/\|.*\|.*\|/.test(plain)) return false
  if (/^[\s|:+-]+$/.test(plain) && plain.includes('|')) return false
  // Graphs / charts
  if (/[█▓▒░▏▎▍▌▋▊▉▁▂▃▄▅▆▇]/.test(plain)) return false
  if (/[┌┐└┘├┤┬┴┼╭╮╯╰│].*[┌┐└┘├┤┬┴┼╭╮╯╰│]/.test(plain)) return false
  // Build output
  if (/rollupjs|webpack|esbuild|vite|built in \d/i.test(plain)) return false
  if (/chunk size|manualChunks|minification/i.test(plain)) return false
  // Low-content lines
  const alpha = plain.replace(/[^a-zA-Z]/g, '').length
  const spaces = plain.replace(/[^ ]/g, '').length
  if (alpha > 0 && alpha < 10 && spaces > alpha) return false
  if (/^\s*\d{1,5}\s*[+-]?\s{0,4}\S/.test(plain) && /^\s*\d/.test(plain)) return false
  if (alpha < 6 && plain.length > 3) return false
  return plain.split(/\s+/).filter(word => word.length > 1).length >= 3
}

// Status bar pattern — used by isToolLine and extractSpokenSummary to avoid treating
// Claude Code prompt chrome (e.g. "⎿ bypass permissions on (shift+tab to cycle)") as tool output.
export const STATUS_BAR_RE = /bypass permissions|shift\+tab|ctrl\+o|Press up to edit|\b(?:Opus|Sonnet|Haiku)\b.*context/i

// Thinking/working indicators — these appear BETWEEN tool output and conversational text.
// Used by extractSpokenSummary to avoid breaking the fallback scan at these lines
// (they should be skipped, not treated as tool boundaries).
// Matches both bare "Frosted for 3.2s" and prefixed "⏺ Cooked for 3.2s" variants.
export const THINKING_RE = /^[⏺●⎿\s]*(Cogitated|Sautéed|Worked|Baked|Searched|Cultivating|Schlepping|Percolating|Sublimating|Cascading|Generating|Searching|Musing|Philosophising|Zesting|Baking|Frosting|Frosted|Cooked|Puttering|Whirlpooling|Sketching)\b/i

export function isToolLine(line: string): boolean {
  const plain = line.trim()
  if (!plain) return false
  // Never treat Claude Code's status bar / prompt lines as tool output
  if (STATUS_BAR_RE.test(plain)) return false
  if (/^[⏺⎿●\s]*(?:◐\s*)?(Bash|Read|Edit|Grep|Glob|Write|Agent|WebFetch|WebSearch|Update|Skill|ToolSearch|NotebookEdit)\b/.test(plain)) return true
  if (/[⎿]/.test(plain)) return true
  if (/^\s{2,}[⎿●]/.test(line)) return true
  if (/^\s*(Added|Removed|Changed)\s+\d+\s+line/.test(plain)) return true
  if (/^[·⏺◐◑◒◓]\s/.test(plain)) return true
  if (/^(Cogitated|Sautéed|Worked|Baked|Searched|Cultivating|Schlepping|Percolating|Sublimating|Cascading|Generating|Searching|Musing|Philosophising|Zesting|Baking|Frosting|Puttering|Whirlpooling|Sketching)\b/i.test(plain)) return true
  if (/^[⏺●⎿\s]*(Cooked|Worked|Sautéed|Frosted)\s+for\s+\d/i.test(plain)) return true
  return false
}

