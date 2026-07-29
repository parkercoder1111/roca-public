import { describe, it, expect } from 'vitest'
import { applySttCorrections } from './stt-corrections'

describe('applySttCorrections', () => {
  it('fixes coined-term casing', () => {
    expect(applySttCorrections('open roca')).toBe('open ROCA')
    expect(applySttCorrections('Roca and roca')).toBe('ROCA and ROCA')
  })

  it('leaves ordinary text untouched', () => {
    const s = 'what does the annual logo churn look like this quarter'
    expect(applySttCorrections(s)).toBe(s)
  })

  it('only matches whole words', () => {
    expect(applySttCorrections('rocafella')).toBe('rocafella') // not "ROCAfella"
  })
})
