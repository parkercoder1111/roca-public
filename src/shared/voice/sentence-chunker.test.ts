import { describe, it, expect } from 'vitest'
import { splitIntoSentences } from './sentence-chunker'

describe('splitIntoSentences', () => {
  it('emits complete sentences and keeps the trailing fragment as remainder', () => {
    const out = splitIntoSentences('Hello there. How are you today? I am fi')
    expect(out.sentences).toEqual(['Hello there.', 'How are you today?'])
    expect(out.remainder).toBe('I am fi')
  })

  it('returns no sentences when there is no terminal punctuation', () => {
    const out = splitIntoSentences('still going')
    expect(out.sentences).toEqual([])
    expect(out.remainder).toBe('still going')
  })

  it('treats ellipses and multiple marks as one sentence end', () => {
    const out = splitIntoSentences('Wait... really?! Okay then')
    expect(out.sentences).toEqual(['Wait...', 'really?!'])
    expect(out.remainder).toBe('Okay then')
  })

  it('does not emit on a bare newline without punctuation', () => {
    const out = splitIntoSentences('line one\nline two')
    expect(out.sentences).toEqual([])
    expect(out.remainder).toBe('line one\nline two')
  })
})
