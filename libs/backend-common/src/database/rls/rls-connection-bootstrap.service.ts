import { Injectable, Logger, OnModuleInit, Type } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { getRequestContext } from '../../logging/request-context';
import { getPgPoolFromDataSource, PgPoolClientLike } from '../pg-pool-from-data-source.util';

import { RLS_BYPASS_GUC, RLS_TENANT_GUC } from './apply-tenant-rls.helper';

/**
 * RlsConnectionBootstrap
 * ============================================================================
 *
 * Pool-level GUC injector that bridges the HTTP layer (`req.tenantId` →
 * `AsyncLocalStorage` → `RequestContext`) with the PostgreSQL session
 * variables (`app.current_tenant`, `app.bypass_rls`) that the
 * `tenant_isolation_policy` (installed by `applyTenantRlsToSchema`) consults
 * at query time.
 *
 * # Why a separate bootstrap from `TenantConnectionBootstrap`?
 *
 * `TenantConnectionBootstrap` exists for the **schema-per-tenant** services
 * (farm, sensor, hr, hydroponics, messaging) and patches the pg pool to
 * `SET search_path` per checkout. That bootstrap is production-critical and
 * we touch it at our peril.
 *
 * RLS is needed for **global-schema** services (billing, ai, notification,
 * alert, config, event-store) where every tenant's rows live in the same
 * tables. Those services do **not** instantiate `TenantConnectionBootstrap`,
 * so there's nothing to extend — we install our own pool patch.
 *
 * For services that DO use both (defense-in-depth), the patches **chain
 * cleanly**: each bootstrap captures the previous `pool.connect`, wraps it,
 * and reinstalls the wrapper. NestJS module initialization order is
 * deterministic (providers in declaration order), so as long as
 * `RlsConnectionBootstrap` is registered AFTER `TenantConnectionBootstrap`
 * the chain runs `search_path → set_config(app.current_tenant)` per
 * checkout. The opposite order also works — order only affects log
 * readability, not correctness, because each patch is idempotent and
 * commutative.
 *
 * # Why session-scope (`is_local = false`) instead of `SET LOCAL`?
 *
 * `SET LOCAL` is transaction-scoped — it expires on COMMIT/ROLLBACK. The pg
 * pool checks out a connection for an entire HTTP request which often spans
 * many tiny transactions and many implicit-transaction queries (autocommit).
 * `SET LOCAL` would only protect the first transaction.
 *
 * Session-scope `set_config(..., false)` lasts until the connection is reset
 * or the session ends. Because the patch fires on EVERY checkout, the next
 * request to grab this connection will overwrite the GUC before its first
 * query — there is no leakage window.
 *
 * # Failure mode: GUC unset
 *
 * If `getRequestContext()` returns nothing (background jobs, startup, raw
 * scripts), we **explicitly clear** `app.current_tenant` to the empty string
 * and `app.bypass_rls` to `'off'`. With those values, the policy's USING
 * clause:
 *
 *   bypass = 'off'  AND  tenantId = NULLIF('','')::uuid (= NULL)
 *
 * evaluates to UNKNOWN, which excludes all rows. **Deny-by-default** — a
 * forgotten `withRlsContext()` wrapper does not silently return another
 * tenant's data, it returns nothing, which is loud and immediately visible.
 *
 * @example
 * ```ts
 * // billing-service AppModule
 * import { createRlsConnectionBootstrap } from '@aquaculture/backend-common';
 *
 * const RlsConnectionBootstrap = createRlsConnectionBootstrap();
 *
 * @Module({
 *   imports: [TypeOrmModule.forRoot({ ... })],
 *   providers: [RlsConnectionBootstrap],
 * })
 * export class AppModule {}
 * ```
 */

/**
 * UUID v4 / v7 validation. Kept local so the bootstrap has zero runtime
 * dependencies on any service class.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single set_config call wrapping both GUCs in one round trip. We could send
 * two separate `SELECT set_config(...)` calls but folding them into one query
 * halves the per-checkout latency.
 *
 * Bound parameters protect against any conceivable injection — the values
 * still come from AsyncLocalStorage and are validated, but parameterizing is
 * defence-in-depth.
 */
const SET_RLS_GUCS_SQL =
  `SELECT ` +
  `set_config('${RLS_TENANT_GUC}', $1, false), ` +
  `set_config('${RLS_BYPASS_GUC}', $2, false)`;

type PoolConnectCallback = (
  error: Error | null,
  client?: PgPoolClientLike,
  release?: (error?: unknown) => void,
) => void;

/**
 * Factory: creates a service-specific `RlsConnectionBootstrap` class.
 *
 * Following the same convention as `createTenantConnectionBootstrap`, the
 * factory exists so each service can register its own provider class with a
 * distinguishable Logger context (useful when grepping aggregated logs to
 * see which service's pool was patched).
 *
 * @param serviceName - human-readable service tag for logs (e.g. 'billing')
 */
