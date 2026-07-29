import type { Session } from 'electron'
import path from 'path'

// Absolute path to the renderer-side preload that spoofs
// navigator.userAgentData inside every guest webview. Lives next to
// session-config.js in the compiled output, so __dirname resolves correctly
// both in dev and in the packaged app.
const WEBVIEW_PRELOAD_PATH = path.join(__dirname, 'webview-preload.js')

// ROCA's default embedded-browser identity: real Chrome on macOS. It matches
// the actual host OS, so the UA string, Sec-CH-UA client hints,
// navigator.platform ("MacIntel"), and the GPU all agree with one another.
// That internal consistency is what Cloudflare Turnstile and similar bot
// checks demand — an identity that contradicts the real environment gets
// rejected as an "unsupported browser," breaking CAPTCHAs and signups.
//
// (An earlier default spoofed Chrome OS — the one UA that gets past Slack's
// signin block. But a CrOS identity contradicts the real Mac, so every
// Turnstile-protected page failed. Slack now carries that CrOS UA scoped to
// its own tab — see effectiveUserAgent() in webview-tools.ts — letting the
// default stay honest.)
export function getChromeUserAgent(): string {
  const chromeVersion = process.versions.chrome || '130.0.0.0'
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

// Sec-CH-UA-* client hints must agree with the UA string of the request that
// carries them — a mismatch is exactly what bot checks flag. Both the brand
// version and the platform are derived from the request's own User-Agent, so a
// macOS UA yields macOS hints and the Slack tab's CrOS UA yields CrOS hints,
// automatically.
function chromeMajorFromUA(ua: string | undefined): string {
  return (ua?.match(/Chrome\/(\d+)/)?.[1]) || (process.versions.chrome || '130').split('.')[0]
}

function brandListForMajor(major: string): string {
  return `"Chromium";v="${major}", "Not?A_Brand";v="99", "Google Chrome";v="${major}"`
}

function platformHintForUA(ua: string | undefined): string {
  return ua && /CrOS/.test(ua) ? '"Chrome OS"' : '"macOS"'
}

// Strips the headers that prevent embedding in webviews / iframes.
//   X-Frame-Options: SAMEORIGIN/DENY → blocks the entire response from being
//     rendered inside a <webview>.
//   Content-Security-Policy: frame-ancestors → blocks iframes; required for
//     Apps Script panels, OAuth consent screens, Drive picker, etc. that
//     load nested iframes inside the host webview.
const stripFrameHeaders = (
  details: Electron.OnHeadersReceivedListenerDetails,
  callback: (response: Electron.HeadersReceivedResponse) => void,
) => {
  const headers = { ...details.responseHeaders }
  for (const key of Object.keys(headers)) {
    const lk = key.toLowerCase()
    if (lk === 'x-frame-options') {
      delete headers[key]
    }
    if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
      const vals = headers[key]
      if (vals) {
        headers[key] = vals
          .map(v => v.replace(/frame-ancestors\s+[^;]+(;|$)/gi, '').trim())
          .filter(Boolean)
      }
    }
  }
  callback({ cancel: false, responseHeaders: headers })
}

export interface BrowserSessionOptions {
  // Optional getter for a Slack user/bot token — when present, the bearer is
  // injected on outbound requests to files.slack.com / files-pri.slack.com so
  // private image/file URLs render inline. Only the default (renderer)
  // session uses this; guest webview sessions don't need it.
  getSlackBearer?: () => string | undefined
}

// Configure a session so its webContents behave like vanilla Chrome inside
// ROCA — Chrome UA, Chrome client hints, frame headers stripped. Idempotent:
// safe to call on the same session more than once (e.g. defaultSession at
// startup AND each guest webview as it attaches).
const configured = new WeakSet<Session>()

export function configureBrowserSession(s: Session, options: BrowserSessionOptions = {}): void {
  if (configured.has(s)) return
  configured.add(s)
  s.setUserAgent(getChromeUserAgent())
  s.webRequest.onHeadersReceived(stripFrameHeaders)

  // Register the userAgentData preload alongside any preload Electron is
  // already loading for this session (don't blow them away).
  const existingPreloads = s.getPreloads()
  if (!existingPreloads.includes(WEBVIEW_PRELOAD_PATH)) {
    s.setPreloads([...existingPreloads, WEBVIEW_PRELOAD_PATH])
  }

  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers: Record<string, string | string[]> = { ...details.requestHeaders }

    // Derive the client hints from THIS request's own User-Agent so they
    // always agree with whatever UA the tab is presenting (macOS by default,
    // Chrome OS for the Slack tab). A UA/hint mismatch is what trips bot checks.
    const uaEntry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')
    const ua = typeof uaEntry?.[1] === 'string' ? uaEntry[1] : undefined
    const brand = brandListForMajor(chromeMajorFromUA(ua))
    const platform = platformHintForUA(ua)

    // Rewrite Chrome client hints whenever the request would have carried
    // them (Chromium only sends Sec-CH-UA on secure contexts to allow-listed
    // hosts, so the keys may or may not be present). When present, force
    // them to look like vanilla Chrome.
    for (const key of Object.keys(headers)) {
      const lk = key.toLowerCase()
      if (lk === 'sec-ch-ua' || lk === 'sec-ch-ua-full-version-list') {
        headers[key] = brand
      } else if (lk === 'sec-ch-ua-mobile') {
        headers[key] = '?0'
      } else if (lk === 'sec-ch-ua-platform') {
        headers[key] = platform
      }
    }

    if (options.getSlackBearer && (
      details.url.startsWith('https://files.slack.com/') ||
      details.url.startsWith('https://files-pri.slack.com/')
    )) {
      const token = options.getSlackBearer()
      if (token) headers['Authorization'] = `Bearer ${token}`
    }

    callback({ cancel: false, requestHeaders: headers })
  })
}
