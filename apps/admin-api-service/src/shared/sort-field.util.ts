/**
 * Pagination-bound guard (SEC-MEDIUM-072 / 2026-08-23 scan №17).
 *
 * Sort-column allowlisting lives with the entity that owns the columns —
 * `security/sorting/activity-log-sort.ts` and
 * `system-management/sorting/error-group-sort.ts` publish the sortable field
 * union plus the qualified-column map, and callers resolve through
 * `safeSortField`/`safeSortOrder` from `@aquaculture/backend-common/pagination`.
 * There is exactly one allowlist mechanism; this module owns only the limit
 * ceiling, which is orthogonal to it.
 */

/**
 * Clamp a client-supplied list limit. Uncapped `limit` flowing into
 * `.take(limit)` turns `limit=1e7` into a full-table scan plus in-memory
 * serialization of every row — authenticated DoS (№17).
 */
export function clampLimit(raw: number | string | undefined, fallback = 100, max = 100): number {
  const parsed: number = typeof raw === 'string' ? Number.parseInt(raw, 10) : (raw ?? Number.NaN);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}
