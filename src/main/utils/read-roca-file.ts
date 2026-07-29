import { app } from 'electron'
import path from 'path'
import fs from 'fs'

export function getRocaDir(): string {
  // Allow external intelligence directory (e.g., a shared project repo)
  // so prompt files, journal, and skills live outside the app bundle.
  // Falls back to the bundled roca/ directory for standalone/GitHub use.
  const custom = process.env.ROCA_INTELLIGENCE_DIR
  if (custom && fs.existsSync(custom)) return custom
  return app.isPackaged
    ? path.join(process.resourcesPath, 'roca')
    : path.join(__dirname, '../../../roca')
}

export function getSkillsDir(): string {
  // Allow skills to live in a shared directory (e.g., alongside other project skills)
  // so all skill files are in one place. Falls back to {rocaDir}/skills/.
  const custom = process.env.ROCA_SKILLS_DIR
  if (custom && fs.existsSync(custom)) return custom
  return path.join(getRocaDir(), 'skills')
}

/** Read a file from the roca/ directory, returning empty string if missing. */
export function readRocaFile(filename: string): string {
  try {
    const p = path.join(getRocaDir(), filename)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
  } catch { return '' }
}
