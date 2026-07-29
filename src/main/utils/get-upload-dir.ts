import { app } from 'electron'
import path from 'path'
import fs from 'fs'

export function getUploadDir(): string {
  const dir = path.join(app.getPath('userData'), 'uploads')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}
