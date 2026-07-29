/** Strip Markdown/formatting so text reads naturally aloud (and displays clean).
 *  Removes bold/italic/code/heading/link/bullet syntax and stray symbols. */
export function cleanForSpeech(input: string): string {
  let t = input

  // Fenced code blocks → drop the fences, keep inner text
  t = t.replace(/```[a-zA-Z0-9]*\n?/g, '').replace(/```/g, '')
  // Images ![alt](url) → nothing
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  // Links [text](url) → text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Headings: leading #'s
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  // Blockquotes
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  // Bold/italic (**x**, *x*, __x__, _x_)
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/\*([^*]+)\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/(^|\s)_([^_]+)_(\s|$)/g, '$1$2$3')
  // Inline code `x`
  t = t.replace(/`([^`]+)`/g, '$1')
  // List bullets at line start (-, *, +, •)
  t = t.replace(/^\s{0,4}[-*+•]\s+/gm, '')
  // Any remaining stray markdown symbols
  t = t.replace(/[*`#~]/g, '')
  t = t.replace(/•/g, '')
  // Collapse whitespace
  t = t.replace(/[ \t]{2,}/g, ' ')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}
