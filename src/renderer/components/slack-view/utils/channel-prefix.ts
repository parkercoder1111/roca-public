interface SlackChannel {
  id: string
  name: string
  isIm: boolean
  isMpim: boolean
  isChannel: boolean
  isPrivate: boolean
}

export function channelPrefix(ch: SlackChannel): string {
  if (ch.isIm || ch.isMpim) return ''
  if (ch.isPrivate) return '\u{1F512} '
  return '# '
}