export function createRlsConnectionBootstrap(serviceName: string): Type<OnModuleInit> {
  if (!/^[a-z][a-z0-9_-]*$/.test(serviceName)) {
    throw new Error(
      `Invalid serviceName "${serviceName}" — must be lowercase, ` +
        `alphanumeric, hyphens or underscores only`,
    );
  }

  @Injectable()
  class RlsConnectionBootstrapImpl implements OnModuleInit {
    // Members are `readonly` (public-by-default) rather than `private` to
    // satisfy TS4094 — anonymous classes returned from factory functions
    // cannot expose private/protected members through the declaration
    // emitter. Same constraint applies to TenantConnectionBootstrap.
    readonly logger = new Logger(`RlsConnectionBootstrap[${serviceName}]`);

    constructor(readonly dataSource: DataSource) {}

    onModuleInit(): void {
      this.patchConnectionPool();
    }

    /** @internal */
    patchConnectionPool(): void {
      // DATA-LOW-001 cure: TypeORM driver-shape cast lives once
      // in libs/backend-common/src/database/pg-pool-from-data-source.util.ts.
      // Sister bootstrap (TenantConnectionBootstrap) uses the
      // same util — both stay in lockstep automatically.
      const pool = getPgPoolFromDataSource(this.dataSource);
      if (!pool) {
        const message =
          'Cannot patch connection pool — pg Pool not found on DataSource driver. ' +
          'RLS GUC propagation is INACTIVE, so this service cannot start safely. ' +
          'REMEDIATION: configure TypeOrmModule with an initialized PostgreSQL ' +
          'DataSource or register RlsModule.forBypassOnly for a pool-less service.';
        this.logger.error(message);
        throw new Error(message);
      }

      const originalConnect = pool.connect.bind(pool);
      const logger = this.logger;

      function patchedConnect(): Promise<PgPoolClientLike>;
      function patchedConnect(callback: PoolConnectCallback): void;
      function patchedConnect(callback?: PoolConnectCallback): Promise<PgPoolClientLike> | void {
        // ── Callback style ─────────────────────────────────────────────
        if (callback !== undefined) {
          originalConnect((error, client, release): void => {
            if (error) {
              callback(error, client, release);
              return;
            }
            if (!client || !release) {
              const poolError = new Error('PostgreSQL pool returned no client or release callback');
              logger.error(poolError.message);
              callback(poolError);
              return;
            }

            const { tenantId, bypass } = readRlsContext();

            void client
              .query(SET_RLS_GUCS_SQL, [tenantId, bypass])
              .then((): void => callback(null, client, release))
              .catch((queryFailure: unknown): void => {
                const queryError = toError(queryFailure);
                logger.error(
                  `Failed to set RLS GUCs (tenant=${tenantId || '∅'}, ` +
                    `bypass=${bypass}): ${queryError.message}`,
                );
                // Release the connection back to the pool with the
                // error flag so pg discards it instead of reusing a
                // potentially-half-configured connection.
                release(queryError);
                callback(queryError);
              });
          });
          return;
        }

        // ── Promise style ──────────────────────────────────────────────
        return originalConnect().then(async (client): Promise<PgPoolClientLike> => {
          const { tenantId, bypass } = readRlsContext();

          try {
            await client.query(SET_RLS_GUCS_SQL, [tenantId, bypass]);
          } catch (queryFailure) {
            const queryError = toError(queryFailure);
            logger.error(
              `Failed to set RLS GUCs (promise) ` +
                `(tenant=${tenantId || '∅'}, bypass=${bypass}): ` +
                queryError.message,
            );
            // Mark the connection as broken so pg destroys it rather than
            // returning it to the pool in an unknown state.
            client.release(queryError);
            throw queryError;
          }

          return client;
        });
      }
      pool.connect = patchedConnect;

      this.logger.log(
        'PostgreSQL connection pool patched for RLS GUC propagation ' +
          `(${RLS_TENANT_GUC}, ${RLS_BYPASS_GUC})`,
      );
    }
  }

  return RlsConnectionBootstrapImpl;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Read tenant + bypass values from AsyncLocalStorage and convert them into
 * the (string, string) tuple `set_config` expects.
 *
 * Returns the empty string when no tenant is in scope. The policy's
 * NULLIF(...)::uuid wrapper turns that into NULL, which makes the predicate
 * fail closed (no rows visible) — this is the deny-by-default behaviour.
 *
 * Returns 'on' or 'off' for bypass; the policy compares against the literal
 * string `'on'`, so anything else (including the absence of the flag) keeps
 * RLS enforced.
 *
 * Defensive against UUID-shaped attacks: even though the value comes from
 * trusted middleware, we re-validate the UUID format before propagating it
 * into a session GUC. A malformed value falls through to the empty-string
 * deny path rather than corrupting the GUC for the next request that
 * inherits the connection.
 *
 * @internal
 */
function readRlsContext(): { tenantId: string; bypass: 'on' | 'off' } {
  let tenantId = '';
  let bypass: 'on' | 'off' = 'off';

  try {
    const ctx = getRequestContext();
    if (ctx?.tenantId && UUID_REGEX.test(ctx.tenantId)) {
      tenantId = ctx.tenantId;
    }
    if (ctx?.bypassRls === true) {
      bypass = 'on';
    }
  } catch {
    // No request context (cron job, startup, raw script). Leave defaults —
    // empty tenant + bypass off → deny-by-default behaviour.
  }

  return { tenantId, bypass };
}
