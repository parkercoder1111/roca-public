import type { IpcDeps } from './types'
import { registerSystemHandlers } from './system'
import { registerTasksHandlers } from './tasks'
import { registerRecurringTasksHandlers } from './recurring-tasks'
import { registerWeeksHandlers } from './weeks'
import { registerFoldersHandlers } from './folders'
import { registerDelegateHandlers } from './delegate'
import { registerUploadsHandlers } from './uploads'
import { registerDocumentsHandlers } from './documents'
import { registerSyncHandlers } from './sync'
import { registerLifecycleHandlers } from './lifecycle'
import { registerPtyHandlers } from './pty'
import { registerClaudeStreamHandlers } from './claude-stream'
import { registerAgentRunsHandlers } from './agent-runs'
import { registerBrowserHandlers } from './browser'
import { registerProjectsHandlers } from './projects'
import { registerNotesHandlers } from './notes'
import { registerSkillsHandlers } from './skills'
import { registerToolsHandlers } from './tools'
import { registerRocaHandlers } from './roca'
import { registerFilepathHandlers } from './filepath'
import { registerGmailHandlers } from './gmail'
import { registerSlackHandlers } from './slack'
import { registerSheetsHandlers } from './sheets'
import { registerDevHandlers } from './dev'
import { registerAgentsHandlers } from './agents'
import { registerPopoutHandlers } from './popout'
import { registerConnectionsHandlers } from './connections'
import { registerVoiceHandlers } from './voice'
import { registerScribeHandlers } from './scribe'

export function registerAllIpcHandlers(deps: IpcDeps): void {
  registerSystemHandlers(deps)
  registerTasksHandlers(deps)
  registerRecurringTasksHandlers()
  registerWeeksHandlers()
  registerFoldersHandlers()
  registerDelegateHandlers()
  registerUploadsHandlers()
  registerDocumentsHandlers()
  registerSyncHandlers()
  registerLifecycleHandlers(deps)
  registerPtyHandlers(deps)
  registerClaudeStreamHandlers(deps)
  registerAgentRunsHandlers()
  registerBrowserHandlers(deps)
  registerProjectsHandlers()
  registerNotesHandlers()
  registerSkillsHandlers()
  registerToolsHandlers(deps)
  registerRocaHandlers()
  registerFilepathHandlers()
  registerGmailHandlers()
  registerSlackHandlers()
  registerSheetsHandlers()
  registerDevHandlers()
  registerAgentsHandlers()
  registerPopoutHandlers(deps)
  registerConnectionsHandlers()
  registerVoiceHandlers()
  registerScribeHandlers(deps)
}

export type { IpcDeps } from './types'
