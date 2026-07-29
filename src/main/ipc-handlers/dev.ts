import { ipcMain, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'

export function registerDevHandlers(): void {
  // ── Dev Apps ──
  const DEV_APPS_DIR = path.join(os.homedir(), 'roca-apps')

  ipcMain.handle('dev:get-apps-dir', () => DEV_APPS_DIR)

  ipcMain.handle('dev:list-apps', () => {
    if (!fs.existsSync(DEV_APPS_DIR)) return []
    try {
      const entries = fs.readdirSync(DEV_APPS_DIR, { withFileTypes: true })
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => {
          const appPath = path.join(DEV_APPS_DIR, e.name)
          const stat = fs.statSync(appPath)
          // Check for index.html to determine if it's a web app
          const hasIndex = fs.existsSync(path.join(appPath, 'index.html'))
          // Read package.json for description if available
          let description = ''
          const pkgPath = path.join(appPath, 'package.json')
          if (fs.existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
              description = pkg.description || ''
            } catch {}
          }
          // Count files
          let fileCount = 0
          try {
            fileCount = fs.readdirSync(appPath).filter(f => !f.startsWith('.')).length
          } catch {}
          return {
            name: e.name,
            path: appPath,
            hasIndex,
            description,
            fileCount,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
          }
        })
        .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
    } catch {
      return []
    }
  })

  ipcMain.handle('dev:create-app', (_: any, name: string, description?: string) => {
    const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (!safeName) return { ok: false, error: 'Invalid app name' }
    const appPath = path.join(DEV_APPS_DIR, safeName)
    if (fs.existsSync(appPath)) return { ok: false, error: 'App already exists' }
    try {
      fs.mkdirSync(appPath, { recursive: true })
      // Scaffold basic files
      const desc = description || name
      fs.writeFileSync(path.join(appPath, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <h1>${name}</h1>
    <p>Edit this app to get started.</p>
  </div>
  <script src="app.js"></script>
</body>
</html>
`)
      fs.writeFileSync(path.join(appPath, 'style.css'), `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; background: #fafafa; }
#app { max-width: 800px; margin: 0 auto; padding: 2rem; }
h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
`)
      fs.writeFileSync(path.join(appPath, 'app.js'), `// ${name} — app logic\nconsole.log('${name} loaded')\n`)
      fs.writeFileSync(path.join(appPath, 'CLAUDE.md'), `# ${name}\n\n${desc}\n\nThis is a standalone web app. The entry point is index.html.\nKeep it simple — vanilla HTML/CSS/JS unless the user asks for a framework.\n`)
      return { ok: true, name: safeName, path: appPath }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('dev:delete-app', (_: any, appName: string) => {
    const appPath = path.join(DEV_APPS_DIR, appName)
    if (!appPath.startsWith(DEV_APPS_DIR) || !fs.existsSync(appPath)) {
      return { ok: false, error: 'App not found' }
    }
    try {
      fs.rmSync(appPath, { recursive: true, force: true })
      return { ok: true }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('dev:open-in-finder', (_: any, appName: string) => {
    const appPath = path.join(DEV_APPS_DIR, appName)
    if (fs.existsSync(appPath)) {
      shell.openPath(appPath)
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('dev:open-in-browser', (_: any, appName: string) => {
    const appPath = path.join(DEV_APPS_DIR, appName, 'index.html')
    if (fs.existsSync(appPath)) {
      shell.openExternal(`file://${appPath}`)
      return { ok: true }
    }
    return { ok: false }
  })
}
