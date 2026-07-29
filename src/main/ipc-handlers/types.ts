import type { BrowserWindow } from 'electron'
import type { PtyManager } from '../pty-manager'
import type { BrowserManager } from '../browser-manager'
import type { RemoteServer } from '../remote-server'
import type { ScribeManager } from '../scribe-manager'

export interface IpcDeps {
  getMainWindow: () => BrowserWindow | null
  popoutWindows: Map<string, BrowserWindow>
  ptyManager: PtyManager
  browserManager: BrowserManager
  remoteServer: RemoteServer
  scribeManager: ScribeManager
  getUpdateAvailable: () => boolean
  setUpdateAvailable: (v: boolean) => void
  setIsHotReloading: (v: boolean) => void
  rebuildMenu: () => void
}
