/**
 * Shared plumbing for the farm-AI read-only NATS responders (PR-3).
 *
 * Every `request.farm.ai.*` responder method funnels through
 * {@link respondAiQuery} so the platform reply contract is enforced in ONE
 * place: guard-fail → `{ ok: false, error: 'INVALID_REQUEST' }` (no query
 * runs), handler throw → Logger.error + `{ ok: false, error:
 * 'INTERNAL_ERROR' }` (never a raw transport error into the model), success
 * → `{ ok: true, data }`. Responders NEVER touch the DB here — `handle` is
 * expected to be a QueryBus.execute (or the harvest-eligibility read
 * service); this file deliberately imports no DataSource/CommandBus.
 */
import { Logger } from '@nestjs/common';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
} from '@platform/event-contracts';

/**
 * Validate + execute + envelope one farm-AI query request.
 *
 * @param logger  responder-owned logger (context string should carry the
 *                subject so INTERNAL_ERROR lines are attributable).
 * @param payload raw NATS payload (unknown by contract).
 * @param isRequest runtime type guard from the event contract.
 * @param handle   read-only handler — QueryBus.execute / eligibility check.
 */
export async function respondAiQuery<TReq, TData>(
  logger: Logger,
  payload: unknown,
  isRequest: (v: unknown) => v is TReq,
  handle: (req: TReq) => Promise<TData>,
): Promise<AiQueryReply<TData>> {
  let request: TReq;
  try {
    if (!isRequest(payload)) {
      return { ok: false, error: 'INVALID_REQUEST' };
    }
    request = payload;
  } catch {
    return { ok: false, error: 'INVALID_REQUEST' };
  }

  try {
    return { ok: true, data: await handle(request) };
  } catch (err) {
    logger.error(
      `farm-AI query failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      err instanceof Error ? err.stack : undefined,
    );
    return { ok: false, error: 'INTERNAL_ERROR' };
  }
}

/**
 * Clamp a model-supplied list limit to the contract bounds
 * (1..MAX_LIST_LIMIT); invalid/absent values fall back to `fallback`
 * (normally DEFAULT_LIST_LIMIT). Guarantees `Math.min(limit, 50)`.
 */
export function clampListLimit(value: unknown, fallback: number): number {
  const candidate =
    typeof value === 'number' && Number.isInteger(value) ? value : fallback;
  return Math.min(
    Math.max(candidate, 1),
    FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT,
  );
}

/**
 * Project `rows` through the PURE `project` function, bounded to `limit`:
 * `items` carries at most `limit` projections, `truncated` flags that more
 * rows existed, and `total` defaults to the unbounded row count (callers
 * with a paged source pass their own total).
 */
export function toBoundedList<T, R>(
  rows: readonly T[],
  limit: number,
  project: (row: T) => R,
  total?: number,
): AiQueryList<R> {
  const bounded = Math.min(Math.max(limit, 1), FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
  const items = rows.slice(0, bounded).map(project);
  return {
    items,
    truncated: rows.length > bounded,
    total: total ?? rows.length,
  };
}

/** Dates cross the wire as ISO strings — never Date objects, never undefined. */
export function isoOrNull(
  date: Date | string | null | undefined,
): string | null {
  if (date === null || date === undefined) return null;
  if (date instanceof Date) {
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof date === 'string') {
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
