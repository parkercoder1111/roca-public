import { describe, it, expect } from 'vitest'
import { effectiveUserAgent } from './webview-tools'
import type { WebviewToolSpec } from './webview-tools'

const tool = (over: Partial<WebviewToolSpec>): WebviewToolSpec => ({
  kind: 'custom-x', label: 'X', hint: 'x', url: 'https://example.com',
  partition: 'persist:custom-x', iconUrl: '', ...over,
})

describe('effectiveUserAgent', () => {
  it('leaves ordinary custom tabs on the session default (undefined) so they present macOS Chrome', () => {
    // Regression: custom tabs used to inherit a Chrome OS UA, which contradicts
    // the real Mac and made Cloudflare Turnstile reject them as "unsupported".
    expect(effectiveUserAgent(tool({ url: 'https://app.mintlify.com/signup' }))).toBeUndefined()
  })

  it('gives Slack tabs the CrOS UA (the one identity Slack signin accepts)', () => {
    const ua = effectiveUserAgent(tool({ url: 'https://app.slack.com/client' }))
    expect(ua).toMatch(/CrOS/)
  })

  it('scopes the CrOS UA to slack.com only, not lookalike hosts', () => {
    expect(effectiveUserAgent(tool({ url: 'https://slack.com.evil.example/' }))).toBeUndefined()
    expect(effectiveUserAgent(tool({ url: 'https://notslack.com/' }))).toBeUndefined()
  })

  it('honours an explicit per-tool userAgent above everything else', () => {
    const forced = 'Mozilla/5.0 forced'
    expect(effectiveUserAgent(tool({ url: 'https://app.slack.com', userAgent: forced }))).toBe(forced)
  })
})
