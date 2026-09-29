/**
 * The responder half of the tenant-bound reply contract (K10 / PR-T1,
 * MT-HIGH-062). The envelope, its guard and the consumer check live in
 * `@platform/event-contracts` (tenant-bound-reply.ts).
 *
 * WHY the skeleton owns the data boundary: when each responder opened its own
 * read, the reply named the tenant the REQUEST asked for, not the tenant whose
 * rows were read. A handler that read on another connection, or changed the
 * search_path of its own, could answer `{ tenantId: A, data: <B's rows> }` and
 * the consumer's check would pass. Here one function opens the boundary, hands
 * the handler the only data handle it gets, resolves every id the request
 * names inside that boundary, and names in the reply the tenant read back from
 * the connection that served it.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import type { TenantBoundReply, TenantBoundRequest } from '@platform/event-contracts';

import type { TenantScope, TenantScopeAccess } from '../database/tenant-scope';
import { isValidUUID } from '../database/tenant-schema.utils';

import {
  resolveTenantOwnedRows,
  undeclaredIdFields,
  type TenantOwnerRegistry,
} from './tenant-owned-rows';

/** Opens the tenant boundary for one request (`TenantScope.read` / `.write` bound to a DataSource). */
export type TenantScopeOpener = <T>(
  tenantId: string,
  access: TenantScopeAccess,
  fn: (scope: TenantScope) => Promise<T>,
) => Promise<T>;

/**
 * The request as the handler sees it: without its tenant. The handler reads
 * the tenant from its scope, so it has no tenant string it could pass on.
 */
export type TenantFreeRequest<TRequest> = Omit<TRequest, 'tenantId'>;

/** One AI-facing subject: its guard and its handler. */
export interface TenantBoundSubject<TRequest extends TenantBoundRequest, TData> {
  readonly subject: string;
  readonly isRequest: (value: unknown) => value is TRequest;
  /** `read` (default): READ ONLY boundary. `write`: the one AI actuation path (createTask). */
  readonly access?: TenantScopeAccess;
  readonly handle: (request: TenantFreeRequest<TRequest>, scope: TenantScope) => Promise<TData>;
}

/** What a service wires once for all of its AI-facing responders. */
export interface TenantBoundResponderDeps {
  readonly logger: Logger;
  readonly openScope: TenantScopeOpener;
  /** request field → the table its id must be a row of (every `*Id` field needs one). */
  readonly owners: TenantOwnerRegistry;
}

/** The tenant a raw payload names, when it names a valid one — echoed on guard failures. */
function requestedTenantOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('tenantId' in payload)) return null;
  const { tenantId } = payload;
  return typeof tenantId === 'string' && isValidUUID(tenantId) ? tenantId : null;
}

/** An id the request named is not a row of the tenant the connection served. */
class ScopedNotFound extends Error {
  constructor(readonly servedTenantId: string | null) {
    super('not found in the served tenant');
  }
}

/** The connection that served the handler serves a tenant other than the requested one. */
class ServedTenantMismatch extends Error {
  constructor(readonly servedTenantId: string | null) {
    super('the connection served another tenant');
  }
}

/** Separate the tenant from the fields the handler may see. */
function splitTenant<TRequest extends TenantBoundRequest>(
  request: TRequest,
): TenantFreeRequest<TRequest> {
  const { tenantId: _tenantId, ...fields } = request;
  return fields;
}

/**
 * The one responder skeleton for every AI-facing request subject.
 *
 * WHAT, in order:
 *   1. guard the payload at the NATS trust boundary (INVALID_REQUEST);
 *   2. refuse a request with an `*Id` field the service declared no owner for;
 *   3. open the tenant boundary (read-only unless the subject writes) and, on
 *      its connection, resolve every id the request names to a row of the
 *      tenant — an id that is not one is NOT_FOUND before the handler runs;
 *   4. run the handler with the tenant-free request and the scope;
 *   5. read the served tenant back from that same connection; if it is not
 *      the requested tenant the data is dropped (and a write rolled back);
 *   6. reply in the tenant-bound envelope. It never throws into the reply channel.
 *
 * INVARIANT: a reply that carries data or a NOT_FOUND verdict names the tenant
 * read back from the connection that produced it, and carries data only when
 * that tenant is the requested one. A failure that read nothing
 * (INVALID_REQUEST, INTERNAL_ERROR) names the requested tenant; it carries no
 * data. If violated → the consumer compares against a claim, not against
 * what was served.
 */
export async function respondTenantBound<TRequest extends TenantBoundRequest, TData>(
  deps: TenantBoundResponderDeps,
  spec: TenantBoundSubject<TRequest, TData>,
  payload: unknown,
): Promise<TenantBoundReply<TData>> {
  const { logger, openScope, owners } = deps;
  const { subject } = spec;
  if (!spec.isRequest(payload) || !isValidUUID(payload.tenantId)) {
    logger.warn({ msg: 'tenant-bound request rejected by the contract guard', subject });
    return { ok: false, tenantId: requestedTenantOf(payload), error: 'INVALID_REQUEST' };
  }
  const requestedTenantId = payload.tenantId;
  const fields = splitTenant(payload);
  const undeclared = undeclaredIdFields(fields, owners);
  if (undeclared.length > 0) {
    logger.error({ msg: 'request names an id with no declared owner table', subject, undeclared });
    return { ok: false, tenantId: requestedTenantId, error: 'INVALID_REQUEST' };
  }

  try {
    const { data, servedTenantId } = await openScope(
      requestedTenantId,
      spec.access ?? 'read',
      async (scope) => {
        let data: TData;
        try {
          await resolveTenantOwnedRows(scope, fields, owners);
          data = await spec.handle(fields, scope);
        } catch (error) {
          if (error instanceof NotFoundException) {
            throw new ScopedNotFound(await scope.readServedTenant());
          }
          throw error;
        }
        const servedTenantId = await scope.readServedTenant();
        // Throwing here rolls a write back and keeps foreign rows out of the reply.
        if (servedTenantId !== requestedTenantId) throw new ServedTenantMismatch(servedTenantId);
        return { data, servedTenantId };
      },
    );
    return { ok: true, tenantId: servedTenantId, data };
  } catch (error) {
    if (error instanceof ScopedNotFound && error.servedTenantId === requestedTenantId) {
      return { ok: false, tenantId: error.servedTenantId, error: 'NOT_FOUND' };
    }
    if (error instanceof ScopedNotFound || error instanceof ServedTenantMismatch) {
      logger.error({
        msg: 'tenant-bound request served by a connection of another tenant — reply withheld',
        subject,
        requestedTenantId,
        servedTenantId: error.servedTenantId,
      });
      return { ok: false, tenantId: error.servedTenantId, error: 'INTERNAL_ERROR' };
    }
    logger.error({
      msg: 'tenant-bound request failed',
      subject,
      tenantId: requestedTenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, tenantId: requestedTenantId, error: 'INTERNAL_ERROR' };
  }
}
