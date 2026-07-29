import { ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { getSkillsDir } from '../utils/read-roca-file'

export function registerSkillsHandlers(): void {
  // ═══ Skills ═══
  // ROCA skill files — configurable via ROCA_SKILLS_DIR env var
  const rocaSkillsDir = getSkillsDir()

  ipcMain.handle('skills:list', () => {
    const skills: { name: string; path: string; dir: string; content: string }[] = []
    if (!fs.existsSync(rocaSkillsDir)) return skills
    for (const entry of fs.readdirSync(rocaSkillsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const fullPath = path.join(rocaSkillsDir, entry.name)
        const content = fs.readFileSync(fullPath, 'utf-8')
        const name = entry.name.replace('.md', '')
        skills.push({ name, path: fullPath, dir: 'skills', content })
      }
    }
    return skills
  })

  ipcMain.handle('skills:get', (_, skillPath: string) => {
    try {
      if (fs.existsSync(skillPath)) {
        return fs.readFileSync(skillPath, 'utf-8')
      }
    } catch { /* ignore */ }
    return ''
  })

  ipcMain.handle('skills:save', (_, skillPath: string, content: string) => {
    const dir = path.dirname(skillPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(skillPath, content)
    return { ok: true }
  })
}
