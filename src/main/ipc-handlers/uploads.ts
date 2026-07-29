import { ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import {
  saveUpload,
  getUploadsForTask,
  getUploadsForMessage,
  getPendingUploads,
  linkUploadsToMessage,
  deleteUpload,
  getTaskById,
} from '../database'
import { ALLOWED_EXTENSIONS, MAX_UPLOAD_SIZE } from '../../shared/constants'
import { getUploadDir } from '../utils/get-upload-dir'
import { randomHex } from '../utils/random-hex'
import { buildTaskContext } from '../helpers/build-task-context'

export function registerUploadsHandlers(): void {
  // ── Uploads ──
  ipcMain.handle('db:uploads:save', (
    _, taskId: number, fileData: { buffer: Uint8Array | Buffer; filename: string; mimeType: string }
  ) => {
    const ext = path.extname(fileData.filename).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { ok: false, error: `File type ${ext} not allowed` }
    }
    // Ensure we have a proper Buffer for fs operations
    const buf = Buffer.isBuffer(fileData.buffer) ? fileData.buffer : Buffer.from(fileData.buffer)
    if (buf.length > MAX_UPLOAD_SIZE) {
      return { ok: false, error: 'File too large (max 10 MB)' }
    }

    const storedName = `${randomHex(32)}${ext}`
    const uploadDir = getUploadDir()
    fs.writeFileSync(path.join(uploadDir, storedName), buf)

    const uploadId = saveUpload(
      taskId, fileData.filename, storedName,
      fileData.mimeType, buf.length
    )
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)

    // Regenerate task context file so Claude session has absolute paths to new uploads
    try {
      const task = getTaskById(taskId)
      if (task) {
        const contextDir = path.join(app.getPath('userData'), 'task-contexts')
        const contextPath = path.join(contextDir, `task-${taskId}.md`)
        if (fs.existsSync(contextPath)) {
          const md = buildTaskContext(task, taskId)
          fs.writeFileSync(contextPath, md)
          console.log(`[uploads] Regenerated context for task ${taskId} with ${getUploadsForTask(taskId).length} uploads`)
        }
      }
    } catch (e) {
      console.error('[uploads] Failed to regenerate context after upload:', e)
    }

    return {
      ok: true,
      upload_id: uploadId,
      filename: fileData.filename,
      stored_name: storedName,
      url: `/uploads/${storedName}`,
      is_image: isImage,
      size: buf.length,
    }
  })
  ipcMain.handle('db:uploads:for-task', (_, taskId: number) => getUploadsForTask(taskId))
  ipcMain.handle('db:uploads:for-message', (_, messageId: number) => getUploadsForMessage(messageId))
  ipcMain.handle('db:uploads:pending', (_, taskId: number) => getPendingUploads(taskId))
  ipcMain.handle('db:uploads:link-to-message', (_, taskId: number, messageId: number) => {
    linkUploadsToMessage(taskId, messageId)
    return { ok: true }
  })
  ipcMain.handle('db:uploads:serve', (_, filename: string) => {
    const filepath = path.join(getUploadDir(), filename)
    if (!fs.existsSync(filepath)) return null
    return fs.readFileSync(filepath)
  })
  ipcMain.handle('db:uploads:delete', (_, uploadId: number) => {
    const result = deleteUpload(uploadId)
    if (!result) return { ok: false, error: 'Upload not found' }
    const filepath = path.join(getUploadDir(), result.stored_name)
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
    // Regenerate task context file so Claude session reflects removed upload
    try {
      const task = getTaskById(result.task_id)
      if (task) {
        const contextDir = path.join(app.getPath('userData'), 'task-contexts')
        const contextPath = path.join(contextDir, `task-${result.task_id}.md`)
        if (fs.existsSync(contextPath)) {
          const md = buildTaskContext(task, result.task_id)
          fs.writeFileSync(contextPath, md)
        }
      }
    } catch (e) {
      console.error('[uploads] Failed to regenerate context after delete:', e)
    }
    return { ok: true }
  })
  ipcMain.handle('db:uploads:serve-path', (_, storedName: string) => {
    const filepath = path.join(getUploadDir(), storedName)
    if (!fs.existsSync(filepath)) return null
    return { path: filepath }
  })
  ipcMain.handle('db:uploads:convert-pdf', async (_, storedName: string) => {
    const uploadDir = getUploadDir()
    const srcPath = path.join(uploadDir, storedName)
    if (!fs.existsSync(srcPath)) return null
    const pdfBase = storedName.replace(/\.[^.]+$/, '')
    const pdfPath = path.join(uploadDir, pdfBase + '.pdf')
    // Return cached conversion if exists AND source hasn't been updated
    if (fs.existsSync(pdfPath)) {
      const srcMtime = fs.statSync(srcPath).mtimeMs
      const pdfMtime = fs.statSync(pdfPath).mtimeMs
      if (pdfMtime >= srcMtime) return { path: pdfPath }
      // Source is newer — delete stale cache and reconvert
      fs.unlinkSync(pdfPath)
    }
    // Find soffice binary
    const soffice = [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/local/bin/soffice',
      '/opt/homebrew/bin/soffice',
    ].find(p => fs.existsSync(p))
    if (!soffice) return { error: 'LibreOffice not found — install via: brew install --cask libreoffice' }
    return new Promise(resolve => {
      execFile(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', uploadDir, srcPath],
        { timeout: 30000 },
        (err) => {
          if (err) return resolve({ error: err.message || 'LibreOffice conversion failed' })
          if (fs.existsSync(pdfPath)) return resolve({ path: pdfPath })
          resolve({ error: 'Conversion completed but PDF not found' })
        })
    })
  })
}
