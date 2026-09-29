import { FARM_AI_QUERY_LIMITS, toEventIso, type AiQueryList } from '@platform/event-contracts';

/**
 * Projection helpers shared by the farm AI read responders (FARM-MEDIUM-328).
 *
 * The responder skeleton itself (guard → tenant frame → tenant-bound envelope)
 * is `respondTenantBound` in `@aquaculture/backend-common/nats` — one skeleton
 * for every AI-facing subject in every service (K10 / MT-HIGH-062), so the
 * tenant a handler serves and the tenant its reply names cannot diverge.
 */

/**
 * Bound a row set to `limit` rows and flag the overflow. Callers pass the
 * full (or limit+1) row set so `truncated` is knowable; `total` is forwarded
 * when the source query counted it.
 */
export function toBoundedList<TRow, TDto>(
  rows: readonly TRow[],
  limit: number,
  project: (row: TRow) => TDto,
  total?: number,
): AiQueryList<TDto> {
  const cap = Math.min(Math.max(limit, 1), FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
  const items = rows.slice(0, cap).map(project);
  return {
    items,
    truncated: rows.length > cap || (total !== undefined && total > cap),
    ...(total !== undefined ? { total } : {}),
  };
}

/** ISO string or null for a nullable entity date/timestamp column. */
export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toEventIso(value);
}

/** Finite number or null for a nullable numeric column (TypeORM may hand back strings for decimals). */
export function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
