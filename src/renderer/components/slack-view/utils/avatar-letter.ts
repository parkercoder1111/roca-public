export function avatarLetter(name: string): string {
  return (name || '?').charAt(0).toUpperCase()
}
