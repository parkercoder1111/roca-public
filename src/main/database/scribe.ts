// Scribe (meeting note-taker) queries. Mirrors the dictation.ts pattern.
import { getDb } from './connection'

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

export function createRecording(a: { title: string; calendarEventId?: string | null }): number {
  const info = getDb()
    .prepare(`INSERT INTO scribe_recordings (title, calendar_event_id) VALUES (?, ?)`)
    .run(a.title, a.calendarEventId ?? null)
  return Number(info.lastInsertRowid)
}

export function addSegment(s: {
  recordingId: number
  speaker: string
  text: string
  startMs: number
  endMs: number
}): void {
  getDb()
    .prepare(
      `INSERT INTO scribe_segments (recording_id, speaker, text, start_ms, end_ms)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(s.recordingId, s.speaker, s.text, s.startMs, s.endMs)
}

export function finishRecording(id: number, a: { status: string }): void {
  getDb()
    .prepare(
      `UPDATE scribe_recordings
         SET status = ?,
             ended_at = datetime('now'),
             duration_ms = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400000 AS INTEGER)
       WHERE id = ?`
    )
    .run(a.status, id)
}

export function updateRecordingStatus(id: number, status: string): void {
  getDb().prepare(`UPDATE scribe_recordings SET status = ? WHERE id = ?`).run(status, id)
}

export function renameRecording(id: number, title: string): void {
  getDb().prepare(`UPDATE scribe_recordings SET title = ? WHERE id = ?`).run(title || 'Untitled meeting', id)
}

export function updateRecordingNotes(
  id: number,
  a: { cleaned_transcript?: string; notes_md?: string; summary?: string; memory_path?: string }
): void {
  getDb()
    .prepare(
      `UPDATE scribe_recordings
         SET cleaned_transcript = COALESCE(?, cleaned_transcript),
             notes_md           = COALESCE(?, notes_md),
             summary            = COALESCE(?, summary),
             memory_path        = COALESCE(?, memory_path)
       WHERE id = ?`
    )
    .run(a.cleaned_transcript ?? null, a.notes_md ?? null, a.summary ?? null, a.memory_path ?? null, id)
}

export function getRecordings(): ScribeRecording[] {
  return getDb()
    .prepare(`SELECT * FROM scribe_recordings ORDER BY id DESC`)
    .all() as ScribeRecording[]
}

export function getRecording(id: number): ScribeRecording | undefined {
  return getDb()
    .prepare(`SELECT * FROM scribe_recordings WHERE id = ?`)
    .get(id) as ScribeRecording | undefined
}

export function getSegments(recordingId: number): ScribeSegment[] {
  return getDb()
    .prepare(`SELECT * FROM scribe_segments WHERE recording_id = ? ORDER BY start_ms ASC, id ASC`)
    .all(recordingId) as ScribeSegment[]
}
