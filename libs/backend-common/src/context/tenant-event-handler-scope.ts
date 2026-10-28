import type { IEvent, IEventHandlerScope } from '@platform/event-bus';

import { isValidUUID } from '../database/tenant-schema.utils';

import { withTenantContext } from './with-tenant-context';

/**
 * The {@link IEventHandlerScope} of a tenant-scoped service (PLAT-HIGH-936).
 *
 * A NATS handler runs with no HTTP request behind it, so `TenantContextMiddleware`
 * never ran and the pg pool's checkout patch reads an empty AsyncLocalStorage
 * frame: `app.current_tenant` stays unset and every write to a row-level-security
 * table is refused (a read sees nothing). `withTenantContext` is the frame the
 * HTTP path builds; this scope builds the same frame from the event's own
 * `tenantId`, once, for every handler and for the dead-letter record of that
 * event, instead of each handler wrapping itself and a forgotten one failing
 * only at runtime on a real event.
 *
 * Bypass is never granted: the work sees the event tenant's rows and nobody
 * else's. An event with no valid tenant runs unscoped; the handlers already
 * reject it (a malformed tenant id is a terminate, not a retry).
 *
 * Bind it with `EventBusModule.forRootAsync({ handlerScope: { useFactory: () =>
 * new TenantEventHandlerScope() } })`; `tests/invariants/event-bus-handler-scope.spec.ts`
 * requires it of every service whose tables are tenant-bound.
 */
export class TenantEventHandlerScope implements IEventHandlerScope {
  run<T>(event: IEvent, work: () => Promise<T>): Promise<T> {
    const tenantId: unknown = event.tenantId;
    if (typeof tenantId !== 'string' || !isValidUUID(tenantId)) {
      return work();
    }
    return withTenantContext(tenantId, work);
  }
}
