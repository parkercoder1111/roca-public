// Renderer-side DTOs for Scribe (shape mirrors src/main/database/scribe.ts).
export interface ScribeRecording {
  id: number
  calendar_event_id: string | null
  title: string
  attendees_json: string | null
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  status: string
  cleaned_transcript: string | null
  notes_md: string | null
  summary: string | null
  memory_path: string | null
  created_at: string
}

export interface ScribeSegment {
  id: number
  recording_id: number
  speaker: string
  text: string
  start_ms: number
  end_ms: number
}

export interface CalEvent {
  id: string
  title: string
  start: string
  end: string
  attendees: string[]
}
