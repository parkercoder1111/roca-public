// ═══════════════════════════════════════════
//  XLSX Handler — ExcelJS-based read/write
//  Replaces the fragile ZIP/XML regex approach
// ═══════════════════════════════════════════

import ExcelJS from 'exceljs'
import fs from 'fs'
import { colToLetter, letterToCol } from '../shared/xlsx-utils'
import type { CellData, SheetData, WorkbookData, CellChange, CellStyle } from '../shared/xlsx-utils'

export type { CellData, SheetData, WorkbookData, CellChange }

// Standard Office theme color palette (theme indices 0-9)
const THEME_COLORS = [
  '#FFFFFF', // 0: lt1 (white/background)
  '#000000', // 1: dk1 (black/text)
  '#4472C4', // 2: lt2 (accent alternate)
  '#44546A', // 3: dk2 (dark alternate)
  '#4472C4', // 4: accent1
  '#ED7D31', // 5: accent2
  '#A5A5A5', // 6: accent3
  '#FFC000', // 7: accent4
  '#5B9BD5', // 8: accent5
  '#70AD47', // 9: accent6
]

function applyTint(hex: string, tint: number): string {
  // Parse hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  // Tint > 0 means lighten toward white; < 0 means darken toward black
  const apply = (c: number) => {
    if (tint > 0) return Math.round(c + (255 - c) * tint)
    return Math.round(c * (1 + tint))
  }
  const rr = Math.min(255, Math.max(0, apply(r)))
  const gg = Math.min(255, Math.max(0, apply(g)))
  const bb = Math.min(255, Math.max(0, apply(b)))
  return `#${rr.toString(16).padStart(2, '0')}${gg.toString(16).padStart(2, '0')}${bb.toString(16).padStart(2, '0')}`
}

function extractArgbColor(color: any): string | undefined {
  if (!color) return undefined
  // ARGB — explicit color
  if (color.argb) {
    const hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb
    return `#${hex}`
  }
  // Theme color — resolve from palette
  if (color.theme !== undefined && color.theme >= 0 && color.theme < THEME_COLORS.length) {
    const base = THEME_COLORS[color.theme]
    if (color.tint) return applyTint(base, color.tint)
    return base
  }
  return undefined
}

function safeISOString(d: Date): string | null {
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function extractBorder(border: any): boolean {
  if (!border) return false
  // ExcelJS border has style property
  return !!border.style && border.style !== 'none'
}

// ── CSV Read ──

function readCsv(filePath: string): WorkbookData {
  const text: string = fs.readFileSync(filePath, 'utf-8')
  // RFC 4180-compliant CSV parse — tracks quote state across newlines
  const rows: string[][] = []
  let csvCurrent = ''
  let csvInQuotes = false
  let csvRow: string[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (csvInQuotes && text[i + 1] === '"') { csvCurrent += '"'; i++ }
      else { csvInQuotes = !csvInQuotes }
    } else if (ch === ',' && !csvInQuotes) {
      csvRow.push(csvCurrent.trim()); csvCurrent = ''
    } else if ((ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) && !csvInQuotes) {
      if (ch === '\r') i++ // skip \n in CRLF
      csvRow.push(csvCurrent.trim()); csvCurrent = ''
      if (csvRow.some(c => c !== '')) rows.push(csvRow)
      csvRow = []
    } else if (ch !== '\r') {
      csvCurrent += ch
    }
  }
  if (csvCurrent || csvRow.length) { csvRow.push(csvCurrent.trim()); if (csvRow.some(c => c !== '')) rows.push(csvRow) }

  const cells: Record<string, CellData> = {}
  const colWidths: Record<number, number> = {}
  let maxRow = 0
  let maxCol = 0

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]

    const rowNum = r + 1
    if (rowNum > maxRow) maxRow = rowNum

    for (let c = 0; c < row.length; c++) {
      const colNum = c + 1
      if (colNum > maxCol) maxCol = colNum
      const val = row[c]
      if (val === '') continue

      const ref = `${colToLetter(colNum)}${rowNum}`
      // Try to parse numbers
      const num = Number(val)
      if (!isNaN(num) && val !== '') {
        cells[ref] = { value: num, type: 'number' }
      } else {
        cells[ref] = { value: val, type: 'string' }
      }

      // Track column widths
      const len = val.length + 2
      if (!colWidths[colNum] || len > colWidths[colNum]) {
        colWidths[colNum] = Math.min(len, 60)
      }
    }
  }

  return {
    sheets: [{
      name: 'Sheet1',
      cells,
      merges: [],
      colWidths,
      rowHeights: {},
      defaultColWidth: 10,
      maxRow,
      maxCol,
    }],
    fileName: '',
  }
}

