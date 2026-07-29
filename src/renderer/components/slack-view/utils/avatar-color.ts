import { hashCode } from './hash-code'

const AVATAR_COLORS = ['#E91E63', '#9C27B0', '#3F51B5', '#009688', '#FF5722', '#795548']

export function avatarColor(userId: string): string {
  return AVATAR_COLORS[hashCode(userId) % AVATAR_COLORS.length]
}
