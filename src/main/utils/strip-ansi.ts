/**
 * Strip ANSI escape codes from terminal output to produce clean text.
 */
export function stripAnsi(text: string): string {
  return text
    // CSI sequences: \x1b[ (params) (intermediates) (final byte)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC sequences: \x1b] ... terminated by BEL or ST
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/gs, '')
    // Character set selection: \x1b( \x1b) \x1b# etc.
    .replace(/\x1b[()#%][A-Za-z0-9]/g, '')
    // Other 2-char escape sequences (save/restore cursor, index, etc.)
    .replace(/\x1b[78DMHNOcn><=]/g, '')
    // Any remaining lone ESC characters
    .replace(/\x1b/g, '')
    // Control chars (keep \n \r \t)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}
