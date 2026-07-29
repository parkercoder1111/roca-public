import { describe, it, expect } from 'vitest'
import { getChromeUserAgent } from './session-config'

describe('getChromeUserAgent (default embedded-browser identity)', () => {
  it('presents real Chrome on macOS, matching the host OS', () => {
    // Regression: the default used to spoof Chrome OS (a hack for Slack's
    // signin block). That contradicted the real Mac — navigator.platform stays
    // "MacIntel", the GPU is Apple — so Cloudflare Turnstile flagged the
    // fingerprint and refused to load ("unsupported browser").
    const ua = getChromeUserAgent()
    expect(ua).toMatch(/Macintosh/)
    expect(ua).not.toMatch(/CrOS/)
    expect(ua).toMatch(/Chrome\/\d/)
  })
})
