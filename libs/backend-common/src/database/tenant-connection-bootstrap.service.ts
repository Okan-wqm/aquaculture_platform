import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRequestContext } from '../logging/request-context';
import { validateTenantSchemaName } from './schema-manager.service';
import { getPgPoolFromDataSource } from './pg-pool-from-data-source.util';
import { getTenantSchemaName, isValidUUID } from './tenant-schema.utils';

/**
 * Tenant schema regex — only matches tenant_<16 hex chars>.
 * Rejects source schemas (sensor, farm, hr, etc.) and public.
 */
const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;

/**
 * Factory: creates a service-specific TenantConnectionBootstrap class.
 *
 * Each multi-tenant service calls this once at import time:
 *   const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
 * The returned class is then registered as a NestJS provider.
 *
 * At startup the provider monkey-patches the pg Pool.connect() method so that
 * EVERY connection checkout has a deterministic, known-correct `search_path`:
 *
 *   - When a tenant context is present in AsyncLocalStorage, the search_path
 *     becomes `"tenant_<uuid>", <sourceSchema>, public` so per-request queries
 *     find tenant data first, falling back to the source schema for shared
 *     reference data. The checkout derives the schema from either
 *     `schemaName` or the canonical `tenantId` in AsyncLocalStorage; this keeps
 *     GraphQL/CQRS async hops tenant-routed even when an intermediate layer
 *     drops the middleware-derived schemaName field but preserves tenantId.
 *
 *   - When NO tenant context is present (non-request code paths: the NestJS
 *     bootstrap phase, SourceSchemaBootstrapService, MigrationRunnerService,
 *     seed services, cron jobs), the search_path becomes
 *     `<sourceSchema>, public`. This is the source-of-truth invariant for
 *     every non-request query in the service.
 *
 * # Why the non-request branch MUST also set search_path (root cause of
 *   an incident burned the whole of 2026-04-07)
 *
 * An earlier revision of this patch only set the search_path in the tenant
 * branch and fell through to "relies on pool startup option" for non-request
 * checkouts. The pool IS created with `options: '-c search_path=<src>,public'`
 * (e.g. `apps/farm-service/src/app.module.ts:227`), and PostgreSQL applies
 * that at the physical connection's startup message. But pg sessions are
 * mutable: anything that runs `SET search_path = public` on a pooled
 * connection contaminates that connection forever (until the pool evicts it).
 * Once contaminated, subsequent checkouts inherit the contaminated value.
 *
 * On the 2026-04-07 farm-service deploys (runs #830-#841), this produced a
 * schema split-brain: `SourceSchemaBootstrapService` happened to draw a clean
 * connection and synced 73 tables into `farm` schema, but
 * `MigrationRunnerService` drew a contaminated connection and ran every
 * subsequent migration with `current_schema() = 'public'`. The legacy
 * `public.*` tables from a long-deprecated initial synchronize were
 * discovered by `EnableRowLevelSecurity1776000000000` and its RLS policy
 * install failed with `operator does not exist: text = uuid` — the public-
 * schema duplicates had varchar tenantId while the RLS policy's
 * `COALESCE(..., '')::uuid` cast expected uuid.
 *
 * The correct architectural guarantee is: **every connection checked out of
 * the pool MUST have its search_path re-asserted before the caller receives
 * it, regardless of context**. This converts an implicit "startup option will
 * stick" contract into an explicit "every checkout is a reset" contract, at
 * the cost of one `SET` round-trip per checkout (~0.1ms on a local socket).
 * That cost is vastly outweighed by never again shipping a deploy with a
 * schema split-brain.
 */