// ── Read ──

export async function readWorkbook(filePath: string): Promise<WorkbookData> {
  // CSV files get parsed directly (no ExcelJS needed)
  if (filePath.toLowerCase().endsWith('.csv')) {
    return readCsv(filePath)
  }

  // Pre-process xlsx through LibreOffice to recalculate formulas and cache values.
  // ExcelJS can only read cached results — if formulas were written by openpyxl
  // or other tools that don't cache, all formula cells appear blank.
  let readPath = filePath
  try {
    const { execSync } = require('child_process')
    const path = require('path')
    const os = require('os')
    const tmpDir = os.tmpdir()
    const tmpFile = path.join(tmpDir, `roca-recalc-${Date.now()}.xlsx`)
    const fs = require('fs')
    fs.copyFileSync(filePath, tmpFile)
    execSync(`soffice --headless --calc --convert-to xlsx --outdir "${tmpDir}" "${tmpFile}"`, {
      timeout: 15000,
      stdio: 'ignore',
    })
    // LibreOffice overwrites the file in-place when outdir matches
    if (fs.existsSync(tmpFile)) {
      readPath = tmpFile
    }
  } catch {
    // LibreOffice not available or failed — fall back to reading original file
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(readPath)

  const sheets: SheetData[] = []

  workbook.eachSheet((worksheet) => {
    const cells: Record<string, CellData> = {}
    const merges: string[] = []
    const colWidths: Record<number, number> = {}
    const rowHeights: Record<number, number> = {}
    let maxRow = 0
    let maxCol = 0

    // Default column width from worksheet properties (WorksheetProperties.defaultColWidth is typed)
    const defaultColWidth = worksheet.properties.defaultColWidth ?? 8.43 // Excel default

    // Merged cells: prefer internal _merges map (keys = range strings); fall back to typed model.merges array
    // ExcelJS exposes _merges as a private member not present in its public types
    const privateMerges = (worksheet as unknown as { _merges?: Record<string, unknown> })._merges
    if (privateMerges) {
      merges.push(...Object.keys(privateMerges))
    } else {
      merges.push(...worksheet.model.merges)
    }

    // Frozen panes
    let frozenRow: number | undefined
    let frozenCol: number | undefined
    const views = worksheet.views
    if (views && views.length > 0) {
      const view = views[0]
      if (view.state === 'frozen') {
        frozenRow = view.ySplit || undefined
        frozenCol = view.xSplit || undefined
      }
    }

    // Cells
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > maxRow) maxRow = rowNumber
      if (row.height && row.height !== 15) { // 15 is default
        rowHeights[rowNumber] = row.height
      }

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber > maxCol) maxCol = colNumber
        const ref = `${colToLetter(colNumber)}${rowNumber}`

        const cellData: CellData = { value: null, type: 'null' }

        // Value extraction
        const rawValue = cell.value
        if (rawValue === null || rawValue === undefined) {
          // Value is null — but cell may still have fill/style (e.g. Gantt chart bars)
          // We'll check for style below and only record the cell if it has content OR style
        } else if (cell.formula) {
          cellData.formula = cell.formula
          cellData.type = 'formula'
          const result = cell.result
          cellData.value = result instanceof Date ? safeISOString(result)
            : (typeof result === 'object' && result !== null) ? String(result)
            : (result ?? null)
        } else if (typeof rawValue === 'object' && rawValue !== null) {
          // Handle complex types
          if ('formula' in rawValue) {
            const fv = rawValue as ExcelJS.CellFormulaValue
            cellData.formula = fv.formula
            cellData.type = 'formula'
            const r = fv.result
            cellData.value = r instanceof Date ? safeISOString(r) : (r instanceof Object ? null : (r ?? null))
          } else if ('sharedFormula' in rawValue) {
            const sv = rawValue as ExcelJS.CellSharedFormulaValue
            cellData.formula = sv.sharedFormula
            cellData.type = 'formula'
            const r = sv.result
            cellData.value = r instanceof Date ? safeISOString(r) : (r instanceof Object ? null : (r ?? null))
          } else if ('richText' in rawValue) {
            const rv = rawValue as ExcelJS.CellRichTextValue
            cellData.type = 'string'
            cellData.value = rv.richText.map(rt => rt.text || '').join('')
          } else if ('error' in rawValue) {
            const ev = rawValue as ExcelJS.CellErrorValue
            cellData.type = 'string'
            cellData.value = ev.error || '#ERROR!'
          } else if (rawValue instanceof Date) {
            cellData.type = 'date'
            cellData.value = safeISOString(rawValue)
          } else {
            cellData.type = 'string'
            cellData.value = String(rawValue)
          }
        } else if (typeof rawValue === 'number') {
          cellData.type = 'number'
          cellData.value = rawValue
        } else if (typeof rawValue === 'boolean') {
          cellData.type = 'boolean'
          cellData.value = rawValue
        } else {
          cellData.type = 'string'
          cellData.value = String(rawValue)
        }

        // Number format
        if (cell.numFmt && cell.numFmt !== 'General') {
          cellData.numFmt = cell.numFmt
        }

        // Style extraction
        const style: NonNullable<CellData['style']> = {}
        let hasStyle = false

        if (cell.font) {
          if (cell.font.bold) { style.bold = true; hasStyle = true }
          if (cell.font.italic) { style.italic = true; hasStyle = true }
          if (cell.font.underline) { style.underline = true; hasStyle = true }
          if (cell.font.size && cell.font.size !== 11) { style.fontSize = cell.font.size; hasStyle = true }
          const fc = extractArgbColor(cell.font.color)
          if (fc && fc !== '#000000') { style.fontColor = fc; hasStyle = true }
        }

        if (cell.fill && cell.fill.type === 'pattern') {
          const patternFill = cell.fill as ExcelJS.FillPattern
          const fg = extractArgbColor(patternFill.fgColor)
            || extractArgbColor(patternFill.bgColor)
          if (fg && fg !== '#FFFFFF' && fg !== '#ffffff') {
            style.fill = fg; hasStyle = true
          }
        }

        if (cell.alignment) {
          const a = cell.alignment
          if (a.horizontal || a.vertical || a.wrapText) {
            style.alignment = {}
            if (a.horizontal) style.alignment.horizontal = a.horizontal
            if (a.vertical && a.vertical !== 'bottom') style.alignment.vertical = a.vertical
            if (a.wrapText) style.alignment.wrapText = true
            hasStyle = true
          }
        }

        if (cell.border) {
          const b = cell.border
          const hasBorder = extractBorder(b.top) || extractBorder(b.bottom) ||
            extractBorder(b.left) || extractBorder(b.right)
          if (hasBorder) {
            style.border = {
              top: extractBorder(b.top),
              bottom: extractBorder(b.bottom),
              left: extractBorder(b.left),
              right: extractBorder(b.right),
            }
            hasStyle = true
          }
        }

        if (hasStyle) cellData.style = style

        // Only record cells that have a value OR a visual style
        if (cellData.value !== null || hasStyle) {
          cells[ref] = cellData
        }
      })
    })

    // Column widths — scan up to maxCol (worksheet.columnCount may be 0)
    const colScanEnd = Math.max(maxCol, worksheet.columnCount || 0)
    for (let i = 1; i <= colScanEnd; i++) {
      try {
        const col = worksheet.getColumn(i)
        if (col.width && col.width > 0) {
          colWidths[i] = col.width
        }
      } catch { /* column access can fail for sparse sheets */ }
    }

    // Auto-size ONLY columns without explicit widths — respect Excel's layout
    for (let c = 1; c <= maxCol; c++) {
      if (colWidths[c]) continue // has explicit width from Excel — respect it
      let maxLen = 0
      for (let r = 1; r <= Math.min(maxRow, 100); r++) {
        const ref = `${colToLetter(c)}${r}`
        const cell = cells[ref]
        if (cell && cell.value !== null) {
          const len = String(cell.value).length
          if (len > maxLen) maxLen = len
        }
      }
      if (maxLen > 0) {
        colWidths[c] = Math.min(maxLen + 2, 60)
      }
    }

    sheets.push({
      name: worksheet.name,
      cells,
      merges,
      colWidths,
      rowHeights,
      defaultColWidth,
      maxRow: Math.max(maxRow, 1),
      maxCol: Math.max(maxCol, 1),
      frozenRow,
      frozenCol,
    })
  })

  return { sheets, fileName: '' }
}

