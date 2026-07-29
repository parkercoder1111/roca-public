import { describe, it, expect } from 'vitest'
import { cleanForSpeech } from './clean-speech'

describe('cleanForSpeech', () => {
  it('strips bold and italic markers', () => {
    expect(cleanForSpeech('**On your calendar today:** Kevin Wilson at *10:30*'))
      .toBe('On your calendar today: Kevin Wilson at 10:30')
  })

  it('removes heading hashes and bullets', () => {
    expect(cleanForSpeech('# Summary\n- first item\n- second item'))
      .toBe('Summary\nfirst item\nsecond item')
  })

  it('keeps link text, drops the url', () => {
    expect(cleanForSpeech('See [the doc](https://x.com/y) now')).toBe('See the doc now')
  })

  it('strips inline code backticks', () => {
    expect(cleanForSpeech('run `npm test` please')).toBe('run npm test please')
  })

  it('leaves plain prose untouched', () => {
    expect(cleanForSpeech('Just a normal sentence.')).toBe('Just a normal sentence.')
  })

  it('removes stray asterisks and hashes', () => {
    expect(cleanForSpeech('$1.5K/mo ** and #tags')).toBe('$1.5K/mo and tags')
  })
})
