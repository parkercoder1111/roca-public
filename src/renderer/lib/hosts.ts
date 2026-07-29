// Hosts a terminal tab can run on. `local` runs on this machine; any other id
// is treated as an SSH alias resolved by mosh against ~/.ssh/config.
//
// The picker now loads SSH aliases at runtime via `window.electronAPI.listSshHosts()`
// instead of hardcoding them, so this file only carries the constants the
// rest of the renderer needs to render host badges.

// The hardcoded "Cloud" environment shipped in v1 of the host picker. Points
// at a generic remote host; future versions can promote this to a
// configurable list.
export const DEFAULT_CLOUD_HOST = 'remote'

export function isRemoteHost(host: string | undefined | null): boolean {
  return !!host && host !== 'local'
}

// Short label used by the terminal tab strip's host badge. Long names get
// truncated since the badge has tight horizontal space.
export function hostLabel(host: string | undefined | null): string {
  if (!host || host === 'local') return 'Local'
  return host
}
