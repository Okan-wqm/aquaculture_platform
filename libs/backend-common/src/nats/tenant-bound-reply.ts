/**
 * The responder half of the tenant-bound reply contract (K10 / PR-T1,
 * MT-HIGH-062). The envelope, its guard and the consumer check live in
 * `@platform/event-contracts` (tenant-bound-reply.ts).
 *
 * WHY one skeleton: the tenant a handler runs under (`withTenantContext`) and
 * the tenant written into the reply must come from the same variable. When
 * every AI-facing responder builds its own reply, nothing guarantees that; a
 * responder could serve one tenant and claim another, and the consumer's
 * check would compare against a claim instead of what was served.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import type { TenantBoundReply, TenantBoundRequest } from '@platform/event-contracts';

import { withTenantContext } from '../context/with-tenant-context';
import { isValidUUID } from '../database/tenant-schema.utils';

/** The tenant a raw payload names, when it names a valid one — echoed on guard failures. */
function servedTenantOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('tenantId' in payload)) return null;
  const { tenantId } = payload;
  return typeof tenantId === 'string' && isValidUUID(tenantId) ? tenantId : null;
}

/**
 * The one responder skeleton for every AI-facing request subject.
 *
 * WHAT: guard the payload at the NATS trust boundary, run the handler inside
 * the tenant's AsyncLocalStorage frame (ambient repositories resolve their
 * search_path + RLS GUC from it), and wrap the outcome in the tenant-bound
 * envelope. It never throws into the reply channel: a malformed request is
 * INVALID_REQUEST, a `NotFoundException` is NOT_FOUND (an id owned by another
 * tenant does not exist in this tenant's schema), anything else is
 * INTERNAL_ERROR.
 *
 * INVARIANT: the reply's `tenantId` is `request.tenantId`, the value handed to
 * `withTenantContext`; if violated → the consumer's tenant check is void.
 */
export async function respondTenantBound<TRequest extends TenantBoundRequest, TData>(
  logger: Logger,
  subject: string,
  payload: unknown,
  isRequest: (value: unknown) => value is TRequest,
  handle: (request: TRequest) => Promise<TData>,
): Promise<TenantBoundReply<TData>> {
  if (!isRequest(payload) || !isValidUUID(payload.tenantId)) {
    logger.warn({ msg: 'tenant-bound request rejected by the contract guard', subject });
    return { ok: false, tenantId: servedTenantOf(payload), error: 'INVALID_REQUEST' };
  }
  const servedTenantId = payload.tenantId;
  try {
    const data = await withTenantContext(servedTenantId, () => handle(payload));
    return { ok: true, tenantId: servedTenantId, data };
  } catch (error) {
    if (error instanceof NotFoundException) {
      return { ok: false, tenantId: servedTenantId, error: 'NOT_FOUND' };
    }
    logger.error({
      msg: 'tenant-bound request failed',
      subject,
      tenantId: servedTenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, tenantId: servedTenantId, error: 'INTERNAL_ERROR' };
  }
}
