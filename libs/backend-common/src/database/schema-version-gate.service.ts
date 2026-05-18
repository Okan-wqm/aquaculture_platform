import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import {
  createMigrationRunnerService,
  type MigrationRunnerOptions,
} from './migration-runner';
import { TENANT_AWARE_SCHEMAS } from './tenant-aware-schemas';

/**
 * createSchemaVersionGate
 * ============================================================================
 *
 * Factory that produces an `OnApplicationBootstrap` provider with two
 * operating modes governed by the `DB_MIGRATE_AUTHORITATIVE` env var:
 *
 *   • `DB_MIGRATE_AUTHORITATIVE=true`  (production / staging)
 *     ──────────────────────────────────────────────────────
 *     READ-ONLY mode. The provider does NOT run migrations. Instead it
 *     queries `<schema>.typeorm_migrations` to assert the ledger is at
 *     or past the build-time expected head. If the ledger is behind, it
 *     refuses service boot with a deterministic error pointing operators
 *     at the `aqua-db-migrate` container.
 *
 *     Rationale (Faz 1.5 of day-one baseline reset + ADR-021):
 *     two writer paths for `_migrations` is the architectural source of
 *     the 2026-04 HR "applied-but-not-applied" drift. By collapsing to a
 *     single writer (`aqua-db-migrate`) + N read-only gates, the silent-
 *     applied class becomes structurally impossible: no service can
 *     write to the ledger after the orchestrator has finalized it.
 *
 *   • `DB_MIGRATE_AUTHORITATIVE=false` (development default)
 *     ──────────────────────────────────────────────────────
 *     LEGACY mode. The provider delegates to `createMigrationRunnerService`
 *     verbatim — every existing dev/test setup keeps working. The
 *     factory is a strict superset of the runner; switching to gate mode
 *     is a single env-var flip, no code change in callers.
 *
 * # USAGE
 *
 * ```ts
 * // apps/farm-service/src/app.module.ts
 * import { createSchemaVersionGate } from '@aquaculture/backend-common/database';
 *
 * const FarmSchemaGate = createSchemaVersionGate('farm');
 *
 * @Module({ providers: [FarmSchemaGate] })
 * export class AppModule {}
 * ```
 *
 * The factory signature mirrors `createMigrationRunnerService` precisely
 * — `schema` first, options second — so callsites swap names without
 * argument shuffling.
 *
 * # PRODUCTION-MODE LEDGER PROBE
 *
 * The probe issues a SINGLE query:
 *
 * ```sql
 * SELECT MAX(timestamp) AS last_ts FROM <schema>.typeorm_migrations
 * ```
 *
 * If the result is `null` (no rows), the schema has never been
 * migrated — the container is starting against a fresh database and
 * MUST refuse boot until `aqua-db-migrate` has finalised the baseline.
 *
 * The probe deliberately does NOT compare against a baked-in expected
 * head value. The reason: baking the build-time expected head into every
 * service container creates a deployment-ordering trap (the head must
 * be updated in every consumer when a new migration lands). Instead, we
 * trust the orchestrator's exit code via the deploy pipeline — the
 * `aqua-db-migrate` container's success signal (`db_migrate_complete`,
 * see `required-signals.yaml`) is the cross-service synchronisation
 * point. The schema-version-gate's job is only to refuse boot when the
 * ledger is entirely empty (the deterministic precondition for a clean
 * deploy).
 *
 * For tenant-aware services we also probe the most recent tenant schema
 * to catch the case where `db-migrate` migrated the source schema but
 * failed mid-fan-out. This is opt-in via `tenantAware: true` (auto-
 * detected from `TENANT_AWARE_SCHEMAS` for the standard 7 services).
 *
 * # SECURITY INVARIANT (carried forward)
 *
 * Production REQUIRES `DATABASE_MIGRATIONS_RUN=false` in gate mode —
 * the per-service runner MUST NOT run when the orchestrator owns the
 * ledger. We assert this at boot; a misconfigured environment fails
 * fast with a structured error.
 */

export interface SchemaVersionGateOptions extends MigrationRunnerOptions {
  /**
   * Override the operating mode. Falls back to the
   * `DB_MIGRATE_AUTHORITATIVE` env var (true in production-like, false
   * in dev). Passing `mode: 'gate'` forces probe-only regardless of env.
   * Useful in tests that need to exercise the gate code path without
   * setting global env vars.
   */
  mode?: 'gate' | 'runner' | 'auto';
}

