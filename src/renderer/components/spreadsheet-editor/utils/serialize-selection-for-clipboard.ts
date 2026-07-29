import type { SheetData } from '@shared/xlsx-utils'
import { cellRef } from '@shared/xlsx-utils'

export function serializeSelectionForClipboard(
  sheet: SheetData,
  startRow: number, startCol: number,
  endRow: number, endCol: number
): string {
  const rows: string[] = []
  for (let r = startRow; r <= endRow; r++) {
    const cols: string[] = []
    for (let c = startCol; c <= endCol; c++) {
      const ref = cellRef(c, r)
      const cell = sheet.cells[ref]
      if (!cell || cell.value === null) cols.push('')
      else cols.push(String(cell.value))
    }
    rows.push(cols.join('\t'))
  }
  return rows.join('\n')
}