// ── Write ──

function writeCsvCells(filePath: string, changes: CellChange[]): { ok: boolean; error?: string } {
  // Read existing CSV, apply changes, write back
  const data = readCsv(filePath)
  const sheet = data.sheets[0]
  if (!sheet) return { ok: false, error: 'No sheet data' }

  // Apply changes to cells map
  for (const change of changes) {
    if (change.value === null || change.value === '') {
      delete sheet.cells[change.ref]
    } else {
      sheet.cells[change.ref] = {
        value: change.value,
        type: typeof change.value === 'number' ? 'number' : 'string',
      }
    }
    // Update maxRow/maxCol
    const m = change.ref.match(/^([A-Z]+)(\d+)$/)
    if (m) {
      const col = letterToCol(m[1])
      const row = parseInt(m[2])
      if (row > sheet.maxRow) sheet.maxRow = row
      if (col > sheet.maxCol) sheet.maxCol = col
    }
  }

  // Rebuild CSV
  const lines: string[] = []
  for (let r = 1; r <= sheet.maxRow; r++) {
    const cols: string[] = []
    for (let c = 1; c <= sheet.maxCol; c++) {
      const ref = `${colToLetter(c)}${r}`
      const cell = sheet.cells[ref]
      if (!cell || cell.value === null) {
        cols.push('')
      } else {
        const val = String(cell.value)
        // Quote if contains comma, quote, or newline
        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
          cols.push(`"${val.replace(/"/g, '""')}"`)
        } else {
          cols.push(val)
        }
      }
    }
    lines.push(cols.join(','))
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
  return { ok: true }
}

