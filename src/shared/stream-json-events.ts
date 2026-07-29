// src/shared/stream-json-events.ts

export interface StreamSystemInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
  model: string
  tools: string[]
  mcp_servers?: Array<{ name: string; status: string }>
}

export interface StreamUserEvent {
  type: 'user'
  message: { role: 'user'; content: string | Array<{ type: string; text?: string }> }
  session_id: string
  // Present on transcript JSONL lines (absent on live stream-json events).
  uuid?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
}

export interface StreamAssistantEvent {
  type: 'assistant'
  message: {
    id: string
    role: 'assistant'
    model: string
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
  }
  session_id: string
  parent_tool_use_id?: string | null
  // Present on transcript JSONL lines (absent on live stream-json events).
  uuid?: string
  isSidechain?: boolean
  timestamp?: string
}

export interface StreamPartialAssistantEvent {
  type: 'stream_event'
  event: {
    type: 'content_block_delta' | 'content_block_start' | 'content_block_stop' | 'message_delta' | 'message_start' | 'message_stop'
    index?: number
    delta?: { type: 'text_delta' | 'input_json_delta' | 'thinking_delta'; text?: string; partial_json?: string; thinking?: string }
    content_block?: { type: string; text?: string; id?: string; name?: string }
  }
  session_id: string
}

export interface StreamToolResultEvent {
  type: 'user'
  message: {
    role: 'user'
    content: Array<{
      type: 'tool_result'
      tool_use_id: string
      content: string | Array<{ type: string; text?: string }>
      is_error?: boolean
    }>
  }
  session_id: string
  // Present on transcript JSONL lines (absent on live stream-json events).
  uuid?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
}

// Transcript-only line: the TUI records permission-mode changes as it runs.
export interface StreamPermissionModeEvent {
  type: 'permission-mode'
  permissionMode: string
  sessionId?: string
}

export interface StreamHookEvent {
  type: 'hook'
  hook_event_name: string
  payload?: unknown
  session_id: string
}

export interface StreamResultEvent {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution'
  duration_ms: number
  num_turns: number
  total_cost_usd?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  session_id: string
}

export type StreamJsonEvent =
  | StreamSystemInitEvent
  | StreamUserEvent
  | StreamAssistantEvent
  | StreamPartialAssistantEvent
  | StreamToolResultEvent
  | StreamPermissionModeEvent
  | StreamHookEvent
  | StreamResultEvent

export function parseStreamLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as StreamJsonEvent
  } catch {
    return null
  }
}
