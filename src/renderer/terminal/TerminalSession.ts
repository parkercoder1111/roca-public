import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'

export class TerminalSession {
  terminal: Terminal
  fitAddon: FitAddon
  _cleanup?: () => void
  _pasteHandler?: (e: KeyboardEvent) => void
  private resizeObserver: ResizeObserver
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private _onResizeInitTimer?: ReturnType<typeof setTimeout>
  private writeBuf = ''
  private writeRaf: number | null = null
  private lastExplicitFitAt = 0
  private webglAddon: WebglAddon | null = null

  constructor(container: HTMLElement, options?: { onLinkClick?: (url: string) => void }) {
    // Resolve design token at init time so the terminal background stays in sync
    // with the surface color. TODO: re-apply on theme changes for dark mode support.
    const surfaceBg = getComputedStyle(document.documentElement).getPropertyValue('--color-surface-0').trim() || '#FFFFFF'
    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 1,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", "Courier New", monospace',
      smoothScrollDuration: 0,
      theme: {
        background: surfaceBg,
        foreground: '#1A1A1A',
        cursor: '#1A1A1A',
        selectionBackground: '#B4D5FE',
        black: '#1A1A1A',
        red: '#C41A16',
        green: '#007400',
        yellow: '#826B28',
        blue: '#0451A5',
        magenta: '#A626A4',
        cyan: '#0598BC',
        white: '#E5E5E5',
        brightBlack: '#C8C8C8',
        brightRed: '#E53935',
        brightGreen: '#1AAB46',
        brightYellow: '#B68200',
        brightBlue: '#0066CC',
        brightMagenta: '#9B59B6',
        brightCyan: '#0598BC',
        brightWhite: '#1A1A1A',
      },
      scrollback: 50000,
      scrollOnUserInput: false,
      allowProposedApi: true,
    })

    this.fitAddon = new FitAddon()
    this.terminal.loadAddon(this.fitAddon)
    this.terminal.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault()
      if (options?.onLinkClick) {
        options.onLinkClick(uri)
      } else {
        window.open(uri, '_blank')
      }
    }))

    this.terminal.open(container)

    // Load WebGL renderer AFTER open() for GPU-accelerated rendering.
    // Falls back to default canvas renderer if WebGL context fails.
    try {
      const webgl = new WebglAddon()
      this.webglAddon = webgl
      webgl.onContextLoss(() => {
        try { webgl.dispose() } catch { /* already disposed */ }
        this.webglAddon = null
        // Terminal falls back to default canvas renderer automatically
      })
      this.terminal.loadAddon(webgl)
    } catch {
      // WebGL not available — default canvas renderer is fine
    }

    // Initial fit after a brief delay to let the container settle
    requestAnimationFrame(() => {
      this.fit()
    })

    // Auto-resize on container size change (debounced to prevent scroll jumps).
    // Suppresses duplicate fit() calls when an explicit fit() was recently invoked
    // (e.g. when terminal becomes visible), preventing resize race conditions
    // that cause text scrambling.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => {
        try {
          // Skip if container is hidden (zero dimensions)
          if (container.clientWidth === 0 || container.clientHeight === 0) return
          // Skip if an explicit fit() was called recently (within the debounce window)
          // to avoid double-resize race conditions
          if (Date.now() - this.lastExplicitFitAt < 300) return
          this.fitAddon.fit()
        } catch {
          // Container might not be visible
        }
      }, 250)
    })
    this.resizeObserver.observe(container)
  }

  /**
   * Fit the terminal to its container. Stamps the call time so the
   * ResizeObserver's debounced fit() is suppressed, preventing
   * double-resize race conditions that scramble text.
   */
  fit() {
    this.lastExplicitFitAt = Date.now()
    this.fitAddon.fit()
  }

  write(data: string) {
    // Filter out Claude Code's decorative horizontal rules (lines of ─/━ box-drawing chars,
    // possibly wrapped in ANSI escape sequences for color/dim styling)
    const filtered = data.replace(/(?:\x1b\[[0-9;]*m)*[─━╌╍┄┅┈┉―]{4,}(?:\x1b\[[0-9;]*m)*\r?\n/g, '')

    // Batch writes on a short timer (32ms ≈ 2 frames) instead of per-rAF.
    // Claude Code's status bar redraws emit cursor-position → erase-line → rewrite
    // as separate chunks. With rAF batching, the erase and rewrite can land in
    // separate frames, causing a visible flash. A 32ms window coalesces them.
    this.writeBuf += filtered
    if (this.writeRaf === null) {
      this.writeRaf = window.setTimeout(() => {
        this.writeRaf = null
        const buf = this.writeBuf
        this.writeBuf = ''
        this.terminal.write(buf)
      }, 32)
    }
  }

  onData(callback: (data: string) => void) {
    this.terminal.onData(callback)
  }

  onResize(callback: (cols: number, rows: number) => void) {
    this.terminal.onResize(({ cols, rows }) => callback(cols, rows))
    // Send initial size after fit
    this._onResizeInitTimer = setTimeout(() => {
      this._onResizeInitTimer = undefined
      callback(this.terminal.cols, this.terminal.rows)
    }, 100)
  }

  focus() {
    this.terminal.focus()
  }

  dispose() {
    if (this._onResizeInitTimer) clearTimeout(this._onResizeInitTimer)
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    if (this.writeRaf !== null) {
      clearTimeout(this.writeRaf)
      // Flush remaining buffer before dispose
      if (this.writeBuf) {
        this.terminal.write(this.writeBuf)
        this.writeBuf = ''
      }
    }
    this.resizeObserver.disconnect()
    // Dispose WebGL addon first to prevent double-dispose crash.
    // xterm's AddonManager iterates all registered addons during terminal.dispose(),
    // but a manually-disposed WebGL addon (from context loss) leaves a stale entry
    // that throws "Cannot read properties of undefined (reading '_isDisposed')".
    if (this.webglAddon) {
      try { this.webglAddon.dispose() } catch { /* already disposed */ }
      this.webglAddon = null
    }
    try {
      this.terminal.dispose()
    } catch {
      // Guard against addon registry inconsistencies during teardown
    }
  }
}
