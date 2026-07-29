// ═══════════════════════════════════════════
//  Shared XLSX types and helpers
//  Used by both main process (xlsx-handler)
//  and renderer (SpreadsheetEditor)
// ═══════════════════════════════════════════

// ── Types ──

export interface CellData {
  value: string | number | boolean | null
  formula?: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'null'
  numFmt?: string
  style?: {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    fill?: string      // hex color e.g. "#FF0000"
    fontColor?: string  // hex color
    fontSize?: number
    alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean }
    border?: {
      top?: boolean
      bottom?: boolean
      left?: boolean
      right?: boolean
    }
  }
}

export interface SheetData {
  name: string
  cells: Record<string, CellData>   // keyed by ref like "A1", "B2"
  merges: string[]                   // e.g. ["A1:C1", "B2:D5"]
  colWidths: Record<number, number>  // 1-indexed col number → width in chars
  rowHeights: Record<number, number> // 1-indexed row number → height
  defaultColWidth: number            // worksheet default column width in chars
  maxRow: number
  maxCol: number
  frozenRow?: number
  frozenCol?: number
}

export interface WorkbookData {
  sheets: SheetData[]
  fileName: string
  error?: string
}

export interface CellStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fill?: string      // hex color
  fontColor?: string  // hex color
  fontSize?: number
  numFmt?: string
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean }
}

export interface CellChange {
  sheetIndex: number
  ref: string
  value: string | number | boolean | null
  formula?: string
  style?: CellStyle
}

// ── Helpers ──

export function colToLetter(col: number): string {
  let result = ''
  let c = col
  while (c > 0) {
    const mod = (c - 1) % 26
    result = String.fromCharCode(65 + mod) + result
    c = Math.floor((c - 1) / 26)
  }
  return result
}

export function letterToCol(letter: string): number {
  let col = 0
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64)
  }
  return col
}

export function cellRef(col: number, row: number): string {
  return `${colToLetter(col)}${row}`
}

export function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^([A-Z]+)(\d+)$/)
  if (!m) return null
  return { col: letterToCol(m[1]), row: parseInt(m[2]) }
}

// Dirty map key helpers — centralizes the format to avoid scattered string concatenation
export function dirtyKey(sheetIndex: number, ref: string): string {
  return `${sheetIndex}:${ref}`
}

export function parseDirtyKey(key: string): { sheetIndex: number; ref: string } {
  const idx = key.indexOf(':')
  return { sheetIndex: parseInt(key.slice(0, idx)), ref: key.slice(idx + 1) }
}