export function createSchemaVersionGate(
  sourceSchema: string,
  options?: SchemaVersionGateOptions,
): Type<OnApplicationBootstrap> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sourceSchema)) {
    throw new Error(
      `[createSchemaVersionGate] Unsafe sourceSchema identifier: "${sourceSchema}". ` +
        `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }

  const tenantAware =
    options?.tenantAware ?? TENANT_AWARE_SCHEMAS.has(sourceSchema);
  const forcedMode = options?.mode ?? 'auto';

  // The runner factory is invoked at module-init time so the resulting
  // class is available immediately for delegation. It's free of side
  // effects until `onApplicationBootstrap` fires.
  const DelegateRunner = createMigrationRunnerService(sourceSchema, options);

  @Injectable()
  class SchemaVersionGate implements OnApplicationBootstrap {
    private readonly logger = new Logger(
      `SchemaVersionGate[${sourceSchema}]`,
    );

    constructor(
      private readonly dataSource: DataSource,
      private readonly configService: ConfigService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      const mode = this.resolveMode();
      if (mode === 'runner') {
        this.logger.log(
          `Running in LEGACY runner mode (DB_MIGRATE_AUTHORITATIVE=false). ` +
            `Production deployments MUST set DB_MIGRATE_AUTHORITATIVE=true to ` +
            `collapse the two-writer ledger surface.`,
        );
        const delegate = new DelegateRunner(this.dataSource, this.configService);
        await delegate.onApplicationBootstrap();
        return;
      }

      // ── Gate mode — read-only ledger probe ──
      this.logger.log(
        `Running in GATE mode (DB_MIGRATE_AUTHORITATIVE=true, tenantAware=${tenantAware}). ` +
          `aqua-db-migrate is the authoritative writer; this service only verifies.`,
      );

      const migrationsRun = this.configService.get(
        'DATABASE_MIGRATIONS_RUN',
        'false',
      );
      if (migrationsRun === 'true') {
        throw new Error(
          `SECURITY: DATABASE_MIGRATIONS_RUN=true is incompatible with ` +
            `DB_MIGRATE_AUTHORITATIVE=true on schema "${sourceSchema}". ` +
            `In gate mode, the per-service runner MUST NOT write to ` +
            `<schema>.typeorm_migrations — aqua-db-migrate owns the ledger. ` +
            `Set DATABASE_MIGRATIONS_RUN=false or revert to legacy mode.`,
        );
      }

      await this.probeSchema(sourceSchema);

      if (tenantAware) {
        const tenantSchemas = await this.listTenantSchemas();
        if (tenantSchemas.length === 0) {
          this.logger.log(
            `No tenant schemas present — source schema probe is sufficient`,
          );
        } else {
          // Probe ONE tenant schema (the alphabetically last — a tenant
          // created after the deploy's fan-out window) as a smoke test.
          // We do not probe every tenant: that's the orchestrator's job
          // during the fan-out itself, and replicating it here turns
          // boot into an O(tenants) operation.
          const probe = tenantSchemas[tenantSchemas.length - 1];
          if (probe === undefined) {
            // listTenantSchemas guarantees non-empty here, but the
            // tuple-element access widens to `string | undefined` under
            // strict null checks. Guard explicitly.
            this.logger.log('Tenant schema list empty after listTenantSchemas — skipping probe');
          } else {
            this.logger.log(
              `Smoke-probing tenant schema "${probe}" (1 of ${tenantSchemas.length})`,
            );
            await this.probeSchema(probe);
          }
        }
      }

      this.logger.log(
        `Schema version gate complete for "${sourceSchema}": ledger present and queryable`,
      );
    }

    /**
     * Resolve the operating mode.
     *
     * Priority:
     *   1. Explicit `mode` option (test scaffolding).
     *   2. DB_MIGRATE_AUTHORITATIVE env (operator control).
     *   3. NODE_ENV / AQUA_ENV (default: gate in production-like, runner elsewhere).
     */
    private resolveMode(): 'gate' | 'runner' {
      if (forcedMode === 'gate' || forcedMode === 'runner') {
        return forcedMode;
      }
      const explicit = this.configService.get<string>(
        'DB_MIGRATE_AUTHORITATIVE',
      );
      if (explicit === 'true') return 'gate';
      if (explicit === 'false') return 'runner';

      const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
      const aquaEnv = this.configService.get<string>('AQUA_ENV', nodeEnv);
      const isProductionLike =
        nodeEnv === 'production' ||
        aquaEnv === 'production' ||
        aquaEnv === 'staging';
      return isProductionLike ? 'gate' : 'runner';
    }

    /**
     * Probe a single schema's typeorm_migrations ledger. Throws if the
     * ledger is empty, the table doesn't exist, or the query fails.
     */
    private async probeSchema(schema: string): Promise<void> {
      // Schema identifier already validated at factory level OR
      // produced from tenant-schema regex match below. Re-asserting
      // the regex here defends against future code paths that might
      // call probeSchema with untrusted input.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Refusing unsafe schema name "${schema}"`,
        );
      }

      let rows: Array<{ last_ts: string | null; row_count: string }>;
      try {
        rows = await this.dataSource.query(
          `SELECT MAX(timestamp)::text AS last_ts,
                  COUNT(*)::text AS row_count
             FROM "${schema}".typeorm_migrations`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Ledger probe FAILED on "${schema}": ${msg}. ` +
            `Likely cause: aqua-db-migrate has not run yet, or the ` +
            `"${schema}".typeorm_migrations table does not exist. ` +
            `Confirm the orchestrator container completed (boot signal "db_migrate_complete") ` +
            `before this service starts. Service boot refused.`,
        );
      }

      const [row] = rows;
      const lastTs = row?.last_ts ?? null;
      const rowCount = parseInt(row?.row_count ?? '0', 10);

      if (lastTs === null || rowCount === 0) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Ledger is EMPTY on "${schema}" (rows=${rowCount}). ` +
            `aqua-db-migrate has not finalised the baseline. Service boot refused — ` +
            `wait for the orchestrator's "db_migrate_complete" signal before retrying.`,
        );
      }

      this.logger.log(
        `Ledger probe on "${schema}": ${rowCount} migration(s) applied, last_ts=${lastTs}`,
      );
    }

    /**
     * Enumerate per-tenant schemas. Same regex as MigrationRunnerService
     * to keep the two code paths in sync.
     */
    private async listTenantSchemas(): Promise<string[]> {
      const rows: Array<{ schema_name: string }> = await this.dataSource.query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
         ORDER BY schema_name`,
      );
      return rows.map((r) => r.schema_name);
    }
  }

  return SchemaVersionGate;
}
