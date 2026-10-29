// Global slot alone cannot establish effective per-pool authorization.
export function permissionLabel(value) {
  return value === true ? 'present' : value === false ? 'not present' : 'unknown';
}
export function pendingLabel(rows) {
  return Array.isArray(rows) ? `${rows.length} (first 100 only; indexer may lag)` : 'unavailable';
}
