import { ipcMain, dialog } from 'electron'
import fs from 'fs'
import * as slack from '../slack'

export function registerSlackHandlers(): void {
  // ── Slack ──
  ipcMain.handle('slack:get-self', () => slack.slackGetSelf())
  ipcMain.handle('slack:get-connection-status', () => slack.slackGetConnectionStatus())
  ipcMain.handle('slack:set-user-token', async (_: any, token: string) => {
    try {
      const status = await slack.slackSetUserToken(token)
      return { ok: true, status }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('slack:disconnect', () => slack.slackDisconnect())
  ipcMain.handle('slack:get-oauth-config', () => slack.slackGetOAuthConfig())
  ipcMain.handle('slack:save-oauth-config', (_: any, clientId: string, clientSecret: string) => {
    try {
      slack.slackSaveOAuthConfig(clientId, clientSecret)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('slack:start-oauth', async () => {
    try {
      const status = await slack.slackStartOAuth()
      return { ok: true, status }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('slack:list-conversations', (_: any, opts?: any) => slack.slackListConversations(opts))
  ipcMain.handle('slack:list-messages', (_: any, channelId: string, opts?: any) => slack.slackListMessages(channelId, opts))
  ipcMain.handle('slack:get-thread', (_: any, channelId: string, threadTs: string, opts?: { silent?: boolean; oldest?: string }) => slack.slackGetThread(channelId, threadTs, opts))
  ipcMain.handle('slack:send-message', (_: any, channelId: string, text: string, opts?: any) => slack.slackSendMessage(channelId, text, opts))
  ipcMain.handle('slack:mark-read', (_: any, channelId: string, timestamp: string) => slack.slackMarkRead(channelId, timestamp))
  ipcMain.handle('slack:search-messages', (_: any, query: string, opts?: any) => slack.slackSearchMessages(query, opts))
  ipcMain.handle('slack:get-thumbnail', async (_: any, url: string) => {
    return slack.slackGetThumbnail(url)
  })
  ipcMain.handle('slack:get-user', (_: any, userId: string) => slack.slackGetUser(userId))
  ipcMain.handle('slack:add-reaction', (_: any, channelId: string, ts: string, emoji: string) => slack.slackAddReaction(channelId, ts, emoji))
  ipcMain.handle('slack:remove-reaction', (_: any, channelId: string, ts: string, emoji: string) => slack.slackRemoveReaction(channelId, ts, emoji))
  ipcMain.handle('slack:download-file', async (_: any, url: string, filename: string) => {
    try {
      const data = await slack.slackDownloadFile(url)
      const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: filename })
      if (canceled || !filePath) return { ok: false, canceled: !!canceled }
      fs.writeFileSync(filePath, data)
      return { ok: true }
    } catch (err) {
      console.error('[slack] Download file error:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
