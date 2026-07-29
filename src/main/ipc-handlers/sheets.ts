import { ipcMain } from 'electron'
import * as gmail from '../gmail'

export function registerSheetsHandlers(): void {
  // ── Google Sheets ──
  async function fetchOutreachData(): Promise<string[][] | null> {
    // Configure with your own sheet: set SHEET_DATA_ID (spreadsheet id) and
    // optionally SHEET_DATA_RANGE (defaults to the first sheet). Returns null
    // until configured, so the app runs fine without it.
    const SHEET_ID = process.env.SHEET_DATA_ID || ''
    const RANGE = process.env.SHEET_DATA_RANGE || 'Sheet1!A1:Z100'
    if (!SHEET_ID) return null

    // Try OAuth token first
    const token = await gmail.getGoogleToken()
    if (token) {
      try {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}`
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        })
        if (resp.ok) {
          const data = await resp.json() as { values?: string[][] }
          return data.values || null
        }
        console.error('[sheets] OAuth fetch failed:', resp.status)
      } catch (e) {
        console.error('[sheets] OAuth fetch error:', e)
      }
    }

    // Fallback: API key
    const apiKey = process.env.GOOGLE_API_KEY
    if (apiKey) {
      try {
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}?key=${apiKey}`
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
        if (resp.ok) {
          const data = await resp.json() as { values?: string[][] }
          return data.values || null
        }
        console.error('[sheets] API key fetch failed:', resp.status)
      } catch (e) {
        console.error('[sheets] API key fetch error:', e)
      }
    }

    console.error('[sheets] Both OAuth and API key failed or unavailable')
    return null
  }

  ipcMain.handle('sheets:outreach-data', fetchOutreachData)
}
