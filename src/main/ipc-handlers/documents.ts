import { ipcMain, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { readWorkbook, writeCells } from '../xlsx-handler'
import { getUploadDir } from '../utils/get-upload-dir'

export function registerDocumentsHandlers(): void {
  // Convert PPTX to individual slide images: PPTX → PDF (LibreOffice) → PNGs (macOS CoreGraphics via Python)
  ipcMain.handle('pptx:to-slides', async (_, storedName: string) => {
    const uploadDir = getUploadDir()
    const srcPath = path.join(uploadDir, storedName)
    if (!fs.existsSync(srcPath)) return { error: 'File not found' }

    const slideDir = path.join(uploadDir, storedName.replace(/\.[^.]+$/, '') + '_slides')
    // Check cache
    if (fs.existsSync(slideDir)) {
      const srcMtime = fs.statSync(srcPath).mtimeMs
      const dirMtime = fs.statSync(slideDir).mtimeMs
      if (dirMtime >= srcMtime) {
        const files = fs.readdirSync(slideDir).filter((f: string) => f.endsWith('.png')).sort()
        if (files.length > 0) {
          return { slides: files.map((f: string) => path.join(slideDir, f)), count: files.length }
        }
      }
      fs.rmSync(slideDir, { recursive: true, force: true })
    }

    const soffice = [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/local/bin/soffice',
      '/opt/homebrew/bin/soffice',
    ].find(p => fs.existsSync(p))
    if (!soffice) return { error: 'LibreOffice not found — install via: brew install --cask libreoffice' }

    fs.mkdirSync(slideDir, { recursive: true })

    // Step 1: Convert PPTX → PDF via LibreOffice
    const pdfPath = await new Promise<string | null>(resolve => {
      execFile(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', slideDir, srcPath],
        { timeout: 60000 },
        (err) => {
          if (err) return resolve(null)
          const pdfFiles = fs.readdirSync(slideDir).filter((f: string) => f.endsWith('.pdf'))
          resolve(pdfFiles.length > 0 ? path.join(slideDir, pdfFiles[0]) : null)
        })
    })
    if (!pdfPath) return { error: 'Failed to convert presentation to PDF' }

    // Step 2: Split PDF into individual page PNGs
    // Try pdftoppm (poppler) first, then fall back to PDF viewer
    const pdftoppm = ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'].find(p => fs.existsSync(p))

    if (pdftoppm) {
      // pdftoppm -png -r 200 input.pdf outputPrefix → creates outputPrefix-01.png, etc.
      const prefix = path.join(slideDir, 'slide')
      return new Promise(resolve => {
        execFile(pdftoppm, ['-png', '-r', '200', pdfPath, prefix],
          { timeout: 60000 },
          (err) => {
            if (err) {
              // pdftoppm failed — keep the PDF and use it as fallback
              return resolve({ pdf: pdfPath, count: 1 })
            }

            // Success — clean up the intermediate PDF
            try { fs.unlinkSync(pdfPath) } catch { /* ignore */ }

            const files = fs.readdirSync(slideDir)
              .filter((f: string) => f.endsWith('.png'))
              .sort()
            if (files.length > 0) {
              resolve({ slides: files.map((f: string) => path.join(slideDir, f)), count: files.length })
            } else {
              resolve({ error: 'Slide image generation failed' })
            }
          })
      })
    }

    // No pdftoppm — fall back to PDF viewer
    return { pdf: pdfPath, count: 1 }
  })

  // Extract speaker notes from PPTX
  ipcMain.handle('pptx:get-notes', async (_, storedName: string) => {
    const srcPath = path.join(getUploadDir(), storedName)
    if (!fs.existsSync(srcPath)) return { notes: [] }
    try {
      const JSZip = (await import('jszip')).default
      const data = fs.readFileSync(srcPath)
      const zip = await JSZip.loadAsync(data)

      // First, count slides to know how many notes slots we need
      let slideCount = 0
      zip.forEach((relativePath) => {
        if (/^ppt\/slides\/slide\d+\.xml$/.test(relativePath)) slideCount++
      })

      // Build a map of slide relationships → notes slide files
      // Parse ppt/slides/_rels/slide{N}.xml.rels to find the correct notes slide per slide
      const notes: string[] = new Array(slideCount).fill('')

      for (let slideIdx = 1; slideIdx <= slideCount; slideIdx++) {
        const relsFile = zip.file(`ppt/slides/_rels/slide${slideIdx}.xml.rels`)
        if (!relsFile) continue
        const relsXml = await relsFile.async('text')

        // Find the relationship pointing to a notesSlide
        const noteRelMatch = relsXml.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)
        if (!noteRelMatch) continue

        const noteFile = zip.file(`ppt/notesSlides/${noteRelMatch[1]}`)
        if (!noteFile) continue

        const xml = await noteFile.async('text')
        const texts: string[] = []
        const regex = /<a:t[^>]*>(.*?)<\/a:t>/g
        let match
        while ((match = regex.exec(xml)) !== null) {
          texts.push(match[1])
        }
        const noteText = texts.join('').replace(/^\d+$/, '').trim()
        notes[slideIdx - 1] = noteText
      }

      return { notes }
    } catch {
      return { notes: [] }
    }
  })

  // Get PPTX slide count from XML
  ipcMain.handle('pptx:slide-count', async (_, storedName: string) => {
    const srcPath = path.join(getUploadDir(), storedName)
    if (!fs.existsSync(srcPath)) return { count: 0 }
    try {
      const JSZip = (await import('jszip')).default
      const data = fs.readFileSync(srcPath)
      const zip = await JSZip.loadAsync(data)
      let count = 0
      zip.forEach((relativePath) => {
        if (/^ppt\/slides\/slide\d+\.xml$/.test(relativePath)) count++
      })
      return { count }
    } catch {
      return { count: 0 }
    }
  })

  ipcMain.handle('shell:show-item', (_, storedName: string) => {
    const filepath = path.join(getUploadDir(), storedName)
    if (fs.existsSync(filepath)) shell.showItemInFolder(filepath)
  })

  // Convert DOCX to styled HTML using mammoth (preserves structure, headings, lists, tables, images)
  ipcMain.handle('docx:to-html', async (_, storedName: string) => {
    const srcPath = path.join(getUploadDir(), storedName)
    if (!fs.existsSync(srcPath)) return { error: 'File not found' }
    try {
      const mammoth = await import('mammoth')
      const result = await mammoth.convertToHtml(
        { path: srcPath },
        { convertImage: mammoth.images.imgElement((image) => {
          return image.read('base64').then((data) => ({
            src: `data:${image.contentType};base64,${data}`,
          }))
        })},
      )
      return { html: result.value }
    } catch (e: unknown) {
      return { error: (e instanceof Error ? e.message : String(e)) || 'DOCX conversion failed' }
    }
  })

  // ── XLSX read/write (ExcelJS) ──
  // ── XLSX file watching ──
  const xlsxWatchers = new Map<string, fs.FSWatcher>()
  const xlsxWatchPaused = new Set<string>()

  ipcMain.handle('xlsx:read-workbook', async (_, storedName: string) => {
    try {
      const filePath = path.join(getUploadDir(), storedName)
      const data = await readWorkbook(filePath)
      data.fileName = storedName
      return data
    } catch (e: unknown) {
      return { error: (e instanceof Error ? e.message : String(e)) || 'Failed to read workbook' }
    }
  })

  ipcMain.handle('xlsx:write-cells', async (_, storedName: string, changes: any[]) => {
    try {
      const filePath = path.join(getUploadDir(), storedName)
      // Pause file watcher during our own writes to avoid self-triggered reloads
      xlsxWatchPaused.add(storedName)
      const result = await writeCells(filePath, changes)
      // Clear stale PDF cache if it exists
      if (result.ok) {
        const pdfPath = filePath.replace(/\.[^.]+$/, '.pdf')
        try { fs.unlinkSync(pdfPath) } catch { /* no cache to clear */ }
      }
      // Resume file watcher after a short delay (fs.watch fires slightly after write completes)
      setTimeout(() => xlsxWatchPaused.delete(storedName), 500)
      return result
    } catch (e: unknown) {
      xlsxWatchPaused.delete(storedName)
      return { ok: false, error: (e instanceof Error ? e.message : String(e)) || 'Failed to write cells' }
    }
  })

  ipcMain.handle('xlsx:watch', (event, storedName: string) => {
    if (xlsxWatchers.has(storedName)) return { ok: true }
    const filePath = path.join(getUploadDir(), storedName)
    if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' }

    let debounce: NodeJS.Timeout | null = null
    try {
      const watcher = fs.watch(filePath, () => {
        if (xlsxWatchPaused.has(storedName)) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          // Send event to the renderer that originated the watch
          event.sender.send('xlsx:file-changed', storedName)
        }, 300)
      })
      xlsxWatchers.set(storedName, watcher)
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('xlsx:unwatch', (_, storedName: string) => {
    const watcher = xlsxWatchers.get(storedName)
    if (watcher) {
      watcher.close()
      xlsxWatchers.delete(storedName)
    }
    return { ok: true }
  })

  ipcMain.handle('xlsx:check-mtime', (_, storedName: string) => {
    try {
      const filePath = path.join(getUploadDir(), storedName)
      const stat = fs.statSync(filePath)
      return { mtime: stat.mtimeMs }
    } catch {
      return { mtime: 0 }
    }
  })
}
