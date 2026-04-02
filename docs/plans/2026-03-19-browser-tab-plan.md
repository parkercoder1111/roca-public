# Browser Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Browser" tab to the RightPanel that embeds a live browser controlled by Claude via Computer Use API, with optional BrowserBase cloud backend.

**Architecture:** Electron `<webview>` tag for the embedded browser (local mode), BrowserManager in main process for session lifecycle, Claude Computer Use loop for AI control. Per-task sessions mirroring the existing Terminal pattern.

**Tech Stack:** Electron webview, Claude API (`@anthropic-ai/sdk`), IPC, React, Tailwind CSS

---

### Task 1: Enable webview tag in Electron

**Files:**
- Modify: `src/main/main.ts:115-119`

**Step 1: Add webviewTag to BrowserWindow preferences**

In `createWindow()`, add `webviewTag: true` to `webPreferences`:

```typescript
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: true,
},
```

**Step 2: Verify the app still launches**

Run: `npm run dev`
Expected: App opens normally, no errors in console.

**Step 3: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(browser): enable webview tag in Electron window"
```

---

### Task 2: Add BrowserSession types

**Files:**
- Modify: `src/shared/types.ts`

**Step 1: Add types at the bottom of types.ts**

```typescript
// ── Browser Sessions ──

export type BrowserMode = 'local' | 'browserbase'

export interface BrowserSessionStatus {
  taskId: number
  mode: BrowserMode
  url: string
  isClaudeActive: boolean
  claudeStatus: string | null  // e.g. "Clicking 'Sign in' button..."
}
```

**Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(browser): add BrowserSession types"
```

---

### Task 3: Create BrowserManager (session lifecycle only, no Claude loop yet)

**Files:**
- Create: `src/main/browserManager.ts`

**Step 1: Create browserManager.ts**

This manages per-task browser sessions. For local mode, it just tracks state — the actual `<webview>` lives in the renderer. For BrowserBase, it will eventually create cloud sessions.

```typescript
import { WebContents } from 'electron'
import type { BrowserMode, BrowserSessionStatus } from '../shared/types'

interface BrowserSession {
  taskId: number
  mode: BrowserMode
  url: string
  owner: WebContents
  isClaudeActive: boolean
  claudeStatus: string | null
  abortController: AbortController | null
}

export class BrowserManager {
  private sessions = new Map<number, BrowserSession>()

  create(taskId: number, mode: BrowserMode, owner: WebContents): BrowserSessionStatus {
    // Kill existing session for this task if any
    this.destroy(taskId)

    const session: BrowserSession = {
      taskId,
      mode,
      url: 'about:blank',
      owner,
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

  getSession(taskId: number): BrowserSession | undefined {
    return this.sessions.get(taskId)
  }

  destroyAll(): void {
    for (const taskId of this.sessions.keys()) {
      this.destroy(taskId)
    }
  }
}
```

**Step 2: Commit**

```bash
git add src/main/browserManager.ts
git commit -m "feat(browser): add BrowserManager for session lifecycle"
```

---

### Task 4: Add browser IPC channels

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/main/main.ts`

**Step 1: Add browser APIs to preload.ts**

Add this section after the `// ── PTY events ──` block, before the closing `})`:

```typescript
  // ── Browser ──
  createBrowserSession: (taskId: number, mode: string) =>
    ipcRenderer.invoke('browser:create', taskId, mode),
  destroyBrowserSession: (taskId: number) =>
    ipcRenderer.invoke('browser:destroy', taskId),
  getBrowserSession: (taskId: number) =>
    ipcRenderer.invoke('browser:get', taskId),
  browserNavigate: (taskId: number, url: string) =>
    ipcRenderer.invoke('browser:navigate', taskId, url),
  browserSendInstruction: (taskId: number, instruction: string) =>
    ipcRenderer.invoke('browser:send-instruction', taskId, instruction),
  browserStopClaude: (taskId: number) =>
    ipcRenderer.invoke('browser:stop-claude', taskId),

  // ── Browser events ──
  onBrowserStatus: (taskId: number, callback: (status: any) => void) => {
    const channel = `browser:status:${taskId}`
    const listener = (_: any, status: any) => callback(status)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
```

**Step 2: Register IPC handlers in main.ts**

Add after the PTY IPC handlers (around line 888), and import/instantiate the BrowserManager near the PtyManager:

