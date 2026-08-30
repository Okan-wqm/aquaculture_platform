import { Injectable, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bootstrapSignalSchemas, platformFunctions } from '@platform/service-catalog';
import { DataSource } from 'typeorm';

import { PROTECTED_TABLES } from '../constants/protected-tables';

import { resolveDbMigrateAuthoritativeFromConfig } from './db-migrate-authority.util';
import { MIGRATION_LEDGER_TABLE, tenantMigrationLedgerTable } from './migration-ledger';
import { createMigrationRunnerService, type MigrationRunnerOptions } from './migration-runner';
import { TENANT_AWARE_SCHEMAS } from './tenant-aware-schemas';

/**
 * Release-ledger statuses that prove the release reached the point where
 * expected migration heads were written by aqua-db-migrate.
 *
 * A failed app health gate or failed image rollback must not erase that DB
 * truth from service boot checks. Restarting services still need to compare
 * their read-only ledger head against the last DB-complete release; the head
 * comparison below remains the fail-closed guard.
 */
const RELEASE_LEDGER_DB_COMPLETE_STATUSES = [
  'db_complete',
  'apps_restarting',
  'promoted',
  'failed',
  'rollback_attempted',
  'rollback_verified',
  'rollback_failed',
  'rolled_back',
] as const;

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
 *     queries `<schema>.migrations` to assert the ledger is at
 *     or past the build-time expected head. If the ledger is behind, it
 *     refuses service boot with a deterministic error pointing operators
 *     at the `aqua-db-migrate` container.
 *
 *     Rationale (Faz 1.5 of day-one baseline reset + ADR-033):
 *     two writer paths for migration ledgers is the architectural source of
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
 * SELECT MAX(timestamp) AS last_ts FROM <schema>.migrations
 * ```
 *
 * If the result is `null` (no rows), the schema has never been
 * migrated — the container is starting against a fresh database and
 * MUST refuse boot until `aqua-db-migrate` has finalised the baseline.
 *
 * The probe compares each `<schema>.migrations` head with the expected
 * head recorded by `aqua-db-migrate` in `platform.release_ledger`. The
 * expected head lives in the release ledger instead of in each service image
 * so the orchestrator remains the single source of truth for the release.
 *
 * For tenant-aware services we also probe every existing tenant schema
 * to catch the case where `db-migrate` migrated the source schema but
 * failed mid-fan-out. This is opt-in via `tenantAware: true` (auto-
 * detected from `TENANT_AWARE_SCHEMAS` for the standard services).
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

  const tenantAware = options?.tenantAware ?? TENANT_AWARE_SCHEMAS.has(sourceSchema);
  const forcedMode = options?.mode ?? 'auto';

  // The runner factory is invoked at module-init time so the resulting
  // class is available immediately for delegation. It's free of side
  // effects until `onApplicationBootstrap` fires.
  const DelegateRunner = createMigrationRunnerService(sourceSchema, options);

  @Injectable()
  class SchemaVersionGate implements OnApplicationBootstrap {
    private readonly logger = new Logger(`SchemaVersionGate[${sourceSchema}]`);

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

      const migrationsRun = this.configService.get<string>('DATABASE_MIGRATIONS_RUN', 'false');
      if (migrationsRun === 'true') {
        throw new Error(
          `SECURITY: DATABASE_MIGRATIONS_RUN=true is incompatible with ` +
            `DB_MIGRATE_AUTHORITATIVE=true on schema "${sourceSchema}". ` +
            `In gate mode, the per-service runner MUST NOT write to ` +
            `<schema>.${MIGRATION_LEDGER_TABLE} — aqua-db-migrate owns the ledger. ` +
            `Set DATABASE_MIGRATIONS_RUN=false or revert to legacy mode.`,
        );
      }

      // ADR-031 Platform Bootstrap probe — assert that the platform DDL
      // contract (extensions / roles / schemas / grants / functions /
      // shared-schema tables) was applied by the aqua-db-migrate Phase 0
      // atom. The bootstrap atom INSERTs a singleton row into
      // platform.bootstrap_signal on every successful run — its absence
      // means the platform DDL contract is not in place and a per-service
      // ledger probe below would either succeed against half-built state
      // or fail with a misleading error. Fail fast HERE with a precise
      // diagnostic before deeper probes.
      await this.probePlatformBootstrap();

      await this.probeSchema(sourceSchema, MIGRATION_LEDGER_TABLE);

      if (tenantAware) {
        const tenantSchemas = await this.listTenantSchemas();
        if (tenantSchemas.length === 0) {
          this.logger.log(`No tenant schemas present — source schema probe is sufficient`);
        } else {
          this.logger.log(`Probing ${tenantSchemas.length} tenant schema ledger(s)`);
          for (const tenantSchema of tenantSchemas) {
            await this.probeSchema(
              tenantSchema,
              tenantMigrationLedgerTable(sourceSchema),
              tenantSchema,
            );
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

      // Gate-specific hard rule (kept on top of the shared resolver):
      // an EXPLICIT opt-out is forbidden in production-like environments.
      // The shared resolver would honour `false`; for the migration
      // ledger that is an unacceptable two-writer regression, so it is
      // rejected here before the resolver is consulted.
      const explicit = this.configService.get<string>('DB_MIGRATE_AUTHORITATIVE');
      const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
      const aquaEnv = this.configService.get<string>('AQUA_ENV', nodeEnv);
      const isProductionLike =
        nodeEnv === 'production' || aquaEnv === 'production' || aquaEnv === 'staging';
      if (explicit === 'false' && isProductionLike) {
        throw new Error(
          `DB_MIGRATE_AUTHORITATIVE=false is forbidden for schema "${sourceSchema}" ` +
            `when NODE_ENV=${nodeEnv} AQUA_ENV=${aquaEnv}. ` +
            'Production/staging services must run in read-only schema gate mode.',
        );
      }

      // SSOT resolution (PR#363 design): strict-parse resolver — a
      // malformed DB_MIGRATE_AUTHORITATIVE value throws instead of
      // silently degrading to the environment default.
      return resolveDbMigrateAuthoritativeFromConfig(this.configService) ? 'gate' : 'runner';
    }

    /**
     * Probe platform.bootstrap_signal — the singleton row emitted by the
     * aqua-db-migrate Phase 0 atom (ADR-031). Service refuses boot if:
     *   - platform.bootstrap_signal table does not exist (atom never ran)
     *   - row absent (atom failed before INSERT ON CONFLICT)
     *   - schema_count diverges from the expected count (DDL contract
     *     drift since the last bootstrap run)
     *
     * Diagnostic is precise enough that an operator can act on it without
     * reading service logs — point them at the aqua-db-migrate container.
     */
    private async probePlatformBootstrap(): Promise<void> {
      let rows: Array<{
        last_run_at: Date | null;
        schema_count: number | null;
        function_count: number | null;
        shared_table_count: number | null;
        bootstrap_version: string | null;
      }>;
      try {
        rows = await this.dataSource.query(
          `SELECT last_run_at, schema_count, function_count, shared_table_count, bootstrap_version
             FROM platform.bootstrap_signal
            WHERE id = 1`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Platform bootstrap probe FAILED: ${msg}. ` +
            `The platform.bootstrap_signal table is missing or unreachable, which means ` +
            `aqua-db-migrate Phase 0 (ADR-031 platform bootstrap atom) has not completed ` +
            `successfully against this database. ` +
            `Service boot refused — confirm the aqua-db-migrate container exited 0 with ` +
            `the "Platform bootstrap complete" log line, then retry.`,
        );
      }

      const [row] = rows;
      if (!row) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] platform.bootstrap_signal has no row. ` +
            `The aqua-db-migrate Phase 0 atom did not finalise — service boot refused. ` +
            `Investigate the aqua-db-migrate container logs for "Platform bootstrap FAILED".`,
        );
      }

      // Count expectations are DERIVED from the platform-topology SSoT
      // (@platform/service-catalog) + PROTECTED_TABLES — never hand-copied
      // literals. WHY: on 2026-07-13 a hand-copied `EXPECTED_SHARED_TABLE_COUNT
      // = 5` crash-looped EVERY backend service when ADR-042 retired
      // shared.user_permissions (bootstrap honestly recorded 4, the gate still
      // demanded 5 — ORPHAN-HIGH-387). Its siblings `= 16` / `= 4` were the
      // same latent class (ORPHAN-HIGH-405); all three now derive from a
      // single source so a schema/function/table retirement can never leave a
      // stale literal behind.
      //
      // NOTE — this count check does NOT detect a real partial-apply: the
      // bootstrap writer refuses to write `bootstrap_signal` unless its counts
      // already equal its own expectation, so a present row is always complete
      // and `observed < EXPECTED` only ever fires on a stale gate literal (the
      // crash class above) or cross-image version skew. Genuine partial-apply
      // is caught by the writer's post-conditions + the replay DDL guard. The
      // value of deriving these is removing the stale-literal crash, not
      // strengthening detection.
      const EXPECTED_SCHEMA_COUNT = bootstrapSignalSchemas().length;
      const EXPECTED_FUNCTION_COUNT = platformFunctions().length;
      const EXPECTED_SHARED_TABLE_COUNT = PROTECTED_TABLES.filter((table) =>
        table.startsWith('shared.'),
      ).length;
      const observedSchema = row.schema_count ?? 0;
      const observedFn = row.function_count ?? 0;
      const observedSharedTbl = row.shared_table_count ?? 0;
      if (
        observedSchema < EXPECTED_SCHEMA_COUNT ||
        observedFn < EXPECTED_FUNCTION_COUNT ||
        observedSharedTbl < EXPECTED_SHARED_TABLE_COUNT
      ) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] platform.bootstrap_signal indicates a partial ` +
            `bootstrap: schema_count=${observedSchema} (expect ≥${EXPECTED_SCHEMA_COUNT}), ` +
            `function_count=${observedFn} (expect ≥${EXPECTED_FUNCTION_COUNT}), ` +
            `shared_table_count=${observedSharedTbl} (expect ≥${EXPECTED_SHARED_TABLE_COUNT}). ` +
            `Re-run aqua-db-migrate before retrying service boot.`,
        );
      }

      const bootstrapLastRunAt =
        row.last_run_at instanceof Date
          ? row.last_run_at.toISOString()
          : String(row.last_run_at ?? '(unset)');

      this.logger.log(
        `Platform bootstrap verified: schemas=${observedSchema}, functions=${observedFn}, ` +
          `sharedTables=${observedSharedTbl}, version=${row.bootstrap_version ?? '(unset)'}, ` +
          `lastRunAt=${bootstrapLastRunAt}`,
      );
    }

    /**
     * Probe a single schema's migrations ledger. Throws if the
     * ledger is empty, the table doesn't exist, or the query fails.
     */
    private async probeSchema(
      schema: string,
      ledgerTable: string,
      tenantSchema?: string,
    ): Promise<void> {
      // Schema identifier already validated at factory level OR
      // produced from tenant-schema regex match below. Re-asserting
      // the regex here defends against future code paths that might
      // call probeSchema with untrusted input.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Refusing unsafe schema name "${schema}"`,
        );
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ledgerTable)) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Refusing unsafe ledger table "${ledgerTable}"`,
        );
      }

      let rows: Array<{
        last_ts: string | null;
        last_name: string | null;
        row_count: string;
      }>;
      try {
        rows = await this.dataSource.query(
          `SELECT "timestamp"::text AS last_ts,
                  "name" AS last_name,
                  COUNT(*) OVER ()::text AS row_count
             FROM "${schema}"."${ledgerTable}"
            ORDER BY "timestamp" DESC, "id" DESC
            LIMIT 1`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Ledger probe FAILED on "${schema}": ${msg}. ` +
            `Likely cause: aqua-db-migrate has not run yet, or the ` +
            `"${schema}".${ledgerTable} table does not exist. ` +
            `Confirm the orchestrator container completed (boot signal "db_migrate_complete") ` +
            `before this service starts. Service boot refused.`,
        );
      }

      const [row] = rows;
      const lastTs = row?.last_ts ?? null;
      const lastName = row?.last_name ?? null;
      const rowCount = parseInt(row?.row_count ?? '0', 10);

      if (lastTs === null || lastName === null || rowCount === 0) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Ledger "${schema}"."${ledgerTable}" is EMPTY (rows=${rowCount}). ` +
            `aqua-db-migrate has not finalised the baseline. Service boot refused — ` +
            `wait for the orchestrator's "db_migrate_complete" signal before retrying.`,
        );
      }

      await this.probeReleaseLedgerExpectedHead(
        schema,
        {
          timestamp: lastTs,
          name: lastName,
        },
        tenantSchema,
      );

      this.logger.log(
        `Ledger probe on "${schema}"."${ledgerTable}": ${rowCount} migration(s) applied, last=${lastName}@${lastTs}`,
      );
    }

    private async probeReleaseLedgerExpectedHead(
      schema: string,
      actual: { timestamp: string; name: string },
      tenantSchema?: string,
    ): Promise<void> {
      if (tenantSchema !== undefined) {
        const rows: Array<{
          release_id: string;
          expected_ts: string | null;
          expected_name: string | null;
          source_ts: string | null;
          source_name: string | null;
          fanout_evidence: unknown;
        }> = await this.dataSource.query(
          `SELECT release_id,
                  expected_heads #>> ARRAY['tenants', $1, $2, 'timestamp'] AS expected_ts,
                  expected_heads #>> ARRAY['tenants', $1, $2, 'name'] AS expected_name,
                  expected_heads #>> ARRAY['schemas', $2, 'timestamp'] AS source_ts,
                  expected_heads #>> ARRAY['schemas', $2, 'name'] AS source_name,
                  tenant_fanout #> ARRAY[$2, 'tenants', $1] AS fanout_evidence
             FROM platform.release_ledger
            WHERE status = ANY($3::text[])
              AND expected_heads ? 'tenants'
            ORDER BY updated_at DESC, started_at DESC
            LIMIT 1`,
          [tenantSchema, sourceSchema, RELEASE_LEDGER_DB_COMPLETE_STATUSES],
        );
        const row = rows[0];
        if (!row) {
          throw new Error(
            `[SchemaVersionGate:${sourceSchema}] No release ledger row with tenant migration heads exists. ` +
              `Service boot refused because platform.release_ledger is the deployment SSoT. ` +
              `Run aqua-db-migrate tenant fan-out for this release before starting services.`,
          );
        }
        if (!row.expected_ts || !row.expected_name) {
          // ORPHAN-HIGH-410 — a tenant onboarded AFTER the newest release was
          // provisioned by the runtime tenant-schema-provisioner, so that
          // release row carries no per-tenant head for it. Refusing boot here
          // crash-loops every tenant-aware service on the next restart (OOM,
          // reschedule, reboot) until the following full deploy re-enumerates
          // all tenants. Instead DEGRADE: the provisioner replays the SAME
          // migrations as the source schema, so validate the tenant against the
          // release's SOURCE head. If it matches, the tenant is at the release's
          // migration level (correctly provisioned post-release) and boot is
          // allowed; a real lag still fails below. We deliberately do NOT write
          // this tenant into release_ledger from this runtime path — a non-deploy
          // context mutating the deployment SSoT could shadow the gate's
          // newest-row selection and crash-loop the fleet (the writer approach
          // rejected in review).
          if (!row.source_ts || !row.source_name) {
            throw new Error(
              `[SchemaVersionGate:${sourceSchema}] Release ${row.release_id} declares no source head for ` +
                `"${sourceSchema}", so a post-release tenant "${tenantSchema}" cannot be validated. Service boot refused.`,
            );
          }
          if (row.source_ts !== actual.timestamp || row.source_name !== actual.name) {
            throw new Error(
              `[SchemaVersionGate:${sourceSchema}] Post-release tenant "${tenantSchema}" is behind the release ` +
                `source head. release=${row.release_id} source-expected=${row.source_name}@${row.source_ts} ` +
                `actual=${actual.name}@${actual.timestamp}. Run aqua-db-migrate tenant fan-out for this tenant.`,
            );
          }
          this.logger.log(
            `Tenant "${tenantSchema}" was onboarded after release ${row.release_id}; validated against the ` +
              `source head ${row.source_name}@${row.source_ts} (no per-tenant head in the release row is expected).`,
          );
          return;
        }
        // Deploy-provisioned tenant: enforce the strict per-tenant head +
        // fan-out-evidence contract the deploy recorded.
        if (row.fanout_evidence === null || row.fanout_evidence === undefined) {
          throw new Error(
            `[SchemaVersionGate:${sourceSchema}] Release ${row.release_id} does not declare tenant fan-out ` +
              `evidence for "${tenantSchema}" source schema "${sourceSchema}". Service boot refused.`,
          );
        }
        if (row.expected_ts !== actual.timestamp || row.expected_name !== actual.name) {
          throw new Error(
            `[SchemaVersionGate:${sourceSchema}] Tenant ledger head mismatch on "${schema}". ` +
              `release=${row.release_id} expected=${row.expected_name}@${row.expected_ts} ` +
              `actual=${actual.name}@${actual.timestamp}. ` +
              `aqua-db-migrate did not apply the expected release head to this tenant schema.`,
          );
        }
        return;
      }

      const rows: Array<{
        release_id: string;
        expected_ts: string | null;
        expected_name: string | null;
      }> = await this.dataSource.query(
        `SELECT release_id,
                expected_heads #>> ARRAY['schemas', $1, 'timestamp'] AS expected_ts,
                expected_heads #>> ARRAY['schemas', $1, 'name'] AS expected_name
           FROM platform.release_ledger
          WHERE status = ANY($2::text[])
            AND expected_heads ? 'schemas'
          ORDER BY updated_at DESC, started_at DESC
          LIMIT 1`,
        [sourceSchema, RELEASE_LEDGER_DB_COMPLETE_STATUSES],
      );
      const row = rows[0];
      if (!row) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] No release ledger row with migration heads exists. ` +
            `Service boot refused because platform.release_ledger is the deployment SSoT. ` +
            `Run aqua-db-migrate for this release before starting services.`,
        );
      }
      if (!row.expected_ts || !row.expected_name) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Release ${row.release_id} does not declare an expected ` +
            `head for source schema "${sourceSchema}". Service boot refused.`,
        );
      }
      if (row.expected_ts !== actual.timestamp || row.expected_name !== actual.name) {
        throw new Error(
          `[SchemaVersionGate:${sourceSchema}] Ledger head mismatch on "${schema}". ` +
            `release=${row.release_id} expected=${row.expected_name}@${row.expected_ts} ` +
            `actual=${actual.name}@${actual.timestamp}. ` +
            `aqua-db-migrate did not apply the expected release head to this schema.`,
        );
      }
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
