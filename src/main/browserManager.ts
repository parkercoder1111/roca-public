import { WebContents, webContents } from 'electron'
import { spawn, execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserMode, BrowserSessionStatus } from '../shared/types'

interface BrowserSession {
  taskId: number
  mode: BrowserMode
  url: string
  owner: WebContents
  webContentsId: number | null
  isClaudeActive: boolean
  claudeStatus: string | null
  abortController: AbortController | null
}

const SCREENSHOT_DELAY_MS = 1500

// Find claude CLI binary — Electron's PATH may not include all locations
let _claudePath: string | null = null
let _claudePathResolved = false
function getClaudePath(): string | null {
  if (_claudePathResolved) return _claudePath
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    // Check nvm-installed claude — find newest node version dynamically
    ...(() => {
      try {
        const nvmDir = join(process.env.HOME || '', '.nvm/versions/node')
        const { readdirSync, existsSync } = require('fs')
        if (existsSync(nvmDir)) {
          return readdirSync(nvmDir).sort().reverse().map((v: string) => join(nvmDir, v, 'bin', 'claude'))
        }
      } catch {}
      return []
    })(),
  ]
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { stdio: 'ignore' })
      _claudePath = p
      _claudePathResolved = true
      console.log(`[BrowserManager] Found claude at: ${p}`)
      return _claudePath
    } catch {}
  }
  // Fallback: try PATH
  try {
    const found = execSync('which claude', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (found) {
      _claudePath = found
      _claudePathResolved = true
      console.log(`[BrowserManager] Found claude via PATH: ${found}`)
      return _claudePath
    }
  } catch {}
  _claudePathResolved = true
  console.log('[BrowserManager] claude CLI not found')
  return null
}

const BROWSER_ACTION_SYSTEM = `You are controlling a web browser. You can see a screenshot of the current page. Respond with actions to take. Available actions:
- {"action": "navigate", "url": "<string>"} — navigate to a URL directly (use this to go to websites)
- {"action": "click", "x": <number>, "y": <number>} — click at coordinates
- {"action": "type", "text": "<string>"} — type text into the focused input
- {"action": "key", "key": "<string>"} — press a key (Enter, Tab, Escape, Backspace, etc.)
- {"action": "scroll", "x": <number>, "y": <number>, "deltaY": <number>} — scroll (negative = down, positive = up)
- {"action": "done", "summary": "<string>"} — task is complete

IMPORTANT: If the task involves going to a specific website, use the "navigate" action immediately — do NOT try to click the URL bar.
Respond with a brief description of what you see and what you'll do, then a JSON action block on its own line starting with \`\`\`json.
IMPORTANT: Your ONLY tool use should be reading the screenshot image file. Do not create files, run commands, or use any other tools.`

export class BrowserManager {
  private sessions = new Map<number, BrowserSession>()

  create(taskId: number, mode: BrowserMode, owner: WebContents): BrowserSessionStatus {
    // Return existing session if already created (idempotent)
    if (this.sessions.has(taskId)) {
      return this.getStatus(taskId)!
    }

    const session: BrowserSession = {
      taskId,
      mode,
      url: 'about:blank',
      owner,
      webContentsId: null,
      isClaudeActive: false,
      claudeStatus: null,
      abortController: null,
    }
    this.sessions.set(taskId, session)
    console.log(`[BrowserManager] Created ${mode} session for task ${taskId}`)

    return this.getStatus(taskId)!
  }

  destroy(taskId: number): void {
    const session = this.sessions.get(taskId)
    if (session) {
      if (session.abortController) session.abortController.abort()
      // Detach debugger if attached
      const wc = this.getWebviewContents(taskId)
      if (wc) {
        try { wc.debugger.detach() } catch { /* not attached */ }
      }
      this.sessions.delete(taskId)
      console.log(`[BrowserManager] Destroyed session for task ${taskId}`)
    }
  }

