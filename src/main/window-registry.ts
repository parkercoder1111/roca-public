import { BrowserWindow, screen } from 'electron'

// Window registry — replaces the old `mainWindow` singleton so ROCA can run
// multiple top-level windows (Chrome-style tab management). Every renderer is
// registered here at creation and removed on close. Main-process code that
// used to do `mainWindow.webContents.send(...)` now goes through one of:
//   - registry.focused()           → "send to the window the user is looking at"
//   - registry.primary()           → "send to the first/oldest window" (RPC default)
//   - registry.all()               → broadcast (rebuild banner, update-available)
//   - registry.byId(windowId)      → explicit address
//
// Tab strip bounds (in screen coords) are reported by each renderer on layout
// so the main process can hit-test cursor positions during cross-window tab
// drags without renderers having to talk to each other directly.

export interface TabStripBounds {
  // All coordinates are in screen-space (not window-relative).
  x: number
  y: number
  width: number
  height: number
}

export interface RocaWindowEntry {
  id: string
  window: BrowserWindow
  tabStripBounds: TabStripBounds | null
}

let nextWindowSeq = 1

function makeWindowId(): string {
  // Stable, human-readable. Process-local; not persisted.
  const seq = nextWindowSeq++
  return `w${seq}-${Date.now().toString(36)}`
}

class WindowRegistry {
  private entries = new Map<string, RocaWindowEntry>()
  private creationOrder: string[] = []

  register(window: BrowserWindow): RocaWindowEntry {
    const id = makeWindowId()
    const entry: RocaWindowEntry = { id, window, tabStripBounds: null }
    this.entries.set(id, entry)
    this.creationOrder.push(id)
    window.on('closed', () => this.remove(id))
    return entry
  }

  remove(id: string): void {
    this.entries.delete(id)
    this.creationOrder = this.creationOrder.filter(x => x !== id)
  }

  byId(id: string): RocaWindowEntry | undefined {
    return this.entries.get(id)
  }

  byWindow(window: BrowserWindow): RocaWindowEntry | undefined {
    for (const e of this.entries.values()) if (e.window === window) return e
    return undefined
  }

  byWebContents(wc: Electron.WebContents): RocaWindowEntry | undefined {
    for (const e of this.entries.values()) {
      if (!e.window.isDestroyed() && e.window.webContents === wc) return e
    }
    return undefined
  }

  all(): RocaWindowEntry[] {
    // Return in creation order so "primary" is always entries[0] of all().
    return this.creationOrder.map(id => this.entries.get(id)!).filter(Boolean)
  }

  // Focused window if it's one of ours; falls back to primary. Use this for
  // RPC and shortcuts that should target "the window the user is on".
  focused(): RocaWindowEntry | undefined {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused) {
      const entry = this.byWindow(focused)
      if (entry) return entry
    }
    return this.primary()
  }

  // Oldest still-open window. RPC default target when no window is focused
  // (e.g. ROCA is in the background).
  primary(): RocaWindowEntry | undefined {
    for (const id of this.creationOrder) {
      const entry = this.entries.get(id)
      if (entry && !entry.window.isDestroyed()) return entry
    }
    return undefined
  }

  isPrimary(id: string): boolean {
    return this.primary()?.id === id
  }

  count(): number {
    return this.entries.size
  }

  setTabStripBounds(id: string, bounds: TabStripBounds | null): void {
    const entry = this.entries.get(id)
    if (entry) entry.tabStripBounds = bounds
  }

  // Find the window whose tab strip currently sits under the cursor. Used by
  // cross-window tab drag: the main process polls cursor position during a
  // drag and forwards hover/drop events to the right renderer.
  windowAtScreenPoint(point: { x: number; y: number }): RocaWindowEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.window.isDestroyed()) continue
      const b = entry.tabStripBounds
      if (!b) continue
      if (point.x >= b.x && point.x < b.x + b.width &&
          point.y >= b.y && point.y < b.y + b.height) {
        return entry
      }
    }
    return undefined
  }

  // Broadcast helper — send to every live renderer.
  broadcast(channel: string, ...args: unknown[]): void {
    for (const entry of this.entries.values()) {
      if (!entry.window.isDestroyed()) {
        entry.window.webContents.send(channel, ...args)
      }
    }
  }
}

export const windowRegistry = new WindowRegistry()

// Convenience wrapper for code that still wants the old `mainWindow` shape.
// Returns the focused-or-primary window, mirroring the most common former use.
export function getFocusedRocaWindow(): BrowserWindow | null {
  return windowRegistry.focused()?.window ?? null
}

export function getPrimaryRocaWindow(): BrowserWindow | null {
  return windowRegistry.primary()?.window ?? null
}

// Coordinate helpers ─────────────────────────────────────────────────────

// Convert a renderer-side rect (window-content coords, CSS pixels) into a
// screen-space rect using the window's content bounds + the display's scale.
// Renderers send their tab strip's getBoundingClientRect() — we add the
// window's content origin to translate into the same coord system Electron's
// `screen.getCursorScreenPoint()` returns.
export function renderRectToScreenRect(
  window: BrowserWindow,
  rect: { x: number; y: number; width: number; height: number },
): TabStripBounds {
  const content = window.getContentBounds()
  return {
    x: Math.round(content.x + rect.x),
    y: Math.round(content.y + rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

// Re-export `screen` so callers that need cursor position don't have to import
// from 'electron' separately.
export { screen }
