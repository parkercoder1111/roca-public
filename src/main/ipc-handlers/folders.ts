import { ipcMain } from 'electron'
import {
  getFolders,
  createFolder,
  renameFolder,
  toggleFolderCollapse,
  deleteFolder,
  setTaskFolder,
  updateFolderColor,
  reorderFolders,
  populateTaskFlags,
  FOLDER_COLORS,
} from '../database'

export function registerFoldersHandlers(): void {
  // ── Folders ──
  // Flags (last_activity_at etc.) are populated on nested tasks here so the
  // renderer's age filter works on foldered tasks without a second round-trip.
  ipcMain.handle('db:folders:list', (_, opts?: { week?: string; source?: string; priority?: string }) => {
    const folders = getFolders(opts?.week, opts?.source, opts?.priority)
    for (const f of folders) {
      if (f.tasks && f.tasks.length > 0) populateTaskFlags(f.tasks)
    }
    return folders
  })
  ipcMain.handle('db:folders:create', (_, name: string, color?: string) => {
    return { id: createFolder(name, color) }
  })
  ipcMain.handle('db:folders:rename', (_, folderId: number, name: string) => {
    renameFolder(folderId, name)
    return { ok: true }
  })
  ipcMain.handle('db:folders:toggle-collapse', (_, folderId: number) => {
    toggleFolderCollapse(folderId)
    return { ok: true }
  })
  ipcMain.handle('db:folders:delete', (_, folderId: number) => {
    deleteFolder(folderId)
    return { ok: true }
  })
  ipcMain.handle('db:folders:set-task-folder', (_, taskId: number, folderId?: number | null) => {
    setTaskFolder(taskId, folderId)
    return { ok: true }
  })
  ipcMain.handle('db:folders:update-color', (_, folderId: number, color: string) => {
    updateFolderColor(folderId, color)
    return { ok: true }
  })
  ipcMain.handle('db:folders:reorder', (_, folderIds: number[]) => {
    reorderFolders(folderIds)
    return { ok: true }
  })
  ipcMain.handle('db:folders:colors', () => FOLDER_COLORS)
}