Near the top where `PtyManager` is imported (find `import { PtyManager }`), add:
```typescript
import { BrowserManager } from './browserManager'
```

Near where `const ptyManager = new PtyManager()`, add:
```typescript
const browserManager = new BrowserManager()
```

Add these IPC handlers after the PTY handlers:

```typescript
  // ═══ Browser ═══
  ipcMain.handle('browser:create', (event, taskId: number, mode: string) => {
    return browserManager.create(taskId, mode as any, event.sender)
  })

  ipcMain.handle('browser:destroy', (_, taskId: number) => {
    browserManager.destroy(taskId)
    return { ok: true }
  })

  ipcMain.handle('browser:get', (_, taskId: number) => {
    return browserManager.getStatus(taskId)
  })

  ipcMain.handle('browser:navigate', (_, taskId: number, url: string) => {
    browserManager.updateUrl(taskId, url)
    return { ok: true }
  })

  ipcMain.handle('browser:send-instruction', async (event, taskId: number, instruction: string) => {
    // Claude loop will be implemented in Task 6
    return { ok: false, error: 'Not implemented yet' }
  })

  ipcMain.handle('browser:stop-claude', (_, taskId: number) => {
    const session = browserManager.getSession(taskId)
    if (session?.abortController) {
      session.abortController.abort()
      session.isClaudeActive = false
      session.claudeStatus = null
    }
    return { ok: true }
  })
```

In the `app.on('before-quit')` handler (or wherever `ptyManager.killAll()` is called), add:
```typescript
browserManager.destroyAll()
```

**Step 3: Verify app launches without errors**

Run: `npm run dev`
Expected: App starts, no IPC registration errors.

**Step 4: Commit**

```bash
git add src/main/preload.ts src/main/main.ts
git commit -m "feat(browser): add browser IPC channels and handlers"
```

---

### Task 5: Create TaskBrowser component and wire into RightPanel

**Files:**
- Create: `src/renderer/components/TaskBrowser.tsx`
- Modify: `src/renderer/components/RightPanel.tsx`

**Step 1: Create TaskBrowser.tsx**

