import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { Upload } from '@shared/types'
import type { CellData, SheetData, WorkbookData, CellStyle } from '@shared/xlsx-utils'
import { colToLetter, letterToCol, cellRef, dirtyKey, parseDirtyKey } from '@shared/xlsx-utils'
import { Toolbar } from './components/toolbar'
import { ContextMenu } from './components/context-menu'
import { FormattingToolbar } from './components/formatting-toolbar'
import { formatValue } from './utils/format-value'
import { serializeSelectionForClipboard } from './utils/serialize-selection-for-clipboard'

interface Props {
  upload: Upload
  onBack: () => void
}

// Constants
const DEFAULT_ROW_HEIGHT = 20
const HEADER_HEIGHT = 22
const ROW_HEADER_WIDTH = 40
const OVERSCAN = 8
const POLL_INTERVAL = 2000 // 2s polling for external changes

// ── Undo action type ──

interface UndoAction {
  // Map of dirtyKey -> previous value (null means cell was clean)
  changes: Map<string, { value: any; formula?: string; style?: CellStyle } | null>
}

// ── Component ──

export function SpreadsheetEditor({ upload, onBack }: Props) {
  const [workbook, setWorkbook] = useState<WorkbookData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number }>({ row: 1, col: 1 })
  const [selectionEnd, setSelectionEnd] = useState<{ row: number; col: number } | null>(null)
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dirty, setDirty] = useState<Map<string, { value: any; formula?: string; style?: CellStyle }>>(new Map())
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [customColWidths, setCustomColWidths] = useState<Map<number, number>>(new Map())

  // Search
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatches, setSearchMatches] = useState<{ row: number; col: number }[]>([])
  const [searchMatchIndex, setSearchMatchIndex] = useState(0)

  // Virtual scroll
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // Undo/redo
  const [undoStack, setUndoStack] = useState<UndoAction[]>([])
  const [redoStack, setRedoStack] = useState<UndoAction[]>([])

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null)

  // Fill handle drag
  const [fillDrag, setFillDrag] = useState<{ startRow: number; startCol: number; endRow: number; endCol: number; currentRow: number; currentCol: number } | null>(null)

  const gridRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const formulaInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [editingInFormulaBar, setEditingInFormulaBar] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const lastMtimeRef = useRef<number>(0)

  // Column resize
  const resizingCol = useRef<{ col: number; startX: number; startWidth: number } | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  // Fill handle drag ref
  const fillDragRef = useRef(false)

  // Load workbook
  const loadWorkbook = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.electronAPI.readXlsxWorkbook(upload.stored_name)
      if (data.error) {
        setError(data.error)
      } else {
        setWorkbook(data as WorkbookData)
        setDirty(new Map())
        setUndoStack([])
        setRedoStack([])
      }
      // Update mtime (graceful if handler not registered yet)
      try {
        const mtimeResult = await window.electronAPI.checkXlsxMtime(upload.stored_name)
        lastMtimeRef.current = mtimeResult.mtime
      } catch { /* handler may not exist in older builds */ }
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : String(e)) || 'Failed to load workbook')
    }
    setLoading(false)
  }, [upload.stored_name])

  useEffect(() => { loadWorkbook() }, [loadWorkbook])

  // Unmount cleanup: clear save timers and mark unmounted
  useEffect(() => () => {
    mountedRef.current = false
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
  }, [])

  // File watching — auto-refresh on external changes
  useEffect(() => {
    const storedName = upload.stored_name
    window.electronAPI.watchXlsxFile(storedName)
    const cleanup = window.electronAPI.onXlsxFileChanged((changed: string) => {
      if (changed !== storedName) return
      if (dirtyRef.current.size === 0) {
        loadWorkbook()
      } else {
        setSaveMessage('File changed externally — save or refresh to sync')
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => setSaveMessage(null), 4000)
      }
    })
    return () => {
      cleanup()
      window.electronAPI.unwatchXlsxFile(storedName)
    }
  }, [upload.stored_name, loadWorkbook])

  // Polling fallback — check mtime every 2s (fs.watch can miss events on macOS)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const result = await window.electronAPI.checkXlsxMtime(upload.stored_name)
        if (result.mtime > 0 && lastMtimeRef.current > 0 && result.mtime !== lastMtimeRef.current) {
          if (dirtyRef.current.size === 0) {
            lastMtimeRef.current = result.mtime
            loadWorkbook()
          } else {
            setSaveMessage('File changed externally — save or refresh to sync')
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
            saveTimerRef.current = setTimeout(() => setSaveMessage(null), 4000)
          }
        }
      } catch { /* ignore polling errors */ }
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [upload.stored_name, loadWorkbook])

  // Measure viewport
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = () => {
      setViewportWidth(el.clientWidth)
      setViewportHeight(el.clientHeight)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Current sheet
  const sheet = workbook?.sheets[activeSheet] || null

  // Grid dimensions
  const totalRows = Math.max((sheet?.maxRow || 0) + 50, 100)
  const totalCols = Math.max((sheet?.maxCol || 0) + 10, 26)

  // Column width
  const getColWidth = useCallback((col: number): number => {
    const custom = customColWidths.get(col)
    if (custom) return custom
    if (!sheet) return 72
    const w = sheet.colWidths[col]
    if (w) return Math.max(Math.round(w * 7 + 12), 30)
    const def = sheet.defaultColWidth || 8.43
    return Math.round(def * 7 + 12)
  }, [sheet, customColWidths])

  // Row height
  const getRowHeight = useCallback((row: number): number => {
    if (!sheet) return DEFAULT_ROW_HEIGHT
    const h = sheet.rowHeights[row]
    return h ? Math.max(Math.round(h * 1.33), DEFAULT_ROW_HEIGHT) : DEFAULT_ROW_HEIGHT
  }, [sheet])

  // Column positions
  const colPositions = useMemo(() => {
    const positions: number[] = [0]
    let x = 0
    for (let c = 1; c <= totalCols; c++) {
      x += getColWidth(c)
      positions.push(x)
    }
    return positions
  }, [totalCols, getColWidth])

  // Row positions
  const rowPositions = useMemo(() => {
    const positions: number[] = [0]
    let y = 0
    for (let r = 1; r <= totalRows; r++) {
      y += getRowHeight(r)
      positions.push(y)
    }
    return positions
  }, [totalRows, getRowHeight])

  const totalWidth = colPositions[totalCols] || 0
  const totalHeight = rowPositions[totalRows] || 0

  // Frozen panes
  const frozenRow = sheet?.frozenRow || 0
  const frozenCol = sheet?.frozenCol || 0

  // Visible range (accounts for frozen panes)
  const visibleRange = useMemo(() => {
    const dataScrollTop = scrollTop
    const dataScrollLeft = scrollLeft

    // Before viewport is measured, render all rows/cols to avoid blank grid
    if (viewportHeight === 0 || viewportWidth === 0) {
      return { startRow: 1, endRow: totalRows, startCol: 1, endCol: totalCols }
    }

    let startRow = frozenRow + 1
    for (let r = frozenRow + 1; r <= totalRows; r++) {
      if (rowPositions[r] > dataScrollTop) { startRow = r; break }
    }
    startRow = Math.max(frozenRow + 1, startRow - OVERSCAN)

    let endRow = totalRows
    for (let r = startRow; r <= totalRows; r++) {
      if (rowPositions[r - 1] > dataScrollTop + viewportHeight) { endRow = r; break }
    }
    endRow = Math.min(totalRows, endRow + OVERSCAN)

    let startCol = frozenCol + 1
    for (let c = frozenCol + 1; c <= totalCols; c++) {
      if (colPositions[c] > dataScrollLeft) { startCol = c; break }
    }
    startCol = Math.max(frozenCol + 1, startCol - OVERSCAN)

    let endCol = totalCols
    for (let c = startCol; c <= totalCols; c++) {
      if (colPositions[c - 1] > dataScrollLeft + viewportWidth) { endCol = c; break }
    }
    endCol = Math.min(totalCols, endCol + OVERSCAN)

    return { startRow, endRow, startCol, endCol }
  }, [scrollTop, scrollLeft, viewportWidth, viewportHeight, rowPositions, colPositions, totalRows, totalCols, frozenRow, frozenCol])

  // Get cell data
  const getCellData = useCallback((ref: string): CellData | null => {
    if (!sheet) return null
    const dirtyCell = dirty.get(dirtyKey(activeSheet, ref))
    if (dirtyCell) {
      const original = sheet.cells[ref]
      const mergedStyle = dirtyCell.style
        ? { ...(original?.style || {}), ...dirtyCell.style }
        : original?.style
      return {
        ...original,
        value: dirtyCell.value,
        formula: dirtyCell.formula,
        type: dirtyCell.formula ? 'formula'
          : typeof dirtyCell.value === 'number' ? 'number'
          : typeof dirtyCell.value === 'boolean' ? 'boolean'
          : dirtyCell.value === null ? 'null'
          : 'string',
        numFmt: dirtyCell.style?.numFmt || original?.numFmt,
        style: mergedStyle,
      } as CellData
    }
    return sheet.cells[ref] || null
  }, [sheet, activeSheet, dirty])

  // Display value
  const getDisplayValue = useCallback((col: number, row: number): string => {
    const ref = cellRef(col, row)
    const cell = getCellData(ref)
    if (!cell || cell.value === null) return ''
    return formatValue(cell.value, cell.numFmt)
  }, [getCellData])

  // Selection range
  const selectionRange = useMemo(() => {
    if (!selectionEnd) return null
    return {
      startRow: Math.min(selectedCell.row, selectionEnd.row),
      startCol: Math.min(selectedCell.col, selectionEnd.col),
      endRow: Math.max(selectedCell.row, selectionEnd.row),
      endCol: Math.max(selectedCell.col, selectionEnd.col),
    }
  }, [selectedCell, selectionEnd])

  // Effective selection (accounts for no selection = single cell)
  const effectiveRange = useMemo(() => {
    return selectionRange || {
      startRow: selectedCell.row, startCol: selectedCell.col,
      endRow: selectedCell.row, endCol: selectedCell.col,
    }
  }, [selectedCell, selectionRange])

  // ── Status bar stats ──
  const statusBarStats = useMemo(() => {
    if (!sheet) return null
    const range = effectiveRange
    // Only show stats when more than one cell is selected
    if (range.startRow === range.endRow && range.startCol === range.endCol) return null

    let sum = 0
    let count = 0
    let numCount = 0
    let min = Infinity
    let max = -Infinity

    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const ref = cellRef(c, r)
        const cell = getCellData(ref)
        if (cell && cell.value !== null && cell.value !== undefined && cell.value !== '') {
          count++
          const num = typeof cell.value === 'number' ? cell.value : parseFloat(String(cell.value))
          if (!isNaN(num)) {
            sum += num
            numCount++
            if (num < min) min = num
            if (num > max) max = num
          }
        }
      }
    }

    if (count === 0) return null

    return {
      count,
      sum: numCount > 0 ? sum : null,
      avg: numCount > 0 ? sum / numCount : null,
      min: numCount > 0 ? min : null,
      max: numCount > 0 ? max : null,
    }
  }, [sheet, effectiveRange, getCellData])

  // ── Edit helpers ──

  const pushUndo = useCallback((previousDirty: Map<string, { value: any; formula?: string; style?: CellStyle }>, changedKeys: string[]) => {
    const changes = new Map<string, { value: any; formula?: string; style?: CellStyle } | null>()
    for (const key of changedKeys) {
      const prev = previousDirty.get(key)
      changes.set(key, prev || null)
    }
    setUndoStack(stack => [...stack.slice(-50), { changes }]) // cap at 50
    setRedoStack([]) // clear redo on new action
  }, [])

  const commitEdit = useCallback(() => {
    if (!editingCell) return
    const ref = cellRef(editingCell.col, editingCell.row)
    const original = sheet?.cells[ref]
    const trimmed = editValue.trim()

    let newValue: any = null
    let formula: string | undefined

    if (trimmed === '') {
      newValue = null
    } else if (trimmed.startsWith('=')) {
      formula = trimmed.slice(1)
      newValue = original?.value ?? null
    } else if (!isNaN(Number(trimmed)) && trimmed !== '') {
      newValue = Number(trimmed)
    } else if (trimmed.toLowerCase() === 'true') {
      newValue = true
    } else if (trimmed.toLowerCase() === 'false') {
      newValue = false
    } else {
      newValue = trimmed
    }

    const origValue = original?.value ?? null
    const origFormula = original?.formula
    const key = dirtyKey(activeSheet, ref)
    if (newValue === origValue && formula === origFormula) {
      if (dirty.has(key)) {
        pushUndo(dirty, [key])
        setDirty(prev => {
          const next = new Map(prev)
          next.delete(key)
          return next
        })
      }
      setEditingCell(null)
      setEditingInFormulaBar(false)
      return
    }

    pushUndo(dirty, [key])
    setDirty(prev => {
      const next = new Map(prev)
      next.set(key, { value: newValue, formula })
      return next
    })
    setEditingCell(null)
    setEditingInFormulaBar(false)
  }, [editingCell, editValue, sheet, activeSheet, dirty, pushUndo])

  const cancelEdit = useCallback(() => {
    setEditingCell(null)
    setEditingInFormulaBar(false)
  }, [])

  const startEditing = useCallback((row: number, col: number, initialValue?: string) => {
    const ref = cellRef(col, row)
    const cell = getCellData(ref)

    let val: string
    if (initialValue !== undefined) {
      val = initialValue
    } else if (cell?.formula) {
      val = `=${cell.formula}`
    } else if (cell?.value !== null && cell?.value !== undefined) {
      val = String(cell.value)
    } else {
      val = ''
    }

    setEditingCell({ row, col })
    setEditValue(val)
    setSelectionEnd(null)
  }, [getCellData])

  // Save changes
  const saveChanges = useCallback(async () => {
    if (dirty.size === 0) return
    setIsSaving(true)
    setSaveMessage(null)

    const changes = Array.from(dirty.entries()).map(([key, data]) => {
      const parsed = parseDirtyKey(key)
      return {
        sheetIndex: parsed.sheetIndex,
        ref: parsed.ref,
        value: data.value,
        formula: data.formula,
        style: data.style,
      }
    })
    // Snapshot the keys being saved so concurrent edits are not lost
    const savedKeys = new Set(Array.from(dirty.keys()))

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)

    try {
      const result = await window.electronAPI.writeXlsxCells(upload.stored_name, changes)
      if (!mountedRef.current) return
      if (result.ok) {
        setSaveMessage(`Saved ${changes.length} cell${changes.length > 1 ? 's' : ''}`)
        // Reload workbook data but only remove saved keys from dirty, preserving
        // any edits the user made while the async write was in flight.
        try {
          const data = await window.electronAPI.readXlsxWorkbook(upload.stored_name)
          if (!mountedRef.current) return
          if (!data.error) {
            setWorkbook(data as WorkbookData)
            setDirty(prev => {
              const next = new Map(prev)
              for (const key of savedKeys) next.delete(key)
              return next
            })
            setUndoStack([])
            setRedoStack([])
          }
          try {
            const mtimeResult = await window.electronAPI.checkXlsxMtime(upload.stored_name)
            lastMtimeRef.current = mtimeResult.mtime
          } catch { /* handler may not exist in older builds */ }
        } catch { /* reload failed; leave dirty intact */ }
        if (mountedRef.current) saveTimerRef.current = setTimeout(() => setSaveMessage(null), 2000)
      } else {
        setSaveMessage(`Error: ${result.error}`)
        saveTimerRef.current = setTimeout(() => setSaveMessage(null), 5000)
      }
    } catch (e: unknown) {
      if (!mountedRef.current) return
      setSaveMessage(`Error: ${e instanceof Error ? e.message : String(e)}`)
      saveTimerRef.current = setTimeout(() => setSaveMessage(null), 5000)
    }
    setIsSaving(false)
  }, [dirty, upload.stored_name])

  // Auto-save: debounce 1.5s after last edit
  useEffect(() => {
    if (dirty.size === 0) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      if (!editingCell) {
        saveChanges()
      }
    }, 1500)
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [dirty, editingCell, saveChanges])

  // Copy
  const copySelection = useCallback(() => {
    if (!sheet) return
    const range = effectiveRange
    const text = serializeSelectionForClipboard(
      sheet, range.startRow, range.startCol, range.endRow, range.endCol
    )
    navigator.clipboard.writeText(text)
  }, [sheet, effectiveRange])

  // Paste
  const pasteFromClipboard = useCallback(async () => {
    if (!sheet) return
    try {
      const text = await navigator.clipboard.readText()
      const rows = text.split('\n').map(r => r.split('\t'))
      const changedKeys: string[] = []
      const next = new Map(dirty)
      rows.forEach((cols, ri) => {
        cols.forEach((val, ci) => {
          const r = selectedCell.row + ri
          const c = selectedCell.col + ci
          const ref = cellRef(c, r)
          let parsed: any = val.trim()
          if (parsed === '') parsed = null
          else if (!isNaN(Number(parsed))) parsed = Number(parsed)
          const key = dirtyKey(activeSheet, ref)
          changedKeys.push(key)
          next.set(key, { value: parsed })
        })
      })
      pushUndo(dirty, changedKeys)
      setDirty(next)
    } catch { /* clipboard read failed */ }
  }, [sheet, selectedCell, activeSheet, pushUndo, dirty])

  // Delete selection
  const deleteSelection = useCallback(() => {
    const range = effectiveRange
    const changedKeys: string[] = []
    const next = new Map(dirty)
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const key = dirtyKey(activeSheet, cellRef(c, r))
        changedKeys.push(key)
        next.set(key, { value: null })
      }
    }
    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [effectiveRange, activeSheet, pushUndo, dirty])

  // Undo
  const performUndo = useCallback(() => {
    if (undoStack.length === 0) return
    const action = undoStack[undoStack.length - 1]
    setUndoStack(stack => stack.slice(0, -1))

    // Save current state for redo
    const redoChanges = new Map<string, { value: any; formula?: string; style?: CellStyle } | null>()
    for (const key of action.changes.keys()) {
      const current = dirty.get(key)
      redoChanges.set(key, current || null)
    }
    setRedoStack(stack => [...stack, { changes: redoChanges }])

    // Apply undo
    setDirty(prev => {
      const next = new Map(prev)
      for (const [key, value] of action.changes) {
        if (value === null) {
          next.delete(key)
        } else {
          next.set(key, value)
        }
      }
      return next
    })
  }, [undoStack, dirty])

  // Redo
  const performRedo = useCallback(() => {
    if (redoStack.length === 0) return
    const action = redoStack[redoStack.length - 1]
    setRedoStack(stack => stack.slice(0, -1))

    // Save current state for undo
    const undoChanges = new Map<string, { value: any; formula?: string; style?: CellStyle } | null>()
    for (const key of action.changes.keys()) {
      const current = dirty.get(key)
      undoChanges.set(key, current || null)
    }
    setUndoStack(stack => [...stack, { changes: undoChanges }])

    // Apply redo
    setDirty(prev => {
      const next = new Map(prev)
      for (const [key, value] of action.changes) {
        if (value === null) {
          next.delete(key)
        } else {
          next.set(key, value)
        }
      }
      return next
    })
  }, [redoStack, dirty])

  // Sort column
  const sortColumn = useCallback((col: number, ascending: boolean) => {
    if (!sheet) return
    const maxRow = sheet.maxRow
    if (maxRow <= 1) return

    // Determine if first row is header (start data from row 2)
    const dataStartRow = 2
    const rows: { row: number; value: any }[] = []
    for (let r = dataStartRow; r <= maxRow; r++) {
      const ref = cellRef(col, r)
      const cell = getCellData(ref)
      rows.push({ row: r, value: cell?.value ?? null })
    }

    rows.sort((a, b) => {
      if (a.value === null && b.value === null) return 0
      if (a.value === null) return 1
      if (b.value === null) return -1
      if (typeof a.value === 'number' && typeof b.value === 'number') {
        return ascending ? a.value - b.value : b.value - a.value
      }
      const sa = String(a.value).toLowerCase()
      const sb = String(b.value).toLowerCase()
      return ascending ? sa.localeCompare(sb) : sb.localeCompare(sa)
    })

    // Build cell changes: swap all columns for the sorted rows
    const changedKeys: string[] = []
    const next = new Map(dirty)
    for (let c = 1; c <= sheet.maxCol; c++) {
      // Collect original values for all rows in this column
      const originalValues: (CellData | null)[] = []
      for (let r = dataStartRow; r <= maxRow; r++) {
        originalValues.push(getCellData(cellRef(c, r)))
      }
      // Place them in sorted order
      for (let i = 0; i < rows.length; i++) {
        const targetRow = dataStartRow + i
        const sourceIndex = rows[i].row - dataStartRow
        const sourceCell = originalValues[sourceIndex]
        const ref = cellRef(c, targetRow)
        const key = dirtyKey(activeSheet, ref)
        changedKeys.push(key)
        next.set(key, {
          value: sourceCell?.value ?? null,
          formula: sourceCell?.formula,
        })
      }
    }
    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [sheet, activeSheet, getCellData, pushUndo, dirty])

  // Insert row
  const insertRow = useCallback((afterRow: number) => {
    if (!sheet) return
    const maxRow = sheet.maxRow
    const changedKeys: string[] = []
    const next = new Map(dirty)
    // Shift rows down from maxRow to afterRow+1
    for (let r = maxRow; r > afterRow; r--) {
      for (let c = 1; c <= sheet.maxCol; c++) {
        const sourceRef = cellRef(c, r)
        const targetRef = cellRef(c, r + 1)
        const sourceCell = getCellData(sourceRef)
        const key = dirtyKey(activeSheet, targetRef)
        changedKeys.push(key)
        next.set(key, { value: sourceCell?.value ?? null, formula: sourceCell?.formula })
      }
    }
    // Clear the new row
    for (let c = 1; c <= sheet.maxCol; c++) {
      const key = dirtyKey(activeSheet, cellRef(c, afterRow + 1))
      changedKeys.push(key)
      next.set(key, { value: null })
    }
    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [sheet, activeSheet, getCellData, pushUndo, dirty])

  // Insert column
  const insertColumn = useCallback((afterCol: number) => {
    if (!sheet) return
    const maxCol = sheet.maxCol
    const changedKeys: string[] = []
    const next = new Map(dirty)
    for (let c = maxCol; c > afterCol; c--) {
      for (let r = 1; r <= sheet.maxRow; r++) {
        const sourceRef = cellRef(c, r)
        const targetRef = cellRef(c + 1, r)
        const sourceCell = getCellData(sourceRef)
        const key = dirtyKey(activeSheet, targetRef)
        changedKeys.push(key)
        next.set(key, { value: sourceCell?.value ?? null, formula: sourceCell?.formula })
      }
    }
    for (let r = 1; r <= sheet.maxRow; r++) {
      const key = dirtyKey(activeSheet, cellRef(afterCol + 1, r))
      changedKeys.push(key)
      next.set(key, { value: null })
    }
    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [sheet, activeSheet, getCellData, pushUndo, dirty])

  // Delete row
  const deleteRow = useCallback((row: number) => {
    if (!sheet) return
    const maxRow = sheet.maxRow
    const changedKeys: string[] = []
    const next = new Map(dirty)
    for (let r = row; r < maxRow; r++) {
      for (let c = 1; c <= sheet.maxCol; c++) {
        const sourceRef = cellRef(c, r + 1)
        const targetRef = cellRef(c, r)
        const sourceCell = getCellData(sourceRef)
        const key = dirtyKey(activeSheet, targetRef)
        changedKeys.push(key)
        next.set(key, { value: sourceCell?.value ?? null, formula: sourceCell?.formula })
      }
    }
    // Clear last row
    for (let c = 1; c <= sheet.maxCol; c++) {
      const key = dirtyKey(activeSheet, cellRef(c, maxRow))
      changedKeys.push(key)
      next.set(key, { value: null })
    }
    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [sheet, activeSheet, getCellData, pushUndo, dirty])

  // Delete column
  const deleteColumn = useCallback((col: number) => {
    if (!sheet) return
    const maxCol = sheet.maxCol
    const changedKeys: string[] = []
    const next = new Map(dirty)
    for (let c = col; c < maxCol; c++) {
      for (let r = 1; r <= sheet.maxRow; r++) {
        const sourceRef = cellRef(c + 1, r)
        const targetRef = cellRef(c, r)
        const sourceCell = getCellData(sourceRef)
        const key = dirtyKey(activeSheet, targetRef)
        changedKeys.push(key)
        next.set(key, { value: sourceCell?.value ?? null, formula: sourceCell?.formula })
      }
    }
    for (let r = 1; r <= sheet.maxRow; r++) {
      const key = dirtyKey(activeSheet, cellRef(maxCol, r))
      changedKeys.push(key)
      next.set(key, { value: null })
    }
    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [sheet, activeSheet, getCellData, pushUndo, dirty])

  // Auto-fit column width to content
  const autoFitColumn = useCallback((col: number) => {
    if (!sheet) return
    let maxLen = 0
    for (let r = 1; r <= Math.min(sheet.maxRow, 500); r++) {
      const ref = cellRef(col, r)
      const cell = getCellData(ref)
      if (cell && cell.value !== null) {
        const display = formatValue(cell.value, cell.numFmt)
        const len = display.length
        if (len > maxLen) maxLen = len
      }
    }
    const width = Math.max(30, Math.min(maxLen * 7.5 + 16, 400))
    setCustomColWidths(prev => {
      const next = new Map(prev)
      next.set(col, width)
      return next
    })
  }, [sheet, getCellData])

  // Apply formatting to selection
  const applyFormatting = useCallback((styleUpdate: CellStyle) => {
    if (!sheet) return
    const range = effectiveRange
    const changedKeys: string[] = []
    const next = new Map(dirty)
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const ref = cellRef(c, r)
        const key = dirtyKey(activeSheet, ref)
        changedKeys.push(key)
        const existing = next.get(key)
        const cell = getCellData(ref)
        next.set(key, {
          value: existing?.value ?? cell?.value ?? null,
          formula: existing?.formula ?? cell?.formula,
          style: { ...(existing?.style || {}), ...styleUpdate },
        })
      }
    }
    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [sheet, effectiveRange, activeSheet, dirty, getCellData, pushUndo])

  const toggleBold = useCallback(() => {
    const ref = cellRef(selectedCell.col, selectedCell.row)
    const cell = getCellData(ref)
    const currentBold = dirty.get(dirtyKey(activeSheet, ref))?.style?.bold ?? cell?.style?.bold ?? false
    applyFormatting({ bold: !currentBold })
  }, [selectedCell, activeSheet, getCellData, dirty, applyFormatting])

  const toggleItalic = useCallback(() => {
    const ref = cellRef(selectedCell.col, selectedCell.row)
    const cell = getCellData(ref)
    const current = dirty.get(dirtyKey(activeSheet, ref))?.style?.italic ?? cell?.style?.italic ?? false
    applyFormatting({ italic: !current })
  }, [selectedCell, activeSheet, getCellData, dirty, applyFormatting])

  const toggleUnderline = useCallback(() => {
    const ref = cellRef(selectedCell.col, selectedCell.row)
    const cell = getCellData(ref)
    const current = dirty.get(dirtyKey(activeSheet, ref))?.style?.underline ?? cell?.style?.underline ?? false
    applyFormatting({ underline: !current })
  }, [selectedCell, activeSheet, getCellData, dirty, applyFormatting])

  // Search logic
  useEffect(() => {
    if (!searchQuery || !sheet) {
      setSearchMatches([])
      setSearchMatchIndex(0)
      return
    }
    const q = searchQuery.toLowerCase()
    const matches: { row: number; col: number }[] = []
    for (let r = 1; r <= (sheet.maxRow || 0); r++) {
      for (let c = 1; c <= (sheet.maxCol || 0); c++) {
        const ref = cellRef(c, r)
        const cell = getCellData(ref)
        if (cell && cell.value !== null) {
          const display = formatValue(cell.value, cell.numFmt).toLowerCase()
          if (display.includes(q)) {
            matches.push({ row: r, col: c })
          }
        }
      }
    }
    setSearchMatches(matches)
    setSearchMatchIndex(0)
    if (matches.length > 0) {
      setSelectedCell(matches[0])
    }
  }, [searchQuery, sheet, activeSheet, getCellData])

  const navigateSearch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return
    const next = (searchMatchIndex + direction + searchMatches.length) % searchMatches.length
    setSearchMatchIndex(next)
    setSelectedCell(searchMatches[next])
  }, [searchMatches, searchMatchIndex])

  // Fill handle logic — apply fill when drag ends
  const applyFill = useCallback((
    srcRange: { startRow: number; startCol: number; endRow: number; endCol: number },
    targetRow: number, targetCol: number
  ) => {
    if (!sheet) return
    const changedKeys: string[] = []
    const srcRows = srcRange.endRow - srcRange.startRow + 1
    const srcCols = srcRange.endCol - srcRange.startCol + 1

    const next = new Map(dirty)

    // Determine fill direction: down, up, right, or left
    if (targetRow > srcRange.endRow) {
      // Fill down
      for (let r = srcRange.endRow + 1; r <= targetRow; r++) {
        for (let c = srcRange.startCol; c <= srcRange.endCol; c++) {
          const srcRow = srcRange.startRow + ((r - srcRange.endRow - 1) % srcRows)
          const srcRef = cellRef(c, srcRow)
          const srcCell = getCellData(srcRef)
          const ref = cellRef(c, r)
          const key = dirtyKey(activeSheet, ref)
          changedKeys.push(key)

          // Smart fill: detect numeric sequences
          if (srcCell && typeof srcCell.value === 'number' && srcRows === 1) {
            // Single cell — just copy
            next.set(key, { value: srcCell.value, formula: srcCell.formula })
          } else if (srcCell && typeof srcCell.value === 'number' && srcRows >= 2) {
            // Check for arithmetic sequence
            const firstRef = cellRef(c, srcRange.startRow)
            const lastRef = cellRef(c, srcRange.endRow)
            const firstCell = getCellData(firstRef)
            const lastCell = getCellData(lastRef)
            if (firstCell && lastCell && typeof firstCell.value === 'number' && typeof lastCell.value === 'number') {
              const step = (lastCell.value - firstCell.value) / (srcRows - 1)
              next.set(key, { value: lastCell.value + step * (r - srcRange.endRow) })
            } else {
              next.set(key, { value: srcCell?.value ?? null, formula: srcCell?.formula })
            }
          } else {
            next.set(key, { value: srcCell?.value ?? null, formula: srcCell?.formula })
          }
        }
      }
    } else if (targetRow < srcRange.startRow) {
      // Fill up
      for (let r = srcRange.startRow - 1; r >= targetRow; r--) {
        for (let c = srcRange.startCol; c <= srcRange.endCol; c++) {
          const srcRow = srcRange.endRow - ((srcRange.startRow - r - 1) % srcRows)
          const srcRef = cellRef(c, srcRow)
          const srcCell = getCellData(srcRef)
          const ref = cellRef(c, r)
          const key = dirtyKey(activeSheet, ref)
          changedKeys.push(key)
          next.set(key, { value: srcCell?.value ?? null, formula: srcCell?.formula })
        }
      }
    } else if (targetCol > srcRange.endCol) {
      // Fill right
      for (let c = srcRange.endCol + 1; c <= targetCol; c++) {
        for (let r = srcRange.startRow; r <= srcRange.endRow; r++) {
          const srcCol = srcRange.startCol + ((c - srcRange.endCol - 1) % srcCols)
          const srcRef = cellRef(srcCol, r)
          const srcCell = getCellData(srcRef)
          const ref = cellRef(c, r)
          const key = dirtyKey(activeSheet, ref)
          changedKeys.push(key)
          next.set(key, { value: srcCell?.value ?? null, formula: srcCell?.formula })
        }
      }
    } else if (targetCol < srcRange.startCol) {
      // Fill left
      for (let c = srcRange.startCol - 1; c >= targetCol; c--) {
        for (let r = srcRange.startRow; r <= srcRange.endRow; r++) {
          const srcCol = srcRange.endCol - ((srcRange.startCol - c - 1) % srcCols)
          const srcRef = cellRef(srcCol, r)
          const srcCell = getCellData(srcRef)
          const ref = cellRef(c, r)
          const key = dirtyKey(activeSheet, ref)
          changedKeys.push(key)
          next.set(key, { value: srcCell?.value ?? null, formula: srcCell?.formula })
        }
      }
    }

    pushUndo(dirty, changedKeys)
    setDirty(next)
  }, [sheet, activeSheet, getCellData, pushUndo, dirty])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Close context menu on any key
    if (contextMenu) setContextMenu(null)

    // Search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault()
      setSearchOpen(prev => !prev)
      setTimeout(() => searchInputRef.current?.focus(), 50)
      return
    }

    if (e.key === 'Escape' && searchOpen) {
      setSearchOpen(false)
      setSearchQuery('')
      gridRef.current?.focus()
      return
    }

    // Bold
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault()
      toggleBold()
      return
    }

    // Italic
    if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
      e.preventDefault()
      toggleItalic()
      return
    }

    // Underline
    if ((e.metaKey || e.ctrlKey) && e.key === 'u') {
      e.preventDefault()
      toggleUnderline()
      return
    }

    // Save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      saveChanges()
      return
    }

    // Select all
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault()
      if (sheet) {
        setSelectedCell({ row: 1, col: 1 })
        setSelectionEnd({ row: sheet.maxRow, col: sheet.maxCol })
      }
      return
    }

    // Copy/paste
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      e.preventDefault()
      copySelection()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
      e.preventDefault()
      pasteFromClipboard()
      return
    }

    // Undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      performUndo()
      return
    }

    // Redo
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault()
      performRedo()
      return
    }

    if (editingCell) {
      if (e.key === 'Escape') {
        cancelEdit()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        commitEdit()
        setSelectedCell(prev => ({ ...prev, row: Math.min(prev.row + 1, totalRows) }))
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        commitEdit()
        setSelectedCell(prev => ({
          ...prev,
          col: e.shiftKey ? Math.max(prev.col - 1, 1) : Math.min(prev.col + 1, totalCols),
        }))
        return
      }
      return
    }

    // Navigation when not editing
    const move = (dRow: number, dCol: number) => {
      e.preventDefault()
      if (e.shiftKey) {
        // Extend selection
        setSelectionEnd(prev => {
          const base = prev || selectedCell
          return {
            row: Math.max(1, Math.min(base.row + dRow, totalRows)),
            col: Math.max(1, Math.min(base.col + dCol, totalCols)),
          }
        })
      } else {
        setSelectedCell(prev => ({
          row: Math.max(1, Math.min(prev.row + dRow, totalRows)),
          col: Math.max(1, Math.min(prev.col + dCol, totalCols)),
        }))
        setSelectionEnd(null)
      }
    }

    // Ctrl+Arrow: jump to edge of data region
    const jumpMove = (dRow: number, dCol: number) => {
      e.preventDefault()
      if (!sheet) return
      let { row, col } = selectedCell
      if (dRow !== 0) {
        const dir = dRow > 0 ? 1 : -1
        const currentRef = cellRef(col, row)
        const currentHasData = !!getCellData(currentRef)?.value
        for (let r = row + dir; r >= 1 && r <= sheet.maxRow; r += dir) {
          const ref = cellRef(col, r)
          const hasData = !!getCellData(ref)?.value
          if (currentHasData && !hasData) { row = r - dir; break }
          if (!currentHasData && hasData) { row = r; break }
          if (r === 1 || r === sheet.maxRow) { row = r; break }
        }
      }
      if (dCol !== 0) {
        const dir = dCol > 0 ? 1 : -1
        const currentRef = cellRef(col, row)
        const currentHasData = !!getCellData(currentRef)?.value
        for (let c = col + dir; c >= 1 && c <= sheet.maxCol; c += dir) {
          const ref = cellRef(c, row)
          const hasData = !!getCellData(ref)?.value
          if (currentHasData && !hasData) { col = c - dir; break }
          if (!currentHasData && hasData) { col = c; break }
          if (c === 1 || c === sheet.maxCol) { col = c; break }
        }
      }
      setSelectedCell({ row, col })
      setSelectionEnd(null)
    }

    switch (e.key) {
      case 'ArrowUp':
        if (e.metaKey || e.ctrlKey) jumpMove(-1, 0)
        else move(-1, 0)
        break
      case 'ArrowDown':
        if (e.metaKey || e.ctrlKey) jumpMove(1, 0)
        else move(1, 0)
        break
      case 'ArrowLeft':
        if (e.metaKey || e.ctrlKey) jumpMove(0, -1)
        else move(0, -1)
        break
      case 'ArrowRight':
        if (e.metaKey || e.ctrlKey) jumpMove(0, 1)
        else move(0, 1)
        break
      case 'Tab':
        e.preventDefault()
        move(0, e.shiftKey ? -1 : 1)
        break
      case 'Enter':
      case 'F2':
        e.preventDefault()
        startEditing(selectedCell.row, selectedCell.col)
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        deleteSelection()
        break
      case 'Home':
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) {
          setSelectedCell({ row: 1, col: 1 })
        } else {
          setSelectedCell(prev => ({ ...prev, col: 1 }))
        }
        setSelectionEnd(null)
        break
      case 'End':
        e.preventDefault()
        if (sheet && (e.metaKey || e.ctrlKey)) {
          setSelectedCell({ row: sheet.maxRow, col: sheet.maxCol })
        } else if (sheet) {
          setSelectedCell(prev => ({ ...prev, col: sheet.maxCol }))
        }
        setSelectionEnd(null)
        break
      case 'PageDown':
        e.preventDefault()
        { const pageRows = Math.floor(viewportHeight / DEFAULT_ROW_HEIGHT) - 1
          move(pageRows, 0) }
        break
      case 'PageUp':
        e.preventDefault()
        { const pageRows = Math.floor(viewportHeight / DEFAULT_ROW_HEIGHT) - 1
          move(-pageRows, 0) }
        break
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          startEditing(selectedCell.row, selectedCell.col, e.key)
        }
    }
  }, [editingCell, selectedCell, totalRows, totalCols, commitEdit, cancelEdit, startEditing,
      saveChanges, copySelection, pasteFromClipboard, deleteSelection, searchOpen, contextMenu, toggleBold, toggleItalic, toggleUnderline,
      performUndo, performRedo, sheet, getCellData, viewportHeight])

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingCell && !editingInFormulaBar) {
      editInputRef.current?.focus()
    }
  }, [editingCell, editingInFormulaBar])

  useEffect(() => {
    if (editingCell && editingInFormulaBar) {
      formulaInputRef.current?.focus()
    }
  }, [editingCell, editingInFormulaBar])

  // Scroll selected cell into view
  useEffect(() => {
    if (!gridRef.current) return
    const el = gridRef.current
    const { row, col } = selectedCell
    const top = rowPositions[row - 1]
    const bottom = rowPositions[row]
    const left = colPositions[col - 1]
    const right = colPositions[col]

    if (top < el.scrollTop + HEADER_HEIGHT) {
      el.scrollTop = Math.max(0, top - HEADER_HEIGHT)
    } else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight
    }

    if (left < el.scrollLeft + ROW_HEADER_WIDTH) {
      el.scrollLeft = Math.max(0, left - ROW_HEADER_WIDTH)
    } else if (right > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = right - el.clientWidth
    }
  }, [selectedCell, rowPositions, colPositions])

  // Mouse selection
  const isMouseDown = useRef(false)
  const handleMouseDown = useCallback((row: number, col: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (editingCell) commitEdit()
    setContextMenu(null)
    setSelectedCell({ row, col })
    setSelectionEnd(null)
    isMouseDown.current = true
  }, [editingCell, commitEdit])

  const handleMouseEnter = useCallback((row: number, col: number) => {
    if (isMouseDown.current) {
      setSelectionEnd({ row, col })
    }
    if (fillDragRef.current) {
      setFillDrag(prev => prev ? { ...prev, currentRow: row, currentCol: col } : null)
    }
  }, [])

  useEffect(() => {
    const up = () => {
      isMouseDown.current = false
      if (fillDragRef.current) {
        fillDragRef.current = false
        setFillDrag(prev => {
          if (prev) {
            applyFill(
              { startRow: prev.startRow, startCol: prev.startCol, endRow: prev.endRow, endCol: prev.endCol },
              prev.currentRow, prev.currentCol
            )
          }
          return null
        })
      }
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [applyFill])

  // Right-click context menu
  const handleContextMenu = useCallback((row: number, col: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // If right-clicking outside current selection, move selection
    if (!selectionRange || row < selectionRange.startRow || row > selectionRange.endRow ||
        col < selectionRange.startCol || col > selectionRange.endCol) {
      setSelectedCell({ row, col })
      setSelectionEnd(null)
    }
    setContextMenu({ x: e.clientX, y: e.clientY, row, col })
  }, [selectionRange])

  // Close context menu on click elsewhere
  useEffect(() => {
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  // Clean up any in-progress column resize on unmount
  useEffect(() => () => { resizeCleanupRef.current?.() }, [])

  // Column resize
  const handleResizeStart = useCallback((col: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizingCol.current = { col, startX: e.clientX, startWidth: getColWidth(col) }

    const onMove = (ev: MouseEvent) => {
      if (!resizingCol.current) return
      const delta = ev.clientX - resizingCol.current.startX
      const newWidth = Math.max(30, resizingCol.current.startWidth + delta)
      setCustomColWidths(prev => {
        const next = new Map(prev)
        next.set(resizingCol.current!.col, newWidth)
        return next
      })
    }

    const onUp = () => {
      resizingCol.current = null
      resizeCleanupRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    resizeCleanupRef.current = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [getColWidth])

  // Auto-fit on double-click resize handle
  const handleResizeDoubleClick = useCallback((col: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    autoFitColumn(col)
  }, [autoFitColumn])

  // Fill handle start
  const handleFillHandleDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const range = effectiveRange
    fillDragRef.current = true
    setFillDrag({
      startRow: range.startRow,
      startCol: range.startCol,
      endRow: range.endRow,
      endCol: range.endCol,
      currentRow: range.endRow,
      currentCol: range.endCol,
    })
  }, [effectiveRange])

  // Header click handlers
  const handleColHeaderClick = useCallback((col: number, e: React.MouseEvent) => {
    if (!sheet) return
    e.preventDefault()
    setSelectedCell({ row: 1, col })
    setSelectionEnd({ row: sheet.maxRow, col })
  }, [sheet])

  const handleRowHeaderClick = useCallback((row: number, e: React.MouseEvent) => {
    if (!sheet) return
    e.preventDefault()
    setSelectedCell({ row, col: 1 })
    setSelectionEnd({ row, col: sheet.maxCol })
  }, [sheet])

  const handleCornerClick = useCallback(() => {
    if (!sheet) return
    setSelectedCell({ row: 1, col: 1 })
    setSelectionEnd({ row: sheet.maxRow, col: sheet.maxCol })
  }, [sheet])

  // Scroll handler
  const handleScroll = useCallback(() => {
    const el = gridRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    setScrollLeft(el.scrollLeft)
  }, [])

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [])

  // Merged cell lookup
  const mergeInfo = useMemo(() => {
    if (!sheet) return { hidden: new Set<string>(), spans: new Map<string, { colSpan: number; rowSpan: number }>() }
    const hidden = new Set<string>()
    const spans = new Map<string, { colSpan: number; rowSpan: number }>()

    for (const range of sheet.merges) {
      const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
      if (!m) continue
      const startCol = letterToCol(m[1]), startRow = parseInt(m[2])
      const endCol = letterToCol(m[3]), endRow = parseInt(m[4])
      spans.set(cellRef(startCol, startRow), { colSpan: endCol - startCol + 1, rowSpan: endRow - startRow + 1 })
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          if (r === startRow && c === startCol) continue
          hidden.add(cellRef(c, r))
        }
      }
    }

    return { hidden, spans }
  }, [sheet])

  // Search match set
  const searchMatchSet = useMemo(() => {
    if (!searchQuery) return new Set<string>()
    return new Set(searchMatches.map(m => cellRef(m.col, m.row)))
  }, [searchQuery, searchMatches])

  const currentSearchRef = searchMatches.length > 0 ? cellRef(searchMatches[searchMatchIndex]?.col, searchMatches[searchMatchIndex]?.row) : ''

  // Formula bar
  const selectedRef = cellRef(selectedCell.col, selectedCell.row)
  const selectedCellData = getCellData(selectedRef)
  const formulaBarValue = editingCell
    ? editValue
    : selectedCellData?.formula
      ? `=${selectedCellData.formula}`
      : selectedCellData?.value !== null && selectedCellData?.value !== undefined
        ? String(selectedCellData.value)
        : ''

  // Fill drag highlight range
  const fillHighlight = useMemo(() => {
    if (!fillDrag) return null
    const { startRow, startCol, endRow, endCol, currentRow, currentCol } = fillDrag
    // Determine direction — only extend in one axis
    const dRow = currentRow - endRow
    const dCol = currentCol - endCol
    if (Math.abs(dRow) >= Math.abs(dCol)) {
      // Vertical fill
      return {
        startRow: Math.min(startRow, currentRow),
        startCol: startCol,
        endRow: Math.max(endRow, currentRow),
        endCol: endCol,
      }
    } else {
      // Horizontal fill
      return {
        startRow: startRow,
        startCol: Math.min(startCol, currentCol),
        endRow: endRow,
        endCol: Math.max(endCol, currentCol),
      }
    }
  }, [fillDrag])

  // ── Render helpers ──

  const renderCell = useCallback((row: number, col: number) => {
    const ref = cellRef(col, row)
    if (mergeInfo.hidden.has(ref)) return null

    const cell = getCellData(ref)
    const isSelected = selectedCell.row === row && selectedCell.col === col
    const isEditing = editingCell?.row === row && editingCell?.col === col
    const isDirtyCell = dirty.has(dirtyKey(activeSheet, ref))
    const inRange = selectionRange &&
      row >= selectionRange.startRow && row <= selectionRange.endRow &&
      col >= selectionRange.startCol && col <= selectionRange.endCol
    const isSearchMatch = searchMatchSet.has(ref)
    const isCurrentSearch = ref === currentSearchRef
    const inFillRange = fillHighlight &&
      row >= fillHighlight.startRow && row <= fillHighlight.endRow &&
      col >= fillHighlight.startCol && col <= fillHighlight.endCol &&
      !(row >= effectiveRange.startRow && row <= effectiveRange.endRow &&
        col >= effectiveRange.startCol && col <= effectiveRange.endCol)

    const span = mergeInfo.spans.get(ref)
    const style = cell?.style
    const w = span
      ? Array.from({ length: span.colSpan }, (_, k) => getColWidth(col + k)).reduce((a, b) => a + b, 0)
      : getColWidth(col)
    const h = span
      ? Array.from({ length: span.rowSpan }, (_, k) => getRowHeight(row + k)).reduce((a, b) => a + b, 0)
      : getRowHeight(row)

    const cellStyle: React.CSSProperties = {
      position: 'absolute',
      left: colPositions[col - 1] + ROW_HEADER_WIDTH,
      top: rowPositions[row - 1] + HEADER_HEIGHT,
      width: w,
      height: h,
    }

    if (style?.fill) cellStyle.backgroundColor = style.fill
    if (style?.fontColor) cellStyle.color = style.fontColor
    if (style?.bold) cellStyle.fontWeight = 700
    if (style?.italic) cellStyle.fontStyle = 'italic'
    if (style?.fontSize) cellStyle.fontSize = style.fontSize
    if (style?.alignment?.horizontal === 'center') cellStyle.textAlign = 'center'
    else if (style?.alignment?.horizontal === 'right') cellStyle.textAlign = 'right'
    else if (cell?.type === 'number' || (cell?.type === 'formula' && typeof cell?.value === 'number')) {
      cellStyle.textAlign = 'right'
    }
    if (style?.underline) cellStyle.textDecoration = 'underline'
    if (style?.alignment?.wrapText) {
      cellStyle.whiteSpace = 'pre-wrap'
      cellStyle.wordBreak = 'break-word'
    }

    if (style?.border) {
      if (style.border.top) cellStyle.borderTopColor = '#999'
      if (style.border.bottom) cellStyle.borderBottomColor = '#999'
      if (style.border.left) cellStyle.borderLeftColor = '#999'
      if (style.border.right) cellStyle.borderRightColor = '#999'
    }

    let className = 'ss-cell'
    if (isSelected) className += ' ss-selected'
    if (inRange && !isSelected) className += ' ss-in-range'
    if (isDirtyCell) className += ' ss-dirty'
    if (isSearchMatch) className += ' ss-search-match'
    if (isCurrentSearch) className += ' ss-search-current'
    if (inFillRange) className += ' ss-fill-preview'

    return (
      <div
        key={ref}
        data-ref={ref}
        className={className}
        style={cellStyle}
        onMouseDown={(e) => handleMouseDown(row, col, e)}
        onMouseEnter={() => handleMouseEnter(row, col)}
        onDoubleClick={() => startEditing(row, col)}
        onContextMenu={(e) => handleContextMenu(row, col, e)}
      >
        {isEditing && !editingInFormulaBar ? (
          <input
            ref={editInputRef}
            className="ss-edit-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => commitEdit()}
          />
        ) : (
          <span className="ss-cell-text">{getDisplayValue(col, row)}</span>
        )}
      </div>
    )
  }, [selectedCell, editingCell, editValue, dirty, activeSheet, selectionRange, searchMatchSet,
      currentSearchRef, mergeInfo, getCellData, getDisplayValue, getColWidth, getRowHeight,
      colPositions, rowPositions, handleMouseDown, handleMouseEnter, startEditing, commitEdit,
      handleContextMenu, editingInFormulaBar, fillHighlight, effectiveRange])

  // ── Render ──

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <Toolbar upload={upload} onBack={onBack} dirty={dirty.size} isSaving={false} onSave={() => {}} onRefresh={() => {}} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-black/[0.03] border border-black/[0.06] flex items-center justify-center">
              <svg className="w-4 h-4 text-text-3/40 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <span className="text-[10px] text-text-3/60">Loading workbook...</span>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <Toolbar upload={upload} onBack={onBack} dirty={0} isSaving={false} onSave={() => {}} onRefresh={loadWorkbook} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 px-6">
            <div className="w-10 h-10 rounded-xl bg-red-1/8 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-1/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span className="text-[11px] text-text-2 text-center leading-relaxed">{error}</span>
          </div>
        </div>
      </div>
    )
  }

  if (!workbook || !sheet) return null

  const { startRow, endRow, startCol, endCol } = visibleRange

  // Fill handle position — bottom-right of selection
  const fillHandleRow = effectiveRange.endRow
  const fillHandleCol = effectiveRange.endCol
  const fillHandleLeft = colPositions[fillHandleCol] + ROW_HEADER_WIDTH - 4
  const fillHandleTop = rowPositions[fillHandleRow] + HEADER_HEIGHT - 4

  return (
    <div className="flex flex-col h-full bg-white" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Toolbar */}
      <Toolbar
        upload={upload}
        onBack={onBack}
        dirty={dirty.size}
        isSaving={isSaving}
        onSave={saveChanges}
        onRefresh={loadWorkbook}
        saveMessage={saveMessage}
        onSearch={() => { setSearchOpen(p => !p); setTimeout(() => searchInputRef.current?.focus(), 50) }}
        undoCount={undoStack.length}
        redoCount={redoStack.length}
        onUndo={performUndo}
        onRedo={performRedo}
      />

      {/* Formatting Toolbar */}
      <FormattingToolbar
        selectedCellData={selectedCellData}
        dirtyStyle={dirty.get(dirtyKey(activeSheet, selectedRef))?.style}
        onToggleBold={toggleBold}
        onToggleItalic={toggleItalic}
        onToggleUnderline={toggleUnderline}
        onFontColor={(color) => applyFormatting({ fontColor: color })}
        onFillColor={(color) => applyFormatting({ fill: color })}
        onAlignment={(align) => applyFormatting({ alignment: { horizontal: align } })}
        onNumFmt={(fmt) => applyFormatting({ numFmt: fmt })}
      />

      {/* Search Bar */}
      {searchOpen && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[#d4d4d4] bg-[#f0f4f8]">
          <svg className="w-3.5 h-3.5 text-[#666] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            className="flex-1 text-[11px] bg-white border border-[#c0c0c0] rounded px-2 py-1 outline-none focus:border-[#217346] font-['Calibri',sans-serif]"
            placeholder="Find in spreadsheet..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                navigateSearch(e.shiftKey ? -1 : 1)
              }
              if (e.key === 'Escape') {
                setSearchOpen(false)
                setSearchQuery('')
                gridRef.current?.focus()
              }
            }}
          />
          {searchQuery && (
            <span className="text-[10px] text-[#666] shrink-0">
              {searchMatches.length > 0
                ? `${searchMatchIndex + 1} of ${searchMatches.length}`
                : 'No matches'}
            </span>
          )}
          <button onClick={() => navigateSearch(-1)} aria-label="Previous match" className="p-0.5 rounded hover:bg-black/[0.06] text-[#666] cursor-pointer" title="Previous">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button onClick={() => navigateSearch(1)} aria-label="Next match" className="p-0.5 rounded hover:bg-black/[0.06] text-[#666] cursor-pointer" title="Next">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery(''); gridRef.current?.focus() }}
            aria-label="Close search"
            className="p-0.5 rounded hover:bg-black/[0.06] text-[#666] cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Formula Bar */}
      <div className="shrink-0 flex items-center border-b border-[#d4d4d4] bg-[#f8f8f8]">
        <div className="w-[70px] shrink-0 text-center text-[11px] font-semibold text-[#333] border-r border-[#d4d4d4] py-1 bg-[#e8e8e8] select-none">
          {selectedRef}
        </div>
        <div className="flex-1 flex items-center px-1">
          <span className="text-[10px] text-[#666] italic mr-1 select-none">
            {selectedCellData?.formula ? 'fx' : ''}
          </span>
          <input
            ref={formulaInputRef}
            className="flex-1 text-[11px] text-[#1a1a1a] bg-transparent outline-none font-['Calibri',sans-serif] py-1"
            value={editingCell && editingInFormulaBar ? editValue : formulaBarValue}
            onChange={(e) => {
              if (!editingCell) {
                startEditing(selectedCell.row, selectedCell.col, e.target.value)
                setEditingInFormulaBar(true)
              }
              setEditValue(e.target.value)
            }}
            onFocus={() => {
              if (!editingCell) {
                startEditing(selectedCell.row, selectedCell.col)
                setEditingInFormulaBar(true)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitEdit()
                gridRef.current?.focus()
              } else if (e.key === 'Escape') {
                cancelEdit()
                gridRef.current?.focus()
              }
            }}
          />
        </div>
      </div>

      {/* Virtualized Grid */}
      <div
        ref={gridRef}
        className="flex-1 overflow-auto relative"
        tabIndex={-1}
        onScroll={handleScroll}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Total size spacer */}
        <div style={{ width: totalWidth + ROW_HEADER_WIDTH, height: totalHeight + HEADER_HEIGHT, position: 'relative' }}>
          {/* Column headers — pinned to top */}
          <div style={{
            position: 'absolute', top: scrollTop, left: 0, zIndex: 3, height: HEADER_HEIGHT,
            width: totalWidth + ROW_HEADER_WIDTH, background: '#e8e8e8',
          }}>
            {/* Corner cell — select all */}
            <div
              className="ss-corner"
              style={{ position: 'absolute', left: scrollLeft, width: ROW_HEADER_WIDTH, height: HEADER_HEIGHT, zIndex: 4, cursor: 'pointer' }}
              onClick={handleCornerClick}
            />

            {/* Frozen column headers */}
            {frozenCol > 0 && Array.from({ length: frozenCol }, (_, i) => {
              const col = i + 1
              const w = getColWidth(col)
              const isSelected = col === selectedCell.col ||
                (selectionRange && col >= selectionRange.startCol && col <= selectionRange.endCol)
              return (
                <div
                  key={`fch-${col}`}
                  className={`ss-col-header ${isSelected ? 'ss-header-selected' : ''}`}
                  style={{
                    position: 'absolute',
                    left: colPositions[col - 1] + ROW_HEADER_WIDTH + scrollLeft,
                    width: w,
                    height: HEADER_HEIGHT,
                    lineHeight: `${HEADER_HEIGHT}px`,
                    zIndex: 5,
                  }}
                  onClick={(e) => handleColHeaderClick(col, e)}
                >
                  {colToLetter(col)}
                  <div className="ss-resize-handle"
                    onMouseDown={(e) => handleResizeStart(col, e)}
                    onDoubleClick={(e) => handleResizeDoubleClick(col, e)} />
                </div>
              )
            })}

            {/* Visible column headers */}
            {Array.from({ length: endCol - startCol + 1 }, (_, i) => {
              const col = startCol + i
              const w = getColWidth(col)
              const isSelected = col === selectedCell.col ||
                (selectionRange && col >= selectionRange.startCol && col <= selectionRange.endCol)
              return (
                <div
                  key={col}
                  className={`ss-col-header ${isSelected ? 'ss-header-selected' : ''}`}
                  style={{
                    position: 'absolute',
                    left: colPositions[col - 1] + ROW_HEADER_WIDTH,
                    width: w,
                    height: HEADER_HEIGHT,
                    lineHeight: `${HEADER_HEIGHT}px`,
                  }}
                  onClick={(e) => handleColHeaderClick(col, e)}
                >
                  {colToLetter(col)}
                  <div className="ss-resize-handle"
                    onMouseDown={(e) => handleResizeStart(col, e)}
                    onDoubleClick={(e) => handleResizeDoubleClick(col, e)} />
                </div>
              )
            })}
          </div>

          {/* Frozen row headers */}
          {frozenRow > 0 && Array.from({ length: frozenRow }, (_, i) => {
            const row = i + 1
            const h = getRowHeight(row)
            const isRowSelected = row === selectedCell.row ||
              (selectionRange && row >= selectionRange.startRow && row <= selectionRange.endRow)
            return (
              <div
                key={`frh-${row}`}
                className={`ss-row-header ${isRowSelected ? 'ss-header-selected' : ''}`}
                style={{
                  position: 'absolute',
                  top: rowPositions[row - 1] + HEADER_HEIGHT + scrollTop,
                  left: scrollLeft,
                  width: ROW_HEADER_WIDTH,
                  height: h,
                  lineHeight: `${h}px`,
                  zIndex: 4,
                }}
                onClick={(e) => handleRowHeaderClick(row, e)}
              >
                {row}
              </div>
            )
          })}

          {/* Row headers */}
          {Array.from({ length: endRow - startRow + 1 }, (_, i) => {
            const row = startRow + i
            const h = getRowHeight(row)
            const isRowSelected = row === selectedCell.row ||
              (selectionRange && row >= selectionRange.startRow && row <= selectionRange.endRow)
            return (
              <div
                key={`rh-${row}`}
                className={`ss-row-header ${isRowSelected ? 'ss-header-selected' : ''}`}
                style={{
                  position: 'absolute',
                  top: rowPositions[row - 1] + HEADER_HEIGHT,
                  left: scrollLeft,
                  width: ROW_HEADER_WIDTH,
                  height: h,
                  lineHeight: `${h}px`,
                  zIndex: 2,
                }}
                onClick={(e) => handleRowHeaderClick(row, e)}
              >
                {row}
              </div>
            )
          })}

          {/* Frozen cells (top-left quadrant) */}
          {frozenRow > 0 && frozenCol > 0 && Array.from({ length: frozenRow }, (_, ri) => {
            const row = ri + 1
            return Array.from({ length: frozenCol }, (_, ci) => {
              const col = ci + 1
              const ref = cellRef(col, row)
              if (mergeInfo.hidden.has(ref)) return null
              const cell = getCellData(ref)
              const w = getColWidth(col)
              const h = getRowHeight(row)
              const style = cell?.style
              const cellStyle: React.CSSProperties = {
                position: 'absolute',
                left: colPositions[col - 1] + ROW_HEADER_WIDTH + scrollLeft,
                top: rowPositions[row - 1] + HEADER_HEIGHT + scrollTop,
                width: w,
                height: h,
                zIndex: 4,
              }
              if (style?.fill) cellStyle.backgroundColor = style.fill
              else cellStyle.backgroundColor = '#f8f9fa'
              if (style?.fontColor) cellStyle.color = style.fontColor
              if (style?.bold) cellStyle.fontWeight = 700
              if (style?.italic) cellStyle.fontStyle = 'italic'
              if (style?.fontSize) cellStyle.fontSize = style.fontSize
              if (style?.alignment?.horizontal === 'center') cellStyle.textAlign = 'center'
              else if (style?.alignment?.horizontal === 'right') cellStyle.textAlign = 'right'

              const isSelected = selectedCell.row === row && selectedCell.col === col
              let className = 'ss-cell ss-frozen'
              if (isSelected) className += ' ss-selected'

              return (
                <div
                  key={`fc-${ref}`}
                  className={className}
                  style={cellStyle}
                  onMouseDown={(e) => handleMouseDown(row, col, e)}
                  onDoubleClick={() => startEditing(row, col)}
                  onContextMenu={(e) => handleContextMenu(row, col, e)}
                >
                  <span className="ss-cell-text">{getDisplayValue(col, row)}</span>
                </div>
              )
            })
          })}

          {/* Frozen top rows (scrolls horizontally, fixed vertically) */}
          {frozenRow > 0 && Array.from({ length: frozenRow }, (_, ri) => {
            const row = ri + 1
            return Array.from({ length: endCol - startCol + 1 }, (_, ci) => {
              const col = startCol + ci
              if (col <= frozenCol) return null // skip — rendered in frozen corner
              const ref = cellRef(col, row)
              if (mergeInfo.hidden.has(ref)) return null
              const cell = getCellData(ref)
              const w = getColWidth(col)
              const h = getRowHeight(row)
              const style = cell?.style
              const cellStyle: React.CSSProperties = {
                position: 'absolute',
                left: colPositions[col - 1] + ROW_HEADER_WIDTH,
                top: rowPositions[row - 1] + HEADER_HEIGHT + scrollTop,
                width: w,
                height: h,
                zIndex: 3,
              }
              if (style?.fill) cellStyle.backgroundColor = style.fill
              else cellStyle.backgroundColor = '#f8f9fa'
              if (style?.fontColor) cellStyle.color = style.fontColor
              if (style?.bold) cellStyle.fontWeight = 700

              const isSelected = selectedCell.row === row && selectedCell.col === col
              let className = 'ss-cell ss-frozen'
              if (isSelected) className += ' ss-selected'

              return (
                <div
                  key={`fr-${ref}`}
                  className={className}
                  style={cellStyle}
                  onMouseDown={(e) => handleMouseDown(row, col, e)}
                  onDoubleClick={() => startEditing(row, col)}
                  onContextMenu={(e) => handleContextMenu(row, col, e)}
                >
                  <span className="ss-cell-text">{getDisplayValue(col, row)}</span>
                </div>
              )
            })
          })}

          {/* Frozen left columns (scrolls vertically, fixed horizontally) */}
          {frozenCol > 0 && Array.from({ length: endRow - startRow + 1 }, (_, ri) => {
            const row = startRow + ri
            if (row <= frozenRow) return null // skip — rendered in frozen top rows
            return Array.from({ length: frozenCol }, (_, ci) => {
              const col = ci + 1
              const ref = cellRef(col, row)
              if (mergeInfo.hidden.has(ref)) return null
              const cell = getCellData(ref)
              const w = getColWidth(col)
              const h = getRowHeight(row)
              const style = cell?.style
              const cellStyle: React.CSSProperties = {
                position: 'absolute',
                left: colPositions[col - 1] + ROW_HEADER_WIDTH + scrollLeft,
                top: rowPositions[row - 1] + HEADER_HEIGHT,
                width: w,
                height: h,
                zIndex: 3,
              }
              if (style?.fill) cellStyle.backgroundColor = style.fill
              else cellStyle.backgroundColor = '#f8f9fa'
              if (style?.fontColor) cellStyle.color = style.fontColor
              if (style?.bold) cellStyle.fontWeight = 700

              const isSelected = selectedCell.row === row && selectedCell.col === col
              let className = 'ss-cell ss-frozen'
              if (isSelected) className += ' ss-selected'

              return (
                <div
                  key={`fc-${ref}`}
                  className={className}
                  style={cellStyle}
                  onMouseDown={(e) => handleMouseDown(row, col, e)}
                  onDoubleClick={() => startEditing(row, col)}
                  onContextMenu={(e) => handleContextMenu(row, col, e)}
                >
                  <span className="ss-cell-text">{getDisplayValue(col, row)}</span>
                </div>
              )
            })
          })}

          {/* Data cells */}
          {Array.from({ length: endRow - startRow + 1 }, (_, ri) => {
            const row = startRow + ri
            return Array.from({ length: endCol - startCol + 1 }, (_, ci) => {
              const col = startCol + ci
              return renderCell(row, col)
            })
          })}

          {/* Fill handle */}
          {!editingCell && !fillDrag && (
            <div
              className="ss-fill-handle"
              style={{
                position: 'absolute',
                left: fillHandleLeft,
                top: fillHandleTop,
                zIndex: 5,
              }}
              onMouseDown={handleFillHandleDown}
            />
          )}
        </div>
      </div>

      {/* Sheet tabs + Status bar */}
      <div className="shrink-0 flex items-center border-t border-[#b0b0b0] bg-[#e8e8e8]">
        <div className="flex-1 flex overflow-x-auto">
          {workbook.sheets.map((s, i) => (
            <button
              key={s.name}
              onClick={() => { setActiveSheet(i); setSelectedCell({ row: 1, col: 1 }); setEditingCell(null); setSelectionEnd(null); setCustomColWidths(new Map()) }}
              className={`px-3 py-1.5 text-[10px] font-medium cursor-pointer border-r border-[#c0c0c0] whitespace-nowrap transition-colors ${
                i === activeSheet
                  ? 'bg-white text-[#1a1a1a] border-b-2 border-b-[#217346]'
                  : 'text-[#555] hover:bg-[#f0f0f0]'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 px-2 shrink-0">
          {/* Status bar stats */}
          {statusBarStats && (
            <div className="flex items-center gap-2 text-[9px] text-[#444] font-medium">
              {statusBarStats.avg !== null && (
                <span>Avg: {statusBarStats.avg.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              )}
              <span>Count: {statusBarStats.count}</span>
              {statusBarStats.sum !== null && (
                <span>Sum: {statusBarStats.sum.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              )}
              {statusBarStats.min !== null && (
                <span>Min: {statusBarStats.min.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              )}
              {statusBarStats.max !== null && (
                <span>Max: {statusBarStats.max.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              )}
            </div>
          )}
          {dirty.size > 0 && (
            <span className="text-[9px] text-[#666]">
              {dirty.size} unsaved
            </span>
          )}
          <span className="text-[9px] text-[#999]">
            {sheet.maxRow} rows × {sheet.maxCol} cols
          </span>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onCopy={copySelection}
          onPaste={pasteFromClipboard}
          onDelete={deleteSelection}
          onInsertRowAbove={() => insertRow(contextMenu.row - 1)}
          onInsertRowBelow={() => insertRow(contextMenu.row)}
          onInsertColLeft={() => insertColumn(contextMenu.col - 1)}
          onInsertColRight={() => insertColumn(contextMenu.col)}
          onDeleteRow={() => deleteRow(contextMenu.row)}
          onDeleteCol={() => deleteColumn(contextMenu.col)}
          onSortAsc={() => sortColumn(contextMenu.col, true)}
          onSortDesc={() => sortColumn(contextMenu.col, false)}
          onAutoFit={() => autoFitColumn(contextMenu.col)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Styles */}
      <style>{`
        .ss-corner {
          background: #e8e8e8; border: 1px solid #b0b0b0;
          box-sizing: border-box;
        }
        .ss-corner:hover { background: #d0d0d0; }
        .ss-col-header {
          background: #e8e8e8; border: 1px solid #c0c0c0;
          font-size: 10px; font-weight: 500; color: #555;
          text-align: center;
          user-select: none;
          box-sizing: border-box;
          position: relative;
          cursor: pointer;
        }
        .ss-col-header:hover { background: #dcdcdc; }
        .ss-resize-handle {
          position: absolute; right: -2px; top: 0; bottom: 0; width: 5px;
          cursor: col-resize; z-index: 5;
        }
        .ss-resize-handle:hover { background: rgba(33, 115, 70, 0.3); }
        .ss-row-header {
          background: #e8e8e8; border: 1px solid #c0c0c0;
          font-size: 10px; font-weight: 500; color: #555;
          text-align: center;
          user-select: none;
          box-sizing: border-box;
          cursor: pointer;
        }
        .ss-row-header:hover { background: #dcdcdc; }
        .ss-header-selected {
          background: #c0d4e8 !important;
          color: #1a1a1a !important;
          font-weight: 600 !important;
        }
        .ss-cell {
          border: 1px solid #d4d4d4;
          padding: 1px 4px;
          font-size: 11px; line-height: 18px;
          font-family: 'Calibri', -apple-system, sans-serif;
          color: #1a1a1a;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: cell;
          box-sizing: border-box;
          display: flex;
          align-items: center;
        }
        .ss-frozen {
          border-color: #b0b0b0;
        }
        .ss-cell-text {
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        }
        .ss-selected {
          outline: 2px solid #217346;
          outline-offset: -1px;
          z-index: 1;
        }
        .ss-in-range {
          background-color: rgba(33, 115, 70, 0.08) !important;
        }
        .ss-dirty {
          background-image: linear-gradient(135deg, #4a90d9 4px, transparent 4px) !important;
          background-size: 100% 100%;
          background-position: top left;
        }
        .ss-search-match {
          background-color: rgba(255, 235, 59, 0.35) !important;
        }
        .ss-search-current {
          background-color: rgba(255, 152, 0, 0.5) !important;
          outline: 2px solid #e65100;
          outline-offset: -1px;
        }
        .ss-fill-preview {
          background-color: rgba(33, 115, 70, 0.12) !important;
          border: 1px dashed #217346 !important;
        }
        .ss-fill-handle {
          width: 8px;
          height: 8px;
          background: #217346;
          border: 1px solid #fff;
          cursor: crosshair;
          border-radius: 1px;
        }
        .ss-fill-handle:hover {
          background: #1a5c38;
          transform: scale(1.3);
        }
        .ss-edit-input {
          position: absolute;
          inset: 0;
          border: none;
          outline: none;
          background: #fff;
          font-family: 'Calibri', -apple-system, sans-serif;
          font-size: 11px;
          padding: 1px 4px;
          z-index: 2;
          color: #1a1a1a;
        }
      `}</style>
    </div>
  )
}
