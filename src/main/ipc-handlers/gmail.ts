import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import * as gmail from '../gmail'

export function registerGmailHandlers(): void {
  // ── Gmail ──
  ipcMain.handle('gmail:get-profile', () => gmail.gmailGetProfile())
  ipcMain.handle('gmail:list-messages', (_: any, opts?: any) => gmail.gmailListMessages(opts))
  ipcMain.handle('gmail:get-thread', (_: any, threadId: string) => gmail.gmailGetThread(threadId))
  ipcMain.handle('gmail:send', (_: any, opts: any) => gmail.gmailSend(opts))
  ipcMain.handle('gmail:reply', (_: any, messageId: string, body: string, headers?: any) => gmail.gmailReply(messageId, body, headers))
  ipcMain.handle('gmail:mark-thread-read', (_: any, threadId: string) => gmail.gmailMarkThreadRead(threadId))
  ipcMain.handle('gmail:archive', (_: any, messageId: string) => gmail.gmailArchive(messageId))
  ipcMain.handle('gmail:trash', (_: any, messageId: string) => gmail.gmailTrash(messageId))
  ipcMain.handle('gmail:archive-thread', (_: any, threadId: string) => gmail.gmailArchiveThread(threadId))
  ipcMain.handle('gmail:trash-thread', (_: any, threadId: string) => gmail.gmailTrashThread(threadId))
  ipcMain.handle('gmail:untrash-thread', (_: any, threadId: string) => gmail.gmailUntrashThread(threadId))
  ipcMain.handle('gmail:move-thread-to-inbox', (_: any, threadId: string) => gmail.gmailMoveThreadToInbox(threadId))
  ipcMain.handle('gmail:star-thread', (_: any, threadId: string, starred: boolean) => gmail.gmailStarThread(threadId, starred))
  ipcMain.handle('gmail:get-labels', () => gmail.gmailGetLabels())
  ipcMain.handle('gmail:download-attachment', async (_: any, messageId: string, attachmentId: string, filename: string) => {
    try {
      const data = await gmail.gmailGetAttachmentData(messageId, attachmentId)
      const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: filename })
      if (canceled || !filePath) return { ok: false, canceled: !!canceled }
      fs.writeFileSync(filePath, data)
      return { ok: true }
    } catch (err) {
      console.error('[gmail] Download attachment error:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('gmail:get-inline-image', async (_: any, messageId: string, attachmentId: string, mimeType: string) => {
    try {
      const data = await gmail.gmailGetAttachmentData(messageId, attachmentId)
      return { ok: true, data: data.toString('base64'), mimeType }
    } catch (err) {
      console.error('[gmail] Inline image error:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
