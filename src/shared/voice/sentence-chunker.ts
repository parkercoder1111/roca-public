/** Split a growing text buffer into complete sentences plus a leftover remainder.
 *  A sentence ends at . ! or ? (or a run of them) followed by whitespace or end-of-buffer.
 *  Used to flush TTS sentence-by-sentence as Claude's reply streams in. */
export function splitIntoSentences(buffer: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = []
  const re = /[^.!?]*[.!?]+(?=\s|$)/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(buffer)) !== null) {
    const s = m[0].trim()
    if (s) sentences.push(s)
    lastIndex = re.lastIndex
  }
  return { sentences, remainder: buffer.slice(lastIndex).replace(/^\s+/, '') }
}
