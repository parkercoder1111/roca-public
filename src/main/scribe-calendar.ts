// Calendar access for Scribe's "Coming up" list + "Start note taker" popup.
// Reuses an existing Google OAuth credentials file that has the calendar scope.
// No new consent: we just refresh the access token and read upcoming events.
// Point SCRIBE_GOOGLE_TOKEN at your own OAuth JSON to enable.
import fs from 'fs'
import os from 'os'
import path from 'path'

const TOKEN_PATH =
  process.env.SCRIBE_GOOGLE_TOKEN || path.join(os.homedir(), '.google-oauth.json')

export interface CalEvent {
  id: string
  title: string
  start: string
  end: string
  attendees: string[]
}

let cached: { access: string; exp: number } | null = null

async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (cached && cached.exp > now + 60_000) return cached.access

  const creds = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')) as {
    client_id: string
    client_secret: string
    refresh_token: string
    token_uri?: string
  }
  const res = await fetch(creds.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`google token refresh failed: ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cached = { access: data.access_token, exp: now + data.expires_in * 1000 }
  return data.access_token
}

export async function getUpcomingEvents(hoursAhead = 12): Promise<CalEvent[]> {
  const token = await getAccessToken()
  const now = new Date()
  const timeMin = now.toISOString()
  const timeMax = new Date(now.getTime() + hoursAhead * 3_600_000).toISOString()
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=25`

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`calendar fetch failed: ${res.status}`)
  const data = (await res.json()) as { items?: Array<Record<string, any>> }

  return (data.items ?? [])
    .filter((e) => e.start?.dateTime) // skip all-day events (no time)
    .map((e) => ({
      id: String(e.id),
      title: e.summary || '(no title)',
      start: e.start.dateTime as string,
      end: (e.end?.dateTime || e.start.dateTime) as string,
      attendees: ((e.attendees ?? []) as Array<Record<string, any>>)
        .map((a) => a.displayName || a.email)
        .filter(Boolean),
    }))
}