  has(taskId: number): boolean {
    return this.sessions.has(taskId)
  }

  getStatus(taskId: number): BrowserSessionStatus | null {
    const s = this.sessions.get(taskId)
    if (!s) return null
    return {
      taskId: s.taskId,
      mode: s.mode,
      url: s.url,
      isClaudeActive: s.isClaudeActive,
      claudeStatus: s.claudeStatus,
    }
  }

  updateUrl(taskId: number, url: string): void {
    const s = this.sessions.get(taskId)
    if (s) s.url = url
  }

  registerWebContents(taskId: number, wcId: number): void {
    const s = this.sessions.get(taskId)
    if (s) {
      s.webContentsId = wcId
      console.log(`[BrowserManager] Registered webContents ${wcId} for task ${taskId}`)
    }
  }

  getSession(taskId: number): BrowserSession | undefined {
    return this.sessions.get(taskId)
  }

  /** Get the webview's WebContents from the main process */
  private getWebviewContents(taskId: number): WebContents | null {
    const session = this.sessions.get(taskId)
    if (!session?.webContentsId) return null
    const wc = webContents.fromId(session.webContentsId)
    return wc && !wc.isDestroyed() ? wc : null
  }

  /** Attach CDP debugger to the webview (idempotent) */
  private attachDebugger(wc: WebContents): boolean {
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
      }
      return true
    } catch (err) {
      console.error('[BrowserManager] Failed to attach debugger:', err)
      return false
    }
  }

  /** Capture viewport screenshot via CDP — returns base64 PNG */
  private async captureScreenshot(taskId: number): Promise<string> {
    const wc = this.getWebviewContents(taskId)
    if (!wc) {
      console.error(`[BrowserManager] No webContents for task ${taskId}`)
      return ''
    }

    if (!this.attachDebugger(wc)) {
      // Fallback to Electron's capturePage
      try {
        const image = await wc.capturePage()
        return image.toDataURL().replace(/^data:image\/png;base64,/, '')
      } catch {
        return ''
      }
    }

    try {
      const result = await wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        quality: 90,
        // Viewport only — what the user actually sees (matches coordinate space)
      })
      return result.data
    } catch (err) {
      console.error(`[BrowserManager] CDP screenshot failed for task ${taskId}:`, err)
      // Fallback
      try {
        const image = await wc.capturePage()
        return image.toDataURL().replace(/^data:image\/png;base64,/, '')
      } catch {
        return ''
      }
    }
  }

  /** Execute browser action via CDP — more precise than sendInputEvent */
  private async executeAction(taskId: number, action: any): Promise<void> {
    const wc = this.getWebviewContents(taskId)
    if (!wc) return

    const useCdp = this.attachDebugger(wc)

    try {
      if (action.action === 'navigate') {
        let url = action.url
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url
        }
        wc.loadURL(url)
        // Wait for page to load
        await new Promise(r => setTimeout(r, 3000))
        return
      }
      if (action.action === 'click') {
        if (useCdp) {
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1,
          })
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1,
          })
        } else {
          wc.sendInputEvent({ type: 'mouseDown', x: action.x, y: action.y, button: 'left', clickCount: 1 })
          wc.sendInputEvent({ type: 'mouseUp', x: action.x, y: action.y, button: 'left', clickCount: 1 })
        }
      } else if (action.action === 'type') {
        if (useCdp) {
          // insertText handles full strings at once — more reliable than char-by-char
          await wc.debugger.sendCommand('Input.insertText', { text: action.text })
        } else {
          for (const char of action.text) {
            wc.sendInputEvent({ type: 'keyDown', keyCode: char })
            wc.sendInputEvent({ type: 'char', keyCode: char })
            wc.sendInputEvent({ type: 'keyUp', keyCode: char })
          }
        }
      } else if (action.action === 'key') {
        const keyMap: Record<string, { key: string; code: string; keyCode?: number }> = {
          'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
          'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
          'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
          'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
          'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
          'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
          'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
          'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
          'Space': { key: ' ', code: 'Space', keyCode: 32 },
        }
        const mapped = keyMap[action.key] || { key: action.key, code: action.key }

        if (useCdp) {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown', key: mapped.key, code: mapped.code,
            windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: mapped.key, code: mapped.code,
            windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
          })
        } else {
          wc.sendInputEvent({ type: 'keyDown', keyCode: action.key })
          wc.sendInputEvent({ type: 'keyUp', keyCode: action.key })
        }
      } else if (action.action === 'scroll') {
        if (useCdp) {
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: action.x || 0,
            y: action.y || 0,
            deltaX: 0,
            deltaY: action.deltaY || -100,
          })
        } else {
          wc.sendInputEvent({
            type: 'mouseWheel',
            x: action.x || 0,
            y: action.y || 0,
            deltaX: 0,
            deltaY: action.deltaY || -100,
          })
        }
      }
    } catch (err) {
      console.error(`[BrowserManager] Action execution failed for task ${taskId}:`, err)
    }
  }

  /** Navigate the webview from main process */
  navigate(taskId: number, action: 'back' | 'forward' | 'refresh' | 'load', url?: string): boolean {
    const wc = this.getWebviewContents(taskId)
    if (!wc) return false

    try {
      switch (action) {
        case 'back': wc.goBack(); break
        case 'forward': wc.goForward(); break
        case 'refresh': wc.reload(); break
        case 'load':
          if (url) {
            let target = url
            if (!target.startsWith('http://') && !target.startsWith('https://')) {
              target = 'https://' + target
            }
            wc.loadURL(target)
          }
          break
      }
      return true
    } catch (err) {
      console.error(`[BrowserManager] Navigate failed for task ${taskId}:`, err)
      return false
    }
  }

  /** Run claude CLI in print mode and return the text response */
  private runClaudeCli(prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const claudeBin = getClaudePath()
      if (!claudeBin) {
        reject(new Error('claude CLI not found — install Claude Code'))
        return
      }

      if (signal.aborted) {
        reject(new Error('Aborted'))
        return
      }

      // Inherit user's full PATH so node/claude resolve correctly from Electron
      const userPath = process.env.PATH || ''
      const extraPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        // Add nvm node bin to PATH dynamically
        ...(() => {
          try {
            const nvmDir = join(process.env.HOME || '', '.nvm/versions/node')
            const { readdirSync, existsSync } = require('fs')
            if (existsSync(nvmDir)) {
              return readdirSync(nvmDir).sort().reverse().map((v: string) => join(nvmDir, v, 'bin'))
            }
          } catch {}
          return []
        })(),
        join(process.env.HOME || '', '.local/bin'),
      ]
      const fullPath = [...extraPaths, ...userPath.split(':')].filter(Boolean).join(':')

      const proc = spawn(claudeBin, [
        '-p',
        '--output-format', 'text',
        '--max-turns', '3',
        '--model', 'sonnet',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: fullPath },
      })

      const onAbort = () => { proc.kill('SIGTERM') }
      signal.addEventListener('abort', onAbort, { once: true })

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      proc.on('error', (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      })

      proc.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          reject(new Error('Aborted'))
        } else if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`))
        }
      })

      proc.stdin.write(prompt)
      proc.stdin.end()
    })
  }

  /** Check if a Claude extension is loaded in the session */
  hasClaudeExtension(): boolean {
    try {
      const { session } = require('electron')
      const exts = session.defaultSession.getAllExtensions()
      return exts.some((e: any) => e.name.toLowerCase().includes('claude'))
    } catch {
      return false
    }
  }

  async startClaudeLoop(taskId: number, instruction: string): Promise<void> {
    // Wait for session to be created (TaskBrowser may still be mounting)
    let session = this.sessions.get(taskId)
    if (!session) {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250))
        session = this.sessions.get(taskId)
        if (session) break
      }
      if (!session) throw new Error(`No session for task ${taskId} after 5s`)
    }

    // Skip CLI automation if Claude extension is loaded — extension handles it
    if (this.hasClaudeExtension()) {
      session.claudeStatus = 'Claude extension active — use extension directly'
      session.isClaudeActive = false
      this.emitStatus(taskId)
      return
    }

    const controller = new AbortController()
    session.abortController = controller
    session.isClaudeActive = true

    // Invalidate stale webContentsId from a previous browser panel open
    if (session.webContentsId) {
      const wc = webContents.fromId(session.webContentsId)
      if (!wc || wc.isDestroyed()) {
        console.log(`[BrowserManager] Stale webContentsId ${session.webContentsId} for task ${taskId} — clearing`)
        session.webContentsId = null
      }
    }

    // Wait for webview to register (race between panel mount and instruction send)
    if (!session.webContentsId) {
      session.claudeStatus = 'Waiting for browser to load...'
      this.emitStatus(taskId)
      this.emitThought(taskId, '[system] Waiting for browser webview to be ready...')
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500))
        if (controller.signal.aborted) return
        if (session.webContentsId) break
      }
      if (!session.webContentsId) {
        session.claudeStatus = 'Error: Browser not ready — timed out after 15s'
        session.isClaudeActive = false
        this.emitStatus(taskId)
        return
      }
    }

    if (!getClaudePath()) {
      session.claudeStatus = 'Error: claude CLI not found — install Claude Code'
      session.isClaudeActive = false
      this.emitStatus(taskId)
      return
    }
    session.claudeStatus = 'Waiting for page to load...'
    this.emitStatus(taskId)
    this.emitThought(taskId, `User: ${instruction}`)

    // Give the page time to render before first screenshot
    await new Promise(r => setTimeout(r, 2000))
    if (controller.signal.aborted) return

    session.claudeStatus = 'Capturing screenshot...'
    this.emitStatus(taskId)

    const screenshotPath = join(tmpdir(), `roca-browser-${taskId}.png`)

    try {
      let screenshot = await this.captureScreenshot(taskId)
      if (!screenshot) {
        session.claudeStatus = 'Error: Failed to capture screenshot'
        session.isClaudeActive = false
        this.emitStatus(taskId)
        this.emitThought(taskId, '[error] Failed to capture screenshot')
        return
      }

      writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'))
      this.emitThought(taskId, '[system] Screenshot captured, sending to Claude...')
      session.claudeStatus = 'Thinking...'
      this.emitStatus(taskId)

      const MAX_STEPS = 15
      let step = 1
      while (!controller.signal.aborted && step <= MAX_STEPS) {
        const prompt = step === 1
          ? `${BROWSER_ACTION_SYSTEM}\n\nTask: ${instruction}\n\nThe current browser screenshot is saved at ${screenshotPath}. Read that image file to see the page, then respond with your analysis and action.`
          : `${BROWSER_ACTION_SYSTEM}\n\nOriginal task: ${instruction}\n\nThe previous action was executed. The updated browser screenshot is at ${screenshotPath}. Read that image file to see the current page state and continue with the task.`

        const responseText = await this.runClaudeCli(prompt, controller.signal)

        if (controller.signal.aborted) break

        // Emit full reasoning to thought stream
        const reasoning = responseText.replace(/```json[\s\S]*?```/g, '').trim()
        if (reasoning) {
          this.emitThought(taskId, `[step ${step}] ${reasoning}`)
        }

        const statusLine = responseText.split('\n')[0].slice(0, 100)
        session.claudeStatus = statusLine
        this.emitStatus(taskId)

        // Try multiple patterns to extract JSON action
        const jsonMatch = responseText.match(/```json\s*\n?([\s\S]*?)\n?```/)
          || responseText.match(/```\s*\n?([\s\S]*?)\n?```/)
          || responseText.match(/(\{"action"\s*:\s*"[^"]+?"[\s\S]*?\})/)
        if (!jsonMatch) {
          this.emitThought(taskId, '[error] Could not parse action — retrying...')
          // Retry once with a clearer prompt
          if (step > 1) {
            session.claudeStatus = 'Could not parse action — stopping'
            session.isClaudeActive = false
            this.emitStatus(taskId)
            break
          }
          continue
        }

        let action: any
        try {
          action = JSON.parse(jsonMatch[1])
        } catch {
          // Try to find any JSON object in the match
          const fallbackJson = jsonMatch[1].match(/\{[\s\S]*\}/)
          if (fallbackJson) {
            try {
              action = JSON.parse(fallbackJson[0])
            } catch {
              this.emitThought(taskId, `[error] Invalid JSON: ${jsonMatch[1].slice(0, 200)}`)
              continue
            }
          } else {
            this.emitThought(taskId, `[error] Invalid JSON: ${jsonMatch[1].slice(0, 200)}`)
            continue
          }
        }

        this.emitThought(taskId, `[action] ${JSON.stringify(action)}`)

        if (action.action === 'done') {
          session.claudeStatus = `Done: ${action.summary || 'Task complete'}`
          session.isClaudeActive = false
          this.emitStatus(taskId)
          this.emitThought(taskId, `[done] ${action.summary || 'Task complete'}`)
          break
        }

        session.claudeStatus = `Executing: ${action.action}...`
        this.emitStatus(taskId)

        await this.executeAction(taskId, action)
        await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS))
        if (controller.signal.aborted) break

        session.claudeStatus = 'Capturing screenshot...'
        this.emitStatus(taskId)
        this.emitThought(taskId, '[system] Capturing updated screenshot...')

        screenshot = await this.captureScreenshot(taskId)
        if (!screenshot) {
          session.claudeStatus = 'Error: Failed to capture screenshot'
          session.isClaudeActive = false
          this.emitStatus(taskId)
          this.emitThought(taskId, '[error] Failed to capture screenshot')
          break
        }

        writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'))
        step++

        session.claudeStatus = 'Thinking...'
        this.emitStatus(taskId)
      }
      if (step > MAX_STEPS && !controller.signal.aborted) {
        session.claudeStatus = `Stopped after ${MAX_STEPS} steps`
        session.isClaudeActive = false
        this.emitStatus(taskId)
        this.emitThought(taskId, `[done] Reached max steps (${MAX_STEPS})`)
      }
    } catch (err: any) {
      if (err.message !== 'Aborted') {
        console.error(`[BrowserManager] Claude loop error for task ${taskId}:`, err)
        session.claudeStatus = `Error: ${err.message}`
        this.emitStatus(taskId)
        this.emitThought(taskId, `[error] ${err.message}`)
      }
    } finally {
      session.isClaudeActive = false
      session.abortController = null
      this.emitStatus(taskId)
      // Detach debugger when done
      const wc = this.getWebviewContents(taskId)
      if (wc) {
        try { wc.debugger.detach() } catch { /* not attached */ }
      }
      try { unlinkSync(screenshotPath) } catch {}
    }
  }

  private emitStatus(taskId: number): void {
    const session = this.sessions.get(taskId)
    if (!session || session.owner.isDestroyed()) return
    session.owner.send(`browser:status:${taskId}`, {
      isClaudeActive: session.isClaudeActive,
      claudeStatus: session.claudeStatus,
      url: session.url,
    })
  }

  private emitThought(taskId: number, thought: string): void {
    const session = this.sessions.get(taskId)
    if (!session || session.owner.isDestroyed()) return
    session.owner.send(`browser:thought:${taskId}`, thought)
  }

  destroyAll(): void {
    for (const taskId of this.sessions.keys()) {
      this.destroy(taskId)
    }
  }
}
