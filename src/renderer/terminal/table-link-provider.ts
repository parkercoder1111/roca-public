import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm'

/**
 * Custom link provider that detects URLs split across multiple lines
 * in pipe-delimited table output (e.g., Claude Code markdown tables).
 *
 * The default WebLinksAddon fails on multi-line table URLs because:
 * 1. Table formatters insert explicit newlines (not soft-wraps), so isWrapped is false
 * 2. Even with soft-wraps, the addon stops joining lines at the first space character,
 *    and table rows always contain spaces for column padding
 *
 * This provider parses pipe-delimited table structure to find and reassemble
 * URLs that span multiple rows within the same column.
 */
export class TableLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly handler: (event: MouseEvent, uri: string) => void
  ) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const buf = this.terminal.buffer.active
    const lineObj = buf.getLine(y - 1)
    if (!lineObj) return callback(undefined)

    const lineStr = lineObj.translateToString(true)

    // Only handle pipe-delimited table rows
    if (!lineStr.includes('|')) return callback(undefined)

    const pipes = getPipePositions(lineStr)
    if (pipes.length < 2) return callback(undefined)

    const links: ILink[] = []

    for (let col = 0; col < pipes.length - 1; col++) {
      const cellText = extractCellText(lineStr, pipes, col)
      if (!cellText || isSeparator(cellText)) continue

      if (/^https?:\/\//.test(cellText)) {
        // URL starts in this cell — assemble downward
        const result = this.assembleUrlFromStart(y - 1, col)
        if (result) links.push(this.makeLink(result))
      } else if (looksLikeUrlContinuation(cellText)) {
        // Might be a URL continuation — look upward for the start
        const result = this.findAndAssembleUrl(y - 1, col)
        if (result) links.push(this.makeLink(result))
      }
    }

    callback(links.length > 0 ? links : undefined)
  }

  /**
   * Starting from a line with `https://` in a given column,
   * assemble the full URL by appending continuation cells below.
   */
  private assembleUrlFromStart(startRow: number, colIdx: number): UrlInfo | null {
    const buf = this.terminal.buffer.active
    const startLine = buf.getLine(startRow)
    if (!startLine) return null

    const startStr = startLine.translateToString(true)
    const startPipes = getPipePositions(startStr)
    if (colIdx >= startPipes.length - 1) return null

    const cellText = extractCellText(startStr, startPipes, colIdx)
    if (!cellText || !/^https?:\/\//.test(cellText)) return null

    let fullUrl = cellText
    let endRow = startRow
    const cellStartInLine = findCellTextStart(startStr, startPipes, colIdx)
    let endX = cellStartInLine + cellText.length

    // Look at subsequent rows for continuations in the same column
    for (let row = startRow + 1; row < startRow + 20; row++) {
      const line = buf.getLine(row)
      if (!line) break

      const str = line.translateToString(true)
      if (!str.includes('|')) break

      const pipes = getPipePositions(str)
      if (colIdx >= pipes.length - 1) break

      // Verify pipe alignment (same table structure)
      if (!pipesAligned(startPipes, pipes, colIdx)) break

      const nextCellText = extractCellText(str, pipes, colIdx)
      if (!nextCellText || isSeparator(nextCellText)) break
      if (/^https?:\/\//.test(nextCellText)) break // New URL, not continuation
      if (!looksLikeUrlContinuation(nextCellText)) break

      fullUrl += nextCellText
      endRow = row
      const nextStart = findCellTextStart(str, pipes, colIdx)
      endX = nextStart + nextCellText.length
    }

    // Only handle multi-line URLs (single-line already handled by WebLinksAddon)
    if (endRow === startRow) return null

    // Validate the assembled URL
    try {
      new URL(fullUrl)
    } catch {
      return null
    }

    return {
      url: fullUrl,
      startRow,
      startX: cellStartInLine,
      endRow,
      endX,
    }
  }

  /**
   * From a potential continuation line, look upward to find the URL start,
   * then assemble the full URL from start downward.
   */
  private findAndAssembleUrl(row: number, colIdx: number): UrlInfo | null {
    const buf = this.terminal.buffer.active
    const lineObj = buf.getLine(row)
    if (!lineObj) return null

    const lineStr = lineObj.translateToString(true)
    const pipes = getPipePositions(lineStr)

    for (let checkRow = row - 1; checkRow >= Math.max(0, row - 20); checkRow--) {
      const line = buf.getLine(checkRow)
      if (!line) break

      const str = line.translateToString(true)
      if (!str.includes('|')) break

      const checkPipes = getPipePositions(str)
      if (colIdx >= checkPipes.length - 1) break
      if (!pipesAligned(pipes, checkPipes, colIdx)) break

      const cellText = extractCellText(str, checkPipes, colIdx)
      if (!cellText || isSeparator(cellText)) break

      if (/^https?:\/\//.test(cellText)) {
        // Found the URL start — assemble from here
        return this.assembleUrlFromStart(checkRow, colIdx)
      }

      // If this doesn't look like URL content either, stop
      if (!looksLikeUrlContinuation(cellText)) break
    }

    return null
  }

  private makeLink(info: UrlInfo): ILink {
    return {
      range: {
        start: { x: info.startX + 1, y: info.startRow + 1 },
        end: { x: info.endX, y: info.endRow + 1 },
      },
      text: info.url,
      activate: (event) => {
        event.preventDefault()
        this.handler(event, info.url)
      },
    }
  }
}

interface UrlInfo {
  url: string
  startRow: number
  startX: number // 0-based
  endRow: number
  endX: number // 0-based, exclusive
}

function getPipePositions(line: string): number[] {
  const positions: number[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') positions.push(i)
  }
  return positions
}

function extractCellText(line: string, pipes: number[], colIdx: number): string {
  if (colIdx >= pipes.length - 1) return ''
  return line.substring(pipes[colIdx] + 1, pipes[colIdx + 1]).trim()
}

function findCellTextStart(line: string, pipes: number[], colIdx: number): number {
  const cellStart = pipes[colIdx] + 1
  const cellEnd = pipes[colIdx + 1]
  const raw = line.substring(cellStart, cellEnd)
  const leading = raw.length - raw.trimStart().length
  return cellStart + leading
}

function isSeparator(text: string): boolean {
  // Use \x2D (hyphen) to prevent Tailwind content scanner from treating this as a CSS arbitrary class
  return /^[\x2D:=]+$/.test(text)
}

/** Check if text consists only of URL-valid characters (RFC 3986) */
function looksLikeUrlContinuation(text: string): boolean {
  return /^[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/.test(text)
}

/** Check that pipe positions align between two lines at the given column */
function pipesAligned(ref: number[], check: number[], colIdx: number): boolean {
  if (colIdx + 1 >= ref.length || colIdx + 1 >= check.length) return false
  return (
    Math.abs(ref[colIdx] - check[colIdx]) <= 2 &&
    Math.abs(ref[colIdx + 1] - check[colIdx + 1]) <= 2
  )
}
