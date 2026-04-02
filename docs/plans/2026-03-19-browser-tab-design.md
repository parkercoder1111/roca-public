# Browser Tab Design

## Summary

Add a "Browser" tab to the RightPanel alongside Notes, One-shot, and Terminal. The tab embeds a live browser that Claude can control via the Computer Use API, letting users watch and direct Claude's browser-based work per-task.

## Architecture

### Two Backends, One UI

- **Local mode (default):** Electron `<webview>` tag — zero external dependencies. Screenshots via `webview.capturePage()`, actions via `webview.sendInputEvent()`.
- **BrowserBase mode (optional):** Cloud-hosted session via BrowserBase API. `<webview>` loads the BrowserBase live view URL. Claude controls via their Playwright integration.

The Browser tab UI is identical regardless of backend.

### Main Process: BrowserManager

New file: `src/main/browserManager.ts` — manages per-task browser sessions, similar to `ptyManager.ts`.

```
BrowserManager
├── sessions: Map<taskId, BrowserSession>
├── createSession(taskId, mode: 'local' | 'browserbase') → session
├── destroySession(taskId)
├── getSession(taskId) → session | null
└── startClaudeLoop(taskId, instruction: string)
    └── screenshot → Claude API (computer_use) → action → execute → repeat
```

**BrowserSession shape:**
```typescript
interface BrowserSession {
  taskId: number
  mode: 'local' | 'browserbase'
  url: string
  isClaudeActive: boolean
  claudeMessages: { role: 'claude' | 'user'; text: string }[]
}
```

### Renderer: TaskBrowser Component

New file: `src/renderer/components/TaskBrowser.tsx`

**Layout:**
```
┌─────────────────────────────────────────────────┐
│ ◀ ▶ ⟳  │ https://example.com          │ ▪ Stop │  ← Control bar
├─────────────────────────────────────────────────┤
│                                                 │
│            <webview> live browser               │  ← Browser view
│                                                 │
├─────────────────────────────────────────────────┤
│ Claude: Clicking "Sign in" button...            │  ← Status bar
│ ┌─────────────────────────────────────────────┐ │
│ │ Tell Claude what to do...          [Send]   │ │  ← Instruction input
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**Components:**
- Control bar: back, forward, refresh, URL display (read-only, updates on navigation), start/stop session
- Webview: `<webview>` tag, fills available space
- Status bar: shows Claude's latest action description
- Instruction input: text field + send button to give Claude a task

### RightPanel Integration

- Add `'browser'` to `PanelTab` union type
- Add Browser tab button in the tab bar
- Render `<TaskBrowser>` component when active
- Per-task tab memory already handled by `tabPerTaskRef`

### Claude Computer Use Loop

Runs in main process:
1. User sends instruction ("Log into my account")
2. `webview.capturePage()` takes a screenshot
3. Send to Claude API with `computer_use_20241022` tool + the instruction
4. Claude returns an action: `{ type: 'click', x: 150, y: 300 }` or `{ type: 'type', text: 'hello' }`
5. Execute via `webview.sendInputEvent()` (local) or Playwright (BrowserBase)
6. Wait briefly, take new screenshot, send back to Claude with result
7. Repeat until Claude says "done" or user stops

### IPC Channels

New channels in `preload.ts`:
- `browser:create-session` — create a new session for a task
- `browser:destroy-session` — tear down a session
- `browser:send-instruction` — send a Claude instruction
- `browser:stop-claude` — stop the Claude loop
- `browser:on-status-update` — stream Claude's action descriptions to renderer

### Security

- `<webview>` runs in a separate process with its own renderer (Electron default)
- `contextIsolation: true` already enforced
- BrowserBase API key stored via existing settings/env pattern

## Per-Task Session Lifecycle

1. User selects task, clicks Browser tab
2. "Start Session" button shown (no webview yet)
3. User clicks Start → IPC creates session → webview loads blank page
4. User types instruction + clicks Send → Claude loop starts
5. User can watch Claude work, send follow-up instructions
6. "Stop" button halts Claude loop, webview stays for manual browsing
7. Switching tasks hides webview (stays in DOM), shows other task's webview
8. "Stop Session" tears down everything

## Dependencies

- `@anthropic-ai/sdk` — Claude API client (if not already present)
- No new dependencies for local mode (`<webview>` is built into Electron)
- Optional: `browserbase-sdk` for BrowserBase mode

## Files to Create/Modify

**New files:**
- `src/main/browserManager.ts` — session + Claude loop management
- `src/renderer/components/TaskBrowser.tsx` — browser tab UI

**Modified files:**
- `src/renderer/components/RightPanel.tsx` — add 'browser' tab
- `src/main/preload.ts` — add browser IPC channels
- `src/main/main.ts` — register browser IPC handlers
- `src/shared/types.ts` — add BrowserSession type