```tsx
import React, { useRef, useState, useEffect, useCallback } from 'react'
import type { Task } from '@shared/types'

interface Props {
  task: Task
  isActive: boolean
}

export default function TaskBrowser({ task, isActive }: Props) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const [url, setUrl] = useState('https://www.google.com')
  const [displayUrl, setDisplayUrl] = useState('https://www.google.com')
  const [isSessionActive, setIsSessionActive] = useState(false)
  const [isClaudeActive, setIsClaudeActive] = useState(false)
  const [claudeStatus, setClaudeStatus] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')

  // Start session
  const handleStartSession = useCallback(async () => {
    await window.electronAPI.createBrowserSession(task.id, 'local')
    setIsSessionActive(true)
  }, [task.id])

  // Stop session
  const handleStopSession = useCallback(async () => {
    await window.electronAPI.browserStopClaude(task.id)
    await window.electronAPI.destroyBrowserSession(task.id)
    setIsSessionActive(false)
    setIsClaudeActive(false)
    setClaudeStatus(null)
  }, [task.id])

  // Navigate
  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const webview = webviewRef.current
    if (!webview) return
    let target = url
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target
      setUrl(target)
    }
    webview.loadURL(target)
  }, [url])

  const handleBack = useCallback(() => webviewRef.current?.goBack(), [])
  const handleForward = useCallback(() => webviewRef.current?.goForward(), [])
  const handleRefresh = useCallback(() => webviewRef.current?.reload(), [])

  // Listen to webview navigation events
  useEffect(() => {
    if (!isSessionActive) return
    const webview = webviewRef.current
    if (!webview) return

    const onNavigate = (e: any) => {
      setDisplayUrl(e.url)
      setUrl(e.url)
      window.electronAPI.browserNavigate(task.id, e.url)
    }
    const onDidNavigate = (e: any) => {
      setDisplayUrl(e.url)
      setUrl(e.url)
    }

    webview.addEventListener('will-navigate', onNavigate)
    webview.addEventListener('did-navigate', onDidNavigate)
    webview.addEventListener('did-navigate-in-page', onDidNavigate)

    return () => {
      webview.removeEventListener('will-navigate', onNavigate)
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigate)
    }
  }, [isSessionActive, task.id])

  // Listen to Claude status updates
  useEffect(() => {
    const remove = window.electronAPI.onBrowserStatus(task.id, (status) => {
      setIsClaudeActive(status.isClaudeActive)
      setClaudeStatus(status.claudeStatus)
      if (status.url) {
        setDisplayUrl(status.url)
        setUrl(status.url)
      }
    })
    return remove
  }, [task.id])

  // Send instruction to Claude
  const handleSendInstruction = useCallback(async () => {
    if (!instruction.trim()) return
    setIsClaudeActive(true)
    setClaudeStatus('Starting...')
    await window.electronAPI.browserSendInstruction(task.id, instruction.trim())
    setInstruction('')
  }, [task.id, instruction])

  // Not started state
  if (!isSessionActive) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3">
        <svg className="w-12 h-12 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
        <p className="text-sm">Start a browser session for this task</p>
        <button
          onClick={handleStartSession}
          className="px-4 py-2 rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 text-sm font-medium transition-all"
        >
          Start Browser
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Control bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-surface-0 border-b border-white/[0.06]">
        <button onClick={handleBack} className="p-1 rounded hover:bg-white/[0.06] text-text-3 hover:text-text-2 transition-all">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button onClick={handleForward} className="p-1 rounded hover:bg-white/[0.06] text-text-3 hover:text-text-2 transition-all">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button onClick={handleRefresh} className="p-1 rounded hover:bg-white/[0.06] text-text-3 hover:text-text-2 transition-all">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <form onSubmit={handleNavigate} className="flex-1 mx-2">
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-md px-3 py-1 text-[11px] text-text-2 focus:outline-none focus:border-purple-500/30"
            placeholder="Enter URL..."
          />
        </form>

        <button
          onClick={handleStopSession}
          className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-red-400 hover:bg-red-500/10 transition-all"
        >
          End
        </button>
      </div>

      {/* Webview */}
      <div className="flex-1 relative">
        <webview
          ref={webviewRef as any}
          src="https://www.google.com"
          className="absolute inset-0 w-full h-full"
          {...{ allowpopups: '' } as any}
        />
      </div>

      {/* Claude control bar */}
      <div className="shrink-0 border-t border-white/[0.06] bg-surface-0">
        {claudeStatus && (
          <div className="px-3 py-1.5 text-[11px] text-purple-400 border-b border-white/[0.06] flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            {claudeStatus}
          </div>
        )}
        <div className="flex items-center gap-2 px-3 py-1.5">
          <input
            type="text"
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSendInstruction()}
            placeholder="Tell Claude what to do..."
            className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-md px-3 py-1.5 text-[11px] text-text-2 placeholder-text-4 focus:outline-none focus:border-purple-500/30"
            disabled={isClaudeActive}
          />
          {isClaudeActive ? (
            <button
              onClick={() => window.electronAPI.browserStopClaude(task.id).then(() => { setIsClaudeActive(false); setClaudeStatus(null) })}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSendInstruction}
              disabled={!instruction.trim()}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Add browser tab to RightPanel.tsx**

In `RightPanel.tsx`:

a) Update PanelTab type (line 7):
```typescript
type PanelTab = 'notes' | 'analysis' | 'terminal' | 'browser'
```

b) Add import at top:
```typescript
import TaskBrowser from './TaskBrowser'
```

c) Add browser tab to the `tabs` array (after the terminal entry, around line 107):
```typescript
    {
      id: 'browser',
      label: 'Browser',
      icon: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
      ),
    },
```

d) Add browser content section after the terminal div (after line 165):
```tsx
        <div className={`h-full ${activeTab === 'browser' ? 'flex flex-col' : 'hidden'}`}>
          <TaskBrowser
            task={task}
            isActive={activeTab === 'browser'}
          />
        </div>
```

**Step 3: Verify the tab appears and webview loads**

Run: `npm run dev`
Expected: Browser tab appears in RightPanel. Clicking "Start Browser" shows Google in an embedded browser with nav controls.

**Step 4: Commit**

```bash
git add src/renderer/components/TaskBrowser.tsx src/renderer/components/RightPanel.tsx
git commit -m "feat(browser): add TaskBrowser component with webview and nav controls"
```

---

### Task 6: Install Anthropic SDK and implement Claude Computer Use loop

**Files:**
- Modify: `src/main/browserManager.ts`
- Modify: `src/main/main.ts`

**Step 1: Install the Anthropic SDK**

```bash
cd /Users/gps/roca && npm install @anthropic-ai/sdk
```

**Step 2: Add Claude loop to BrowserManager**

Add this method to the `BrowserManager` class in `browserManager.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk'

