/**
 * The one chokepoint every `request.<module>.recentWriterIds` responder answers through (PKG-06
 * readiness; ADR-051 §3).
 *
 * WHY: three owner modules answer the same question from three different audit trails. The
 * decode, the caller decision, the bound on the answer and the error shape are the same for all
 * three and must not drift, so they live here; each responder supplies only how its module
 * counts, inside the tenant the admitted request names.
 *
 * WHAT: `answerRecentWriterIds` admits the request (INVALID_REQUEST / FORBIDDEN before any read),
 * hands only an admitted request to the module's count — which reads inside the asked tenant's
 * read-only boundary (runInTenantRead with `request.tenantId`) — and answers the count. A count
 * that is not an integer between 0 and the number of ids asked about, or a failed read, is
 * INTERNAL_ERROR, logged with the module and the error type only — never an id.
 * `readWriterCount` reads the `writers` column of the one row a counting query returns.
 */
import { Logger } from '@nestjs/common';
import {
  admitRecentWriterIdsRequest,
  type RecentWriterIdsReply,
  type RecentWriterIdsRequest,
} from '@platform/event-contracts';
import type { ActiveOwnerModuleCode } from '@aquaculture/shared-contracts';

/**
 * How a module counts the asked ids that wrote to it within the window, reading inside
 * `request.tenantId`'s boundary.
 */
export type RecentWriterCount = (request: RecentWriterIdsRequest) => Promise<number>;

const logger = new Logger('RecentWriterIds');

export async function answerRecentWriterIds(
  module: ActiveOwnerModuleCode,
  value: unknown,
  count: RecentWriterCount,
): Promise<RecentWriterIdsReply> {
  const admission = admitRecentWriterIdsRequest(module, value);
  if (!admission.admitted) return admission.reply;
  const { request } = admission;
  let counted: number;
  try {
    counted = await count(request);
  } catch (error) {
    logger.error(
      JSON.stringify({
        event: 'recent_writer_ids_read_failed',
        module,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    return { ok: false, error: 'INTERNAL_ERROR' };
  }
  if (!Number.isInteger(counted) || counted < 0 || counted > request.userIds.length) {
    logger.error(JSON.stringify({ event: 'recent_writer_ids_count_out_of_range', module }));
    return { ok: false, error: 'INTERNAL_ERROR' };
  }
  return { ok: true, data: { recentWriterCount: counted } };
}

/** The `writers` column of the one row a counting query returns; anything else throws. */
export function readWriterCount(rows: unknown): number {
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const writers: unknown =
    typeof row === 'object' && row !== null ? Reflect.get(row, 'writers') : undefined;
  if (typeof writers !== 'number' || !Number.isInteger(writers)) {
    throw new TypeError('recent writer count: the query returned no integer `writers` column');
  }
  return writers;
}
