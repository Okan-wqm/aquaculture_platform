import { Injectable, Logger } from '@nestjs/common';

import {
  getRequestContext,
  requestContextStorage,
  RequestContext,
} from '../../logging/request-context';

/**
 * BypassRlsService
 * ============================================================================
 *
 * Scoped, auditable bypass mechanism for the tenant Row-Level Security
 * policy installed by `applyTenantRlsToSchema`.
 *
 * # When (and only when) bypass is appropriate
 *
 * 1. **admin-api-service controllers** — every endpoint there is gated by
 *    SUPER_ADMIN role. The handlers issue cross-tenant analytics queries
 *    (`SELECT COUNT(*) FROM auth.users`) that the policy would otherwise
 *    deny. Wrapping the entire request in `withBypass()` is the explicit,
 *    auditable way to grant that visibility.
 *
 * 2. **Background workers / cron jobs** — outbox publishers, retention
 *    policy workers, analytics aggregators all run outside any HTTP
 *    request, with no tenant context. They iterate tenants on their own
 *    (or process global tables like outbox), so RLS would otherwise drop
 *    every row.
 *
 * 3. **Migrations and bootstrap scripts** — schema-creation work runs as
 *    the table owner without a user context. RLS would deny seed data
 *    inserts. (Note: most migrations don't need bypass because they
 *    operate before policies are installed; this only matters for data
 *    backfill migrations after RLS is in place.)
 *
 * # When bypass is FORBIDDEN
 *
 * - Inside any tenant-scoped HTTP handler. Tenant users must NEVER trigger
 *   bypass — that would be a privilege-escalation channel. Code review
 *   should treat any `withBypass()` inside a non-admin module as a P0 bug.
 *
 * # How it works
 *
 * `withBypass()` enters a new `AsyncLocalStorage` frame with `bypassRls:
 * true` merged into the current request context. The `RlsConnectionBootstrap`
 * pool patch reads that frame on every connection checkout and emits
 * `set_config('app.bypass_rls', 'on', false)`, which the policy's USING
 * clause honours.
 *
 * Because the bypass lives in an AsyncLocalStorage frame, it is **strictly
 * scoped to the callback**: as soon as the callback returns (success or
 * throw), the previous context is restored. There is no manual cleanup
 * required and no risk of bypass leaking to a sibling request.
 *
 * # Audit trail
 *
 * Every `withBypass()` invocation logs at WARN level with the operation
 * label. WARN (not LOG) because bypass is an extraordinary operation and
 * should be visible in standard log dashboards without filtering. The label
 * is the caller-supplied operation name (e.g. `'admin-api:list-tenants'`,
 * `'outbox-worker:publish-batch'`) — meaningful enough to grep when
 * reviewing access patterns.
 *
 * @example
 * ```ts
 * // admin-api-service controller
 * @Get('tenants')
 * async listAllTenants() {
 *   return this.bypassRls.withBypass('admin-api:list-tenants', () =>
 *     this.tenantRepository.find(),
 *   );
 * }
 * ```
 *
 * @example
 * ```ts
 * // background job
 * await this.bypassRls.withBypass('outbox-worker:publish-batch', async () => {
 *   const pending = await this.outboxRepository.find({ where: { publishedAt: IsNull() } });
 *   for (const event of pending) {
 *     await this.publish(event);
 *   }
 * });
 * ```
 */

// WHY this service uses the main DataSource (not a separate admin DataSource):
// The bypass is scoped per-callback via AsyncLocalStorage, not per-connection.
// When `withBypass()` runs, it sets `bypassRls: true` in the AsyncLocalStorage
// frame. On connection checkout, `RlsConnectionBootstrap` reads this flag and
// emits `SET LOCAL app.bypass_rls = 'on'`. Because `SET LOCAL` is transaction-
// scoped and the flag lives in a strictly bounded AsyncLocalStorage frame,
// there is no risk of bypass leaking to other requests sharing the same
// connection pool. A separate DataSource would double the connection count
// (costly on edge hardware) for zero safety benefit.
@Injectable()
export class BypassRlsService {
  private readonly logger = new Logger(BypassRlsService.name);

  /**
   * Run `callback` with RLS bypass enabled. The bypass is restricted to the
   * async call tree rooted at the callback — sibling work continues with
   * the normal tenant filter.
   *
   * @param operation Short caller-defined label that appears in audit logs.
   *                  Use `service:action` form (e.g. `admin-api:list-tenants`).
   * @param callback  Work to perform under bypass. May be sync or async.
   * @returns Whatever `callback` returns.
   * @throws Re-throws any error from `callback` after the AsyncLocalStorage
   *         frame is automatically unwound.
   */
  async withBypass<T>(operation: string, callback: () => Promise<T> | T): Promise<T> {
    if (!operation || operation.length === 0) {
      // Refuse to grant bypass without an audit label. This is a deliberate
      // ergonomic friction — every bypass call site MUST be greppable.
      throw new Error('BypassRlsService.withBypass requires a non-empty operation label for audit');
    }

    const previous = getRequestContext();

    // Already in bypass — short-circuit. Re-entrant calls are common in
    // controllers that delegate to services that themselves call withBypass
    // for safety; we don't want to log each layer or pay the AsyncLocalStorage
    // cost twice. The audit log entry from the outermost call is enough.
    if (previous.bypassRls === true) {
      return await callback();
    }

    // Audit BEFORE the work runs so a crash inside the callback still leaves
    // a trail in the logs.
    this.logger.warn(
      `RLS BYPASS GRANTED [${operation}] ` +
        `(tenantId=${previous.tenantId ?? '∅'}, ` +
        `userId=${previous.userId ?? '∅'})`,
    );

    // Spread the existing context fields and overlay bypassRls. We must NOT
    // mutate the existing frame's object (other code paths still in flight
    // may be reading from it); AsyncLocalStorage.run() establishes a fresh
    // frame, which is what gives us the strict scoping guarantee.
    const next: RequestContext = { ...previous, bypassRls: true };

    return await requestContextStorage.run(next, async () => {
      try {
        return await callback();
      } finally {
        // No explicit cleanup needed — AsyncLocalStorage automatically
        // restores `previous` when this frame exits. We log the release for
        // symmetry with the grant log so paired entries are easy to follow
        // in audit reviews.
        this.logger.warn(`RLS BYPASS RELEASED [${operation}]`);
      }
    });
  }

  /**
   * Synchronous variant for code paths that cannot await (rare — most NestJS
   * code is async). Behaves identically except the callback signature.
   *
   * Avoid in HTTP controllers; use `withBypass` there. Provided primarily
   * for synchronous startup/bootstrap helpers.
   */
  withBypassSync<T>(operation: string, callback: () => T): T {
    if (!operation || operation.length === 0) {
      throw new Error(
        'BypassRlsService.withBypassSync requires a non-empty operation label for audit',
      );
    }

    const previous = getRequestContext();
    if (previous.bypassRls === true) {
      return callback();
    }

    this.logger.warn(
      `RLS BYPASS GRANTED [${operation}] (sync, ` +
        `tenantId=${previous.tenantId ?? '∅'}, ` +
        `userId=${previous.userId ?? '∅'})`,
    );

    const next: RequestContext = { ...previous, bypassRls: true };
    return requestContextStorage.run(next, () => {
      try {
        return callback();
      } finally {
        this.logger.warn(`RLS BYPASS RELEASED [${operation}] (sync)`);
      }
    });
  }
}
