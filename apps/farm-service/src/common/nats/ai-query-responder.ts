import { Logger } from '@nestjs/common';
import {
  FARM_AI_QUERY_LIMITS,
  toEventIso,
  type AiQueryList,
  type AiQueryReply,
  type AiQueryRequest,
  type FarmAiQuerySubject,
} from '@platform/event-contracts';

/**
 * The one responder skeleton for every farm AI read subject (FARM-MEDIUM-328):
 * guard the payload at the NATS trust boundary, run the handler, wrap the
 * outcome in the reply envelope. Never throws into the reply channel — a
 * malformed request is `INVALID_REQUEST`, a failure is `INTERNAL_ERROR`, and
 * the ai-service tool turns either into a visible tool error (not an empty
 * list). Tenant pinning is the handler's job (every farm query handler runs
 * inside runInTenantRead); this helper only validates that a tenant id is
 * present and well-formed.
 */
export async function respondAiQuery<TRequest extends AiQueryRequest, TData>(
  logger: Logger,
  subject: FarmAiQuerySubject,
  payload: unknown,
  isRequest: (value: unknown) => value is TRequest,
  handle: (request: TRequest) => Promise<TData>,
): Promise<AiQueryReply<TData>> {
  if (!isRequest(payload)) {
    logger.warn(`${subject} rejected: payload failed the contract guard`);
    return { ok: false, error: 'INVALID_REQUEST' };
  }
  try {
    return { ok: true, data: await handle(payload) };
  } catch (error) {
    logger.error(
      `${subject} failed for tenant ${payload.tenantId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, error: 'INTERNAL_ERROR' };
  }
}

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
