import { ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { execSync } from 'child_process'
import { getTasksByProject, setTaskProject } from '../database'

interface ProjectConfig { id: string; name: string; path: string; branch: string; status: string; addedAt: string }

export function registerProjectsHandlers(): void {
  // ═══ Projects ═══
  const projectsConfigPath = path.join(app.getPath('userData'), 'projects.json')

  function loadProjectsConfig(): ProjectConfig[] {
    try {
      if (fs.existsSync(projectsConfigPath)) {
        return JSON.parse(fs.readFileSync(projectsConfigPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return []
  }

  function saveProjectsConfig(projects: ProjectConfig[]): void {
    fs.writeFileSync(projectsConfigPath, JSON.stringify(projects, null, 2))
  }

  ipcMain.handle('projects:list', () => {
    return loadProjectsConfig()
  })

  ipcMain.handle('projects:add', (_, repoPath: string) => {
    const projects = loadProjectsConfig()
    const name = path.basename(repoPath)
    const id = crypto.randomUUID ? crypto.randomUUID() : `proj-${Date.now()}`
    const project = {
      id,
      name,
      path: repoPath,
      branch: '',
      status: '',
      addedAt: new Date().toISOString(),
    }
    projects.push(project)
    saveProjectsConfig(projects)
    return { ok: true, id }
  })

  ipcMain.handle('projects:remove', (_, id: string) => {
    let projects = loadProjectsConfig()
    projects = projects.filter(p => p.id !== id)
    saveProjectsConfig(projects)
    return { ok: true }
  })

  ipcMain.handle('projects:git-status', (_, id: string) => {
    const projects = loadProjectsConfig()
    const project = projects.find(p => p.id === id)
    if (!project) return { branch: 'unknown', status: '' }
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: project.path, timeout: 5000 }).toString().trim()
      const status = execSync('git status --short', { cwd: project.path, timeout: 5000 }).toString().trim()
      return { branch, status }
    } catch (e: unknown) {
      return { branch: 'error', status: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('projects:git-log', (_, id: string) => {
    const projects = loadProjectsConfig()
    const project = projects.find(p => p.id === id)
    if (!project) return { commits: [] }
    try {
      const log = execSync('git log --oneline -10', { cwd: project.path, timeout: 5000 }).toString().trim()
      return { commits: log.split('\n').filter(Boolean) }
    } catch {
      return { commits: [] }
    }
  })

  ipcMain.handle('projects:get-tasks', (_, projectId: string) => {
    return getTasksByProject(projectId)
  })

  ipcMain.handle('projects:set-task-project', (_, taskId: number, projectId: string | null) => {
    setTaskProject(taskId, projectId)
    return { ok: true }
  })
}
