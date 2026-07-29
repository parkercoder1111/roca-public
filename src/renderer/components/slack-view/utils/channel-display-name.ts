interface SlackChannel {
  id: string
  name: string
  isIm: boolean
  isMpim: boolean
  isChannel: boolean
  isPrivate: boolean
  userId?: string
  topic?: string
  purpose?: string
  unreadCount?: number
  displayName?: string
  avatarUrl?: string
}

export function channelDisplayName(ch: SlackChannel): string {
  if (ch.displayName) return ch.displayName
  if (ch.isIm) {
    const raw = ch.name || ch.userId
    if (!raw) return 'Direct Message'
    // Slack IM ch.name is the counterpart's user ID when displayName isn't populated yet.
    // Show placeholder until persistentUserMapRef resolves it.
    if (/^[UW][A-Z0-9]{6,}$/.test(raw)) return 'Direct Message'
    return raw
  }
  if (ch.isMpim) return (ch.name || '').replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ')
  return ch.name
}
