import crypto from 'crypto'

export function randomHex(length: number): string {
  return crypto.randomBytes(length / 2).toString('hex')
}
