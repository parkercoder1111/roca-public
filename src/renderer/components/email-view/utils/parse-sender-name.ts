function decodeRfc2047(str: string): string {
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (orig, charset, encoding, encoded) => {
    try {
      let bytes: Uint8Array
      if (encoding.toUpperCase() === 'B') {
        const bin = atob(encoded)
        bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      } else {
        const qp = encoded.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        bytes = new Uint8Array(qp.length)
        for (let i = 0; i < qp.length; i++) bytes[i] = qp.charCodeAt(i)
      }
      return new TextDecoder(charset).decode(bytes)
    } catch {
      return orig
    }
  })
}

export function parseSenderName(from: string): string {
  const decoded = decodeRfc2047(from)
  const match = decoded.match(/^(.+?)\s*</)
  if (match) return match[1].trim().replace(/^"|"$/g, '')
  return decoded.replace(/[<>]/g, '').trim()
}
