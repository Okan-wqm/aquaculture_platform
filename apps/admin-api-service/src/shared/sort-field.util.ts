/**
 * Sort-field and pagination-bound guards (SEC-HIGH №1/№17 — 2026-08-23 scan).
 *
 * TypeORM `orderBy(expr, order)` interpolates the expression verbatim; a
 * client-controlled `sortBy` reaching it is SQL injection (ORDER BY carries
 * expression syntax, not just column names). The shared resolver makes the
 * allowlisted path the zero-effort default: callers pass the sortable
 * columns of the queried entity, everything else falls back — and the DTO
 * `@IsIn` layers above reject unknown values outright at validation time.
 */
export function resolveSortField(
  candidate: string | undefined,
  allowed: readonly string[],
  fallback: string,
): string {
  if (!candidate) return fallback;
  return allowed.includes(candidate) ? candidate : fallback;
}

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