export function createTenantConnectionBootstrap(sourceSchema: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(sourceSchema)) {
    throw new Error(`Invalid sourceSchema: "${sourceSchema}" — must be lowercase alphanumeric with underscores`);
  }

  @Injectable()
  class TenantConnectionBootstrapImpl implements OnModuleInit {
    readonly logger = new Logger(`TenantConnectionBootstrap[${sourceSchema}]`);

    constructor(readonly dataSource: DataSource) {}

    onModuleInit(): void {
      this.patchConnectionPool();
    }

    /** @internal */
    patchConnectionPool(): void {
      // DATA-LOW-001 cure: route through the canonical typed
      // adapter instead of an inline `dataSource.driver as any`
      // cast. The cast lives once, in one util, with a narrow
      // PgPoolLike interface — no leakage of TypeORM driver
      // internals into the bootstrap.
      // Throws when the driver has no usable pool. It used to log-and-return,
      // which let a schema-per-tenant service boot with search_path routing
      // inactive — every query then runs against the connection's default
      // search_path instead of tenant_<uuid>, which is the failure this
      // bootstrap exists to make impossible.
      const pool = getPgPoolFromDataSource(
        this.dataSource,
        `TenantConnectionBootstrap[${sourceSchema}]`,
      );

      const originalConnect = pool.connect.bind(pool);
      const src = sourceSchema;
      const defaultSearchPath = `SET search_path TO "${src}", public`;
      const logger = this.logger;

      // The wrapped function is polymorphic by construction — it
      // returns void on the callback-style path AND Promise on
      // the promise-style path. The PgPoolConnectFn surface
      // declares both overloads but TypeScript can't infer the
      // single-implementation polymorphic shape from the runtime
      // function value. Assign through a unknown-cast so the
      // narrow surface stays narrow at every consumer's read,
      // while the polymorphic implementation is allowed to
      // satisfy both call shapes.
      pool.connect = function (callback?: any) {
        if (typeof callback === 'function') {
          return originalConnect((err: any, client: any, done: any) => {
            if (err) return callback(err, client, done);

            let schemaName: string | undefined;
            try {
              const ctx = getRequestContext();
              schemaName = resolveTenantSchemaName(ctx?.schemaName, ctx?.tenantId);
            } catch {
              // Not in request context (migrations, startup) — use default
            }

            if (schemaName && TENANT_SCHEMA_REGEX.test(schemaName)) {
              /** SEC-M13: Validate schema name before SQL interpolation as defense-in-depth */
              validateTenantSchemaName(schemaName);
              client.query(
                `SET search_path TO "${schemaName}", "${src}", public`,
                (qErr: any) => {
                  if (qErr) {
                    logger.error(`Failed to set search_path to ${schemaName}: ${qErr.message}`);
                    done(qErr);
                    callback(qErr);
                    return;
                  }
                  callback(null, client, done);
                },
              );
            } else {
              // Non-request / bootstrap / migration context — re-assert the
              // source-schema default on every checkout so pool state
              // contamination (see the 2026-04-07 incident docblock above)
              // can never leak a `public`-schema current_schema() into
              // SourceSchemaBootstrap, MigrationRunner, or seed services.
              client.query(defaultSearchPath, (qErr: any) => {
                if (qErr) {
                  logger.error(`Failed to set default search_path (${src},public): ${qErr.message}`);
                  done(qErr);
                  callback(qErr);
                  return;
                }
                callback(null, client, done);
              });
            }
          });
        }

        // Promise style (fallback)
        return originalConnect().then(async (client: any) => {
          let schemaName: string | undefined;
          try {
            const ctx = getRequestContext();
            schemaName = resolveTenantSchemaName(ctx?.schemaName, ctx?.tenantId);
          } catch {
            // Not in request context
          }

          if (schemaName && TENANT_SCHEMA_REGEX.test(schemaName)) {
            try {
              /** SEC-M13: Validate schema name before SQL interpolation as defense-in-depth */
              validateTenantSchemaName(schemaName);
              await client.query(`SET search_path TO "${schemaName}", "${src}", public`);
            } catch (qErr) {
              logger.error(`Failed to set search_path to ${schemaName}: ${(qErr as Error).message}`);
              client.release(true); // release with error
              throw qErr;
            }
          } else {
            // Non-request / bootstrap / migration context — re-assert the
            // source-schema default. See the 2026-04-07 split-brain incident
            // docblock above for the full rationale.
            try {
              await client.query(defaultSearchPath);
            } catch (qErr) {
              logger.error(`Failed to set default search_path (${src},public): ${(qErr as Error).message}`);
              client.release(true); // release with error
              throw qErr;
            }
          }
          return client;
        });
      } as unknown as typeof pool.connect;

      this.logger.log(
        `PostgreSQL connection pool patched for tenant-aware search_path routing ` +
          `(default: "${src}",public on every non-request checkout)`,
      );
    }
  }

  return TenantConnectionBootstrapImpl;
}

function resolveTenantSchemaName(
  schemaName: string | undefined,
  tenantId: string | undefined,
): string | undefined {
  if (schemaName && TENANT_SCHEMA_REGEX.test(schemaName)) {
    return schemaName;
  }

  if (tenantId && isValidUUID(tenantId)) {
    return getTenantSchemaName(tenantId);
  }

  return undefined;
}
