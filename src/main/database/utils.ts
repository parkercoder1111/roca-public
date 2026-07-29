import { ACTIVE_STATUSES } from '../../shared/constants'

export function activeStatusClause(column = 'status'): string {
  const placeholders = ACTIVE_STATUSES.map(s => `'${s}'`).join(', ')
  return `${column} IN (${placeholders})`
}