function applyStyleToCell(cell: any, style: CellStyle) {
  // Font
  const font: any = { ...(cell.font || {}) }
  if (style.bold !== undefined) font.bold = style.bold
  if (style.italic !== undefined) font.italic = style.italic
  if (style.underline !== undefined) font.underline = style.underline
  if (style.fontColor !== undefined) {
    if (style.fontColor) {
      font.color = { argb: 'FF' + style.fontColor.replace('#', '') }
    } else {
      // Empty string = clear color
      delete font.color
    }
  }
  if (style.fontSize) font.size = style.fontSize
  cell.font = font

  // Fill
  if (style.fill !== undefined) {
    if (style.fill) {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF' + style.fill.replace('#', '') },
      }
    } else {
      // Empty string = clear fill
      cell.fill = { type: 'pattern', pattern: 'none' }
    }
  }

  // Number format
  if (style.numFmt) {
    cell.numFmt = style.numFmt
  }

  // Alignment
  if (style.alignment) {
    cell.alignment = { ...(cell.alignment || {}), ...style.alignment }
  }
}

export async function writeCells(
  filePath: string,
  changes: CellChange[]
): Promise<{ ok: boolean; error?: string }> {
  // CSV files get written directly
  if (filePath.toLowerCase().endsWith('.csv')) {
    return writeCsvCells(filePath, changes)
  }

  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    for (const change of changes) {
      const worksheet = workbook.worksheets[change.sheetIndex]
      if (!worksheet) {
        console.warn(`[xlsx] Sheet index ${change.sheetIndex} not found, skipping`)
        continue
      }

      const cell = worksheet.getCell(change.ref)

      if (change.formula) {
        // Set as formula with optional cached result
        const fv: ExcelJS.CellFormulaValue = change.value !== null && change.value !== undefined
          ? { formula: change.formula, result: change.value as ExcelJS.CellFormulaValue['result'] }
          : { formula: change.formula }
        cell.value = fv
      } else if (change.value === null || change.value === '') {
        cell.value = null
      } else {
        cell.value = change.value
      }

      // Apply style changes
      if (change.style) {
        applyStyleToCell(cell, change.style)
      }
    }

    await workbook.xlsx.writeFile(filePath)
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown write error' }
  }
}
