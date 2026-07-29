// ═══════════════════════════════════════════
//  ECHO DICTATION — corrections + learned artifacts
//
//  The sidecar (Echo) emits a `correction` event whenever the user edits text
//  it pasted. We log every correction here, then a background "learner" distills
//  them into a dictionary (proper-noun fixes) + style notes, which get compiled
//  into echo-learned.json and injected into Echo's polish prompt next time.
// ═══════════════════════════════════════════
import { getDb } from './connection'

export interface DictationCorrection {
  id: number
  ts: string
  app: string | null
  raw_transcript: string
  pasted: string
  corrected: string
  learned: number
}

export interface DictionaryEntry {
  heard: string
  canonical: string
  hits: number
}

// ── Corrections ──

export function insertCorrection(c: {
  app?: string | null
  raw_transcript: string
  pasted: string
  corrected: string
}): number {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO dictation_corrections (app, raw_transcript, pasted, corrected)
       VALUES (?, ?, ?, ?)`
    )
    .run(c.app ?? null, c.raw_transcript, c.pasted, c.corrected)
  return Number(info.lastInsertRowid)
}

export function countUnlearnedCorrections(): number {
  const db = getDb()
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM dictation_corrections WHERE learned = 0')
    .get() as { n: number }
  return row.n
}

export function getUnlearnedCorrections(limit = 200): DictationCorrection[] {
  const db = getDb()
  return db
    .prepare(
      'SELECT * FROM dictation_corrections WHERE learned = 0 ORDER BY id ASC LIMIT ?'
    )
    .all(limit) as DictationCorrection[]
}

export function markCorrectionsLearned(ids: number[]): void {
  if (ids.length === 0) return
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(
    `UPDATE dictation_corrections SET learned = 1 WHERE id IN (${placeholders})`
  ).run(...ids)
}

export function getRecentCorrections(limit = 50): DictationCorrection[] {
  const db = getDb()
  return db
    .prepare('SELECT * FROM dictation_corrections ORDER BY id DESC LIMIT ?')
    .all(limit) as DictationCorrection[]
}

// ── Dictionary ──

export function upsertDictionaryEntry(heard: string, canonical: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO dictation_dictionary (heard, canonical, hits, updated_at)
       VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT(heard, canonical)
       DO UPDATE SET hits = hits + 1, updated_at = datetime('now')`
  ).run(heard, canonical)
}

export function getDictionary(): DictionaryEntry[] {
  const db = getDb()
  return db
    .prepare(
      'SELECT heard, canonical, hits FROM dictation_dictionary ORDER BY hits DESC, canonical ASC'
    )
    .all() as DictionaryEntry[]
}

export function deleteDictionaryEntry(heard: string, canonical: string): void {
  const db = getDb()
  db.prepare(
    'DELETE FROM dictation_dictionary WHERE heard = ? AND canonical = ?'
  ).run(heard, canonical)
}

// ── Style notes ──

export function addStyleNote(note: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO dictation_style (note, updated_at) VALUES (?, datetime('now'))
     ON CONFLICT(note) DO UPDATE SET updated_at = datetime('now')`
  ).run(note)
}

export function getStyleNotes(): string[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT note FROM dictation_style ORDER BY updated_at DESC')
    .all() as { note: string }[]
  return rows.map((r) => r.note)
}

export function deleteStyleNote(note: string): void {
  const db = getDb()
  db.prepare('DELETE FROM dictation_style WHERE note = ?').run(note)
}