// Add to the top of the file:
const SCREENSHOT_DELAY_MS = 1500

// Add these methods to the BrowserManager class:

  async startClaudeLoop(
    taskId: number,
    instruction: string,
    captureScreenshot: () => Promise<string>, // returns base64 PNG
    executeAction: (action: any) => Promise<void>,
  ): Promise<void> {
    const session = this.sessions.get(taskId)
    if (!session) throw new Error(`No session for task ${taskId}`)

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

    const client = new Anthropic({ apiKey })
    const controller = new AbortController()
    session.abortController = controller
    session.isClaudeActive = true
    this.emitStatus(taskId)

    try {
      // Take initial screenshot
      let screenshot = await captureScreenshot()

      let messages: any[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: instruction,
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshot,
              },
            },
          ],
        },
      ]

      while (!controller.signal.aborted) {
        const response = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: `You are controlling a web browser. You can see a screenshot of the current page. Respond with actions to take. Available actions:
- {"action": "click", "x": <number>, "y": <number>} — click at coordinates
- {"action": "type", "text": "<string>"} — type text (assumes focused input)
- {"action": "key", "key": "<string>"} — press a key (Enter, Tab, Escape, etc.)
- {"action": "scroll", "x": <number>, "y": <number>, "deltaY": <number>} — scroll at position
- {"action": "done", "summary": "<string>"} — task is complete

Respond with a brief description of what you see and what you'll do, then a JSON action block on its own line starting with \`\`\`json.`,
          messages,
        })

        if (controller.signal.aborted) break

        // Extract text and action from response
        const textBlock = response.content.find((b: any) => b.type === 'text')
        const responseText = textBlock?.text || ''

        // Update status
        const statusLine = responseText.split('\n')[0].slice(0, 100)
        session.claudeStatus = statusLine
        this.emitStatus(taskId)

        // Parse action from response
        const jsonMatch = responseText.match(/```json\s*\n([\s\S]*?)\n```/)
        if (!jsonMatch) {
          session.claudeStatus = 'Could not parse action — stopping'
          session.isClaudeActive = false
          this.emitStatus(taskId)
          break
        }

        const action = JSON.parse(jsonMatch[1])

        if (action.action === 'done') {
          session.claudeStatus = `Done: ${action.summary || 'Task complete'}`
          session.isClaudeActive = false
          this.emitStatus(taskId)
          break
        }

        // Execute the action
        await executeAction(action)

        // Wait for page to update
        await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS))
        if (controller.signal.aborted) break

        // Take new screenshot
        screenshot = await captureScreenshot()

        // Build follow-up message
        messages = [
          ...messages,
          { role: 'assistant', content: responseText },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Here is the updated screenshot after executing your action. Continue with the task.',
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: screenshot,
                },
              },
            ],
          },
        ]
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error(`[BrowserManager] Claude loop error for task ${taskId}:`, err)
        session.claudeStatus = `Error: ${err.message}`
        this.emitStatus(taskId)
      }
    } finally {
      session.isClaudeActive = false
      session.abortController = null
      this.emitStatus(taskId)
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
```

**Step 3: Wire up the send-instruction IPC handler in main.ts**

Replace the placeholder `browser:send-instruction` handler:

```typescript
  ipcMain.handle('browser:send-instruction', async (event, taskId: number, instruction: string) => {
    const session = browserManager.getSession(taskId)
    if (!session) return { ok: false, error: 'No session' }

    // Screenshot: send message to renderer to capture the webview
    const captureScreenshot = async (): Promise<string> => {
      // Ask the renderer's webview to capture a screenshot
      const result = await event.sender.invoke
      // We need a different approach — use IPC round-trip
      return new Promise((resolve) => {
        const channel = `browser:screenshot-response:${taskId}`
        ipcMain.once(channel, (_, base64: string) => resolve(base64))
        event.sender.send(`browser:screenshot-request:${taskId}`)
      })
    }

    // Execute action: send to renderer to run on the webview
    const executeAction = async (action: any): Promise<void> => {
      return new Promise((resolve) => {
        const channel = `browser:action-done:${taskId}`
        ipcMain.once(channel, () => resolve())
        event.sender.send(`browser:execute-action:${taskId}`, action)
      })
    }

    // Run the loop in background (don't await — it's long-running)
    browserManager.startClaudeLoop(taskId, instruction, captureScreenshot, executeAction)
      .catch(err => console.error('[Browser] Claude loop error:', err))

    return { ok: true }
  })
```

**Step 4: Add screenshot/action IPC to preload.ts**

Add to the browser section in preload.ts:

```typescript
  // ── Browser screenshot/action callbacks ──
  onBrowserScreenshotRequest: (taskId: number, callback: () => void) => {
    const channel = `browser:screenshot-request:${taskId}`
    const listener = () => callback()
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
  sendBrowserScreenshot: (taskId: number, base64: string) => {
    ipcRenderer.send(`browser:screenshot-response:${taskId}`, base64)
  },
  onBrowserExecuteAction: (taskId: number, callback: (action: any) => void) => {
    const channel = `browser:execute-action:${taskId}`
    const listener = (_: any, action: any) => callback(action)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
  sendBrowserActionDone: (taskId: number) => {
    ipcRenderer.send(`browser:action-done:${taskId}`)
  },
```

**Step 5: Handle screenshot capture and action execution in TaskBrowser.tsx**

Add these effects to `TaskBrowser.tsx` (inside the component, after the existing useEffects):

```tsx
  // Handle screenshot requests from main process
  useEffect(() => {
    if (!isSessionActive) return
    const remove = window.electronAPI.onBrowserScreenshotRequest(task.id, async () => {
      const webview = webviewRef.current
      if (!webview) {
        window.electronAPI.sendBrowserScreenshot(task.id, '')
        return
      }
      try {
        // capturePage returns a NativeImage
        const image = await (webview as any).capturePage()
        const base64 = image.toDataURL().replace(/^data:image\/png;base64,/, '')
        window.electronAPI.sendBrowserScreenshot(task.id, base64)
      } catch (err) {
        console.error('[TaskBrowser] Screenshot capture failed:', err)
        window.electronAPI.sendBrowserScreenshot(task.id, '')
      }
    })
    return remove
  }, [isSessionActive, task.id])

  // Handle action execution requests from main process
  useEffect(() => {
    if (!isSessionActive) return
    const remove = window.electronAPI.onBrowserExecuteAction(task.id, async (action) => {
      const webview = webviewRef.current
      if (!webview) {
        window.electronAPI.sendBrowserActionDone(task.id)
        return
      }
      try {
        if (action.action === 'click') {
          await (webview as any).sendInputEvent({ type: 'mouseDown', x: action.x, y: action.y, button: 'left', clickCount: 1 })
          await (webview as any).sendInputEvent({ type: 'mouseUp', x: action.x, y: action.y, button: 'left', clickCount: 1 })
        } else if (action.action === 'type') {
          // Type each character
          for (const char of action.text) {
            await (webview as any).sendInputEvent({ type: 'keyDown', keyCode: char })
            await (webview as any).sendInputEvent({ type: 'char', keyCode: char })
            await (webview as any).sendInputEvent({ type: 'keyUp', keyCode: char })
          }
        } else if (action.action === 'key') {
          await (webview as any).sendInputEvent({ type: 'keyDown', keyCode: action.key })
          await (webview as any).sendInputEvent({ type: 'keyUp', keyCode: action.key })
        } else if (action.action === 'scroll') {
          await (webview as any).sendInputEvent({
            type: 'mouseWheel',
            x: action.x || 0,
            y: action.y || 0,
            deltaX: 0,
            deltaY: action.deltaY || -100,
          })
        }
      } catch (err) {
        console.error('[TaskBrowser] Action execution failed:', err)
      }
      window.electronAPI.sendBrowserActionDone(task.id)
    })
    return remove
  }, [isSessionActive, task.id])
```

**Step 6: Verify end-to-end**

Run: `npm run dev`
Set env: `ANTHROPIC_API_KEY=<your key>`
Expected:
1. Open a task, click Browser tab
2. Click "Start Browser" — Google loads
3. Type "Go to example.com" and click Send
4. Claude status shows what it's doing
5. Browser navigates to example.com

**Step 7: Commit**

```bash
git add src/main/browserManager.ts src/main/main.ts src/main/preload.ts src/renderer/components/TaskBrowser.tsx package.json package-lock.json
git commit -m "feat(browser): implement Claude Computer Use loop for browser control"
```

---

### Task 7: Add TypeScript declarations for electronAPI browser methods

**Files:**
- Find and modify the file that declares `window.electronAPI` types (check `src/renderer/App.tsx` or a global `.d.ts` file)

**Step 1: Find the type declarations**

Search for where `electronAPI` types are declared. This may be in `src/renderer/vite-env.d.ts`, `src/renderer/global.d.ts`, or inline in `App.tsx`.

**Step 2: Add the browser method types**

Add type declarations for all the new `window.electronAPI` browser methods so TypeScript doesn't complain:

```typescript
// Add to the ElectronAPI interface
createBrowserSession: (taskId: number, mode: string) => Promise<any>
destroyBrowserSession: (taskId: number) => Promise<{ ok: boolean }>
getBrowserSession: (taskId: number) => Promise<any>
browserNavigate: (taskId: number, url: string) => Promise<{ ok: boolean }>
browserSendInstruction: (taskId: number, instruction: string) => Promise<{ ok: boolean; error?: string }>
browserStopClaude: (taskId: number) => Promise<{ ok: boolean }>
onBrowserStatus: (taskId: number, callback: (status: any) => void) => () => void
onBrowserScreenshotRequest: (taskId: number, callback: () => void) => () => void
sendBrowserScreenshot: (taskId: number, base64: string) => void
onBrowserExecuteAction: (taskId: number, callback: (action: any) => void) => () => void
sendBrowserActionDone: (taskId: number) => void
```

**Step 3: Verify TypeScript compiles**

Run: `cd /Users/gps/roca && npx tsc --noEmit`
Expected: No type errors related to browser methods.

**Step 4: Commit**

```bash
git add <modified type declaration file>
git commit -m "feat(browser): add TypeScript declarations for browser IPC"
```

---

### Task 8: Per-task session persistence (match Terminal pooling pattern)

**Files:**
- Modify: `src/renderer/components/RightPanel.tsx`
- Modify: `src/renderer/components/TaskBrowser.tsx`

**Step 1: Add browser session pooling to RightPanel**

Mirror the `terminalTaskIds` pattern. In RightPanel.tsx, add a browser pool alongside the terminal pool:

```typescript
// Browser pool — keeps browser sessions alive across task switches
const browserTasksRef = useRef<Map<number, Task>>(new Map())
const [browserTaskIds, setBrowserTaskIds] = useState<Set<number>>(new Set())
```

In the task change useEffect (around line 51), add browser pool tracking:
```typescript
if (!browserTasksRef.current.has(task.id)) {
  browserTasksRef.current.set(task.id, task)
  setBrowserTaskIds(prev => new Set(prev).add(task.id))
}
```

**Step 2: Update browser rendering to use the pool**

Replace the single TaskBrowser render with the pooled pattern:

```tsx
<div className={`h-full ${activeTab === 'browser' ? 'flex flex-col' : 'hidden'}`}>
  {Array.from(browserTaskIds).map(taskId => (
    <div key={taskId} className={`h-full ${taskId === task.id ? 'flex flex-col' : 'hidden'}`}>
      <TaskBrowser
        task={taskId === task.id ? task : browserTasksRef.current.get(taskId)!}
        isActive={taskId === task.id && activeTab === 'browser'}
      />
    </div>
  ))}
</div>
```

**Step 3: Verify task switching preserves browser sessions**

Run: `npm run dev`
Expected: Start browser on task A, switch to task B, switch back to task A — browser session is still there.

**Step 4: Commit**

```bash
git add src/renderer/components/RightPanel.tsx
git commit -m "feat(browser): add per-task browser session pooling"
```

---

## Summary

| Task | What it does | Files |
|------|-------------|-------|
| 1 | Enable webview tag | main.ts |
| 2 | Add types | types.ts |
| 3 | BrowserManager (session lifecycle) | browserManager.ts (new) |
| 4 | IPC channels | preload.ts, main.ts |
| 5 | TaskBrowser component + RightPanel wiring | TaskBrowser.tsx (new), RightPanel.tsx |
| 6 | Claude Computer Use loop | browserManager.ts, main.ts, preload.ts, TaskBrowser.tsx |
| 7 | TypeScript declarations | type declaration file |
| 8 | Per-task session pooling | RightPanel.tsx |
