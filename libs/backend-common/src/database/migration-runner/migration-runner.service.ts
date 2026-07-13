import { Injectable, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Migration, MigrationExecutor, MigrationInterface, QueryRunner } from 'typeorm';

import { assertExpandContractDependency } from '../assert-expand-contract-dependency';
import {
  NoopMigrationEventSink,
  type MigrationEventSink,
  type MigrationSinkEventType,
} from '../migration-event-sink';
import {
  MIGRATION_LEDGER_TABLE,
  tenantMigrationLedgerTable,
} from '../migration-ledger';
import {
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE as TENANT_SCHEMA_RE,
} from '../tenant-aware-schemas';
import { isSourceOnlyMigration } from '../tenant-fanout.decorator';

/**
 * Optional post-condition probe contract for TypeORM migrations.
 *
 * # Why this exists (Faz 1.1 of the day-one baseline reset)
 *
 * The 2026-04 HR drift incident (`apps/hr-service/src/database/migrations/
 * 1786900000000-HealHrEnumTypeDrift.ts:14` — "SAVEPOINT-per-statement
 * band-aid swallowed the ALTER") demonstrated that TypeORM's
 * `MigrationExecutor.executeMigration()` will INSERT a row into
 * `_migrations` (ledger says applied) even when the DDL never actually
 * landed — most commonly when:
 *
 *   - the migration body uses SAVEPOINT/ROLLBACK TO SAVEPOINT internally;
 *   - a `transaction = false` CONCURRENTLY DDL fails partially after the
 *     ledger row is already committed in a separate tx;
 *   - a swallowed-exception PL/pgSQL block silently no-ops.
 *
 * The architectural fix is a **post-condition barrier**: every migration
 * MAY declare `postCondition(qr)` returning a boolean. The runner calls
 * it AFTER `executeMigration()` returns but BEFORE the wrapper transaction
 * commits. If the probe returns `false` or throws, the runner rolls back
 * AND propagates the failure — the ledger row never commits and the
 * deploy aborts cleanly. The drift cannot enter the ledger silently.
 *
 * # Adoption
 *
 * The method is OPTIONAL — backwards-compatible with every existing
 * migration. New migrations that touch high-blast-radius surfaces
 * (audit immutability triggers, RLS policies, enum type drift, FK
 * additions, NOT NULL transitions on populated tables) SHOULD declare
 * a `postCondition` that asserts the DDL really landed via an
 * `information_schema` lookup.
 *
 * Banned-SAVEPOINT invariant (`tests/invariants/no-savepoint-in-migrations.spec.ts`)
 * already requires an `-- ALLOWS-SAVEPOINT: <reason>` marker to use
 * SAVEPOINT — reviewers MUST also require a `postCondition` on any such
 * migration.
 *
 * # Contract
 *
 *   - Returns `true` / `undefined` / void → success, runner commits.
 *   - Returns `false` → runner rolls back with a structured error.
 *   - Throws → runner rolls back and re-throws (error chained via `cause`).
 *
 * The probe runs INSIDE the wrapper transaction, so any SELECTs against
 * the in-flight DDL see the uncommitted state — the standard
 * `information_schema` lookup against post-DDL shape works without
 * extra coordination.
 */
export interface PostConditionAwareMigration {
  /**
   * Optional post-condition probe. Called by `MigrationRunnerService`
   * after `executeMigration()` returns successfully but before the
   * wrapper transaction commits. Return `false` or throw to abort.
   */
  postCondition?(queryRunner: QueryRunner): Promise<unknown>;
}

/**
 * createMigrationRunnerService
 * ============================================================================
 *
 * Factory that produces an `OnApplicationBootstrap` NestJS provider which
 * runs pending TypeORM migrations — first on the caller-specified source
 * schema, then (for services that own per-tenant schemas) on every
 * `tenant_<uuid16>` schema that matches this service's ownership set.
 *
 * # Why a factory (instead of a generic class)
 *
 * NestJS DI requires providers to be classes with decorators baked in at
 * import time. A generic class parametrised by schema name via a
 * constructor argument forces every service to wire the schema name
 * through its DI module configuration — noisy and easy to get wrong.
 * A factory that captures `sourceSchema` in a closure and returns a
 * service-specific class preserves the one-liner ergonomics while still
 * being schema-aware.
 *
 * # Source-schema invariants (pre-existing, unchanged)
 *
 *   - Session-level `search_path` pin before the first migration (not
 *     `SET LOCAL` — must survive the BEGIN/COMMIT cycles that
 *     `MigrationExecutor` issues in `transaction: 'each'` mode).
 *   - Re-assert the pin before every migration's `up()` so one migration's
 *     `SET search_path` leak can't poison the next (the 2026-04-07
 *     farm-service incident).
 *   - Per-migration transaction: partial failures rollback cleanly.
 *
 * # Tenant-aware fan-out (added for the schema-per-tenant services)
 *
 * Services listed in `TENANT_AWARE_SCHEMAS` own per-tenant schema clones
 * named `tenant_<uuid16>`. A migration that adds a new column to the
 * source schema (e.g. `farm.daily_feeding_executions`) must also land in
 * every existing tenant's copy, or tenant queries start failing with
 * "column does not exist". Historically this required the migration
 * author to hand-roll a schema-discovery loop inside `up()` — most
 * migrations didn't, silently drifting tenant schemas from source.
 *
 * This runner closes the gap architecturally: after the source schema is
 * migrated, it lists every `tenant_*` schema and runs the same migration
 * set against each. Source schemas use the canonical `migrations` ledger;
 * tenant schemas use `migrations_<sourceSchema>` so multiple tenant-aware
 * services can each record `Baseline1800000000000` without colliding. The
 * fan-out is idempotent — already-applied migrations on a tenant are skipped
 * by `MigrationExecutor.getPendingMigrations()` on the next boot, so the
 * cost is near-zero after the first deploy.
 *
 * Advisory lock is per-schema (source and each tenant), so two services
 * booting concurrently can fan out without stepping on each other.
 *
 * Shared-schema services (`auth`, `billing`, `notification`, `config`,
 * `admin`) keep the old single-schema behaviour — no tenant loop.
 *
 * # Usage
 *
 * ```ts
 * // apps/farm-service/src/database/database.module.ts
 * import { createMigrationRunnerService } from '@aquaculture/backend-common/migration-runner';
 *
 * const FarmMigrationRunnerService = createMigrationRunnerService('farm');
 * //                                                                ^^^^
 * //                                    Auto-detected as tenant-aware.
 *
 * @Module({ providers: [FarmMigrationRunnerService] })
 * export class DatabaseModule {}
 * ```
 *
 * Opt OUT of fan-out via the options bag if needed:
 *
 * ```ts
 * createMigrationRunnerService('farm', { tenantAware: false })  // source only
 * ```
 *
 * Opting IN (`tenantAware: true`) is only legal for schemas already in
 * the `TENANT_AWARE_SCHEMAS` SSoT — the factory throws otherwise. A
 * platform-level schema (auth, billing, …) that fanned out would mint a
 * stray `migrations_<schema>` journal inside every `tenant_<uuid>` schema
 * (live incident ORPHAN-MEDIUM-386: `tenant_7f6b08ab….migrations_auth`).
 * Making a schema genuinely schema-per-tenant is a one-line edit to
 * `libs/backend-common/src/database/tenant-aware-schemas.ts`, which this
 * factory then honors automatically.
 *
 * # SECURITY invariant preserved
 *
 * In production, `DATABASE_MIGRATIONS_RUN=false` hard-fails boot. Schema
 * migrations are mandatory for at-least-once schema delivery; running a
 * service without applying pending migrations risks querying tables that
 * don't yet have their expected columns.
 */

// TENANT_AWARE_SCHEMAS + tenant-schema regex come from the SSoT module
// (MA6). Local duplicates here, in the orchestrator, and in the
// schema-propagation invariant test were prone to drift; the SSoT
// export makes them impossible to diverge.
export interface MigrationRunnerOptions {
  /**
   * Explicit override for tenant fan-out. When omitted, defaults to
   * `true` for `sourceSchema` in `TENANT_AWARE_SCHEMAS`, else `false`.
   */
  tenantAware?: boolean;
  /** Advisory-lock acquisition timeout per schema. Default 300 s. */
  lockTimeoutSeconds?: number;
  /**
   * Optional lifecycle-event sink (Phase 6). When supplied, the
   * runner emits start/applied/failed events per migration to enable
   * observability-service's durable audit trail.
   *
   * Defaults to `NoopMigrationEventSink` when omitted — every
   * existing caller's behaviour is preserved. Callers MUST NOT pass
   * a sink that throws; see MigrationEventSink docblock for the
   * fire-and-forget contract.
   */
  eventSink?: MigrationEventSink;
}

type MigrationTarget =
  Parameters<typeof assertExpandContractDependency>[0]['migrationClass'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rowsFromQueryResult(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function booleanColumn(
  rows: readonly Record<string, unknown>[],
  column: string,
): boolean {
  return rows[0]?.[column] === true;
}

function stringColumn(
  row: Record<string, unknown> | undefined,
  column: string,
): string | null {
  const value = row?.[column];
  return typeof value === 'string' ? value : null;
}

const migrationRunnerCompletions = new Map<string, Promise<unknown>>();

export function getMigrationRunnerCompletion(
  sourceSchema: string,
): Promise<unknown> | undefined {
  return migrationRunnerCompletions.get(sourceSchema);
}

export function createMigrationRunnerService(
  sourceSchema: string,
  options?: MigrationRunnerOptions,
): Type<OnApplicationBootstrap> {
  // Validate at factory-call time — this identifier is interpolated directly
  // into SQL below, so it's the only line between a misconfigured caller and
  // a SQL-injection vector.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sourceSchema)) {
    throw new Error(
      `[createMigrationRunnerService] Unsafe sourceSchema identifier: "${sourceSchema}". ` +
        `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }

  // WHY (ORPHAN-MEDIUM-386): tenant fan-out records progress in a
  // per-source journal named `migrations_<sourceSchema>` INSIDE each
  // tenant schema. Only schemas in the TENANT_AWARE_SCHEMAS SSoT own
  // per-tenant clones, so a manual `tenantAware: true` on any other
  // schema would mint stray journals in every tenant schema (the exact
  // artifact found live: `tenant_7f6b08ab90e246d3.migrations_auth`).
  // Make the misconfiguration impossible at factory time instead of
  // detectable at deploy time.
  if (options?.tenantAware === true && !TENANT_AWARE_SCHEMAS.has(sourceSchema)) {
    throw new Error(
      `[createMigrationRunnerService] tenantAware=true is illegal for source schema ` +
        `"${sourceSchema}" — it is not in the TENANT_AWARE_SCHEMAS SSoT ` +
        `(libs/backend-common/src/database/tenant-aware-schemas.ts). Fanning a ` +
        `platform-level schema out to tenant_<uuid> schemas would create a stray ` +
        `"${tenantMigrationLedgerTable(sourceSchema)}" journal in every tenant schema ` +
        `(ORPHAN-MEDIUM-386). If this schema is genuinely becoming schema-per-tenant, ` +
        `add it to the SSoT set first.`,
    );
  }

  const tenantAware =
    options?.tenantAware ?? TENANT_AWARE_SCHEMAS.has(sourceSchema);
  const lockTimeoutSeconds = options?.lockTimeoutSeconds ?? 300;
  const eventSink: MigrationEventSink =
    options?.eventSink ?? new NoopMigrationEventSink();

  @Injectable()
  class MigrationRunnerService implements OnApplicationBootstrap {
    private readonly logger = new Logger(
      `MigrationRunnerService[${sourceSchema}]`,
    );

    constructor(
      private readonly dataSource: DataSource,
      private readonly configService: ConfigService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      const completion = this.runMigrations();
      migrationRunnerCompletions.set(sourceSchema, completion);
      await completion;
    }

    private async runMigrations(): Promise<void> {
      const runnerEnabledOverride = this.configService.get<string>(
        'MIGRATION_RUNNER_ENABLED',
      );
      const enabled =
        runnerEnabledOverride !== undefined
          ? runnerEnabledOverride === 'true'
          : this.configService.get('DATABASE_MIGRATIONS_RUN', 'true') ===
            'true';
      const isProduction = this.configService.get('NODE_ENV') === 'production';

      if (!enabled && isProduction) {
        // SECURITY: hard-fail boundary — production MUST run migrations.
        throw new Error(
          'SECURITY: DATABASE_MIGRATIONS_RUN must not be false in production. ' +
            'Schema migrations are mandatory for safe rollouts.',
        );
      }

      if (!enabled) {
        this.logger.warn(
          'Skipping migrations because MIGRATION_RUNNER_ENABLED=false or ' +
            'DATABASE_MIGRATIONS_RUN=false (non-production only)',
        );
        return;
      }

      // ── Phase 1 — source schema (always) ──
      this.logger.log(
        `Phase 1: migrating source schema "${sourceSchema}" (tenantAware=${tenantAware})`,
      );
      await this.runForSchema(sourceSchema, MIGRATION_LEDGER_TABLE);

      // ── Phase 2 — tenant schemas (only for tenant-aware services) ──
      let tenantCount = 0;
      if (tenantAware) {
        const tenantSchemas = await this.listTenantSchemas();
        tenantCount = tenantSchemas.length;
        if (tenantSchemas.length === 0) {
          this.logger.log(
            'Phase 2: no tenant schemas present — skipping tenant fan-out',
          );
        } else {
          this.logger.log(
            `Phase 2: fanning out to ${tenantSchemas.length} tenant schema(s)`,
          );
          for (const tenantSchema of tenantSchemas) {
            // Defense-in-depth: listTenantSchemas already filters via regex,
            // but we re-assert before SQL interpolation.
            if (!TENANT_SCHEMA_RE.test(tenantSchema)) {
              throw new Error(
                `[MigrationRunner:${sourceSchema}] Refusing unsafe tenant ` +
                  `schema name "${tenantSchema}" — expected /${TENANT_SCHEMA_RE.source}/.`,
              );
            }
            await this.runForSchema(
              tenantSchema,
              tenantMigrationLedgerTable(sourceSchema),
            );
          }
        }
      }

      // Canonical local end-of-run log for the legacy in-process runner.
      // Fires on EVERY successful runner completion regardless of whether
      // any migration was actually applied — a warm-start path where
      // db-migrate already applied every pending DDL still emits this.
      // The pre-existing "Applied N migration(s)" / "No pending migrations"
      // logs only fire on the per-schema hot path; they don't represent
      // the runner-as-a-whole completing. Production deploys use the
      // structured db_migrate_complete boot signal emitted by apps/db-migrate;
      // required-signals.yaml is generated from BOOT_INVARIANT_SIGNALS.
      this.logger.log(
        `Migration runner complete for schema "${sourceSchema}": tenants=${tenantCount}`,
      );
    }

    /**
     * Thin wrapper around eventSink.emit — swallows sink errors so a
     * broken sink never propagates to the runner. Tenant fan-out sets
     * tenantSchema only when schema !== sourceSchema (the per-tenant
     * clone case); source-schema lifecycle events carry no tenantSchema.
     */
    private emit(
      schema: string,
      migrationName: string,
      eventType: MigrationSinkEventType,
      durationMs?: number,
      error?: unknown,
    ): void {
      try {
        const ev = {
          serviceName: sourceSchema,
          migrationName,
          eventType,
          occurredAt: new Date(),
          ...(schema !== sourceSchema ? { tenantSchema: schema } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(error !== undefined ? { error } : {}),
        };
        const maybePromise = eventSink.emit(ev);
        if (maybePromise !== undefined && typeof maybePromise.then === 'function') {
          // Sink returns a Promise — fire-and-forget; swallow rejections
          // so they don't surface as unhandled-promise-rejection crashes.
          void maybePromise.catch(() => {
            // Swallow — sink failure MUST NOT impact the runner.
          });
        }
      } catch {
        // Synchronous sink throw — swallow, never propagate.
      }
    }

    /**
     * Query information_schema for every per-tenant schema.
     */
    private async listTenantSchemas(): Promise<string[]> {
      const rows: Array<{ schema_name: string }> = await this.dataSource.query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
         ORDER BY schema_name`,
      );
      return rows.map((r) => r.schema_name);
    }

    /**
     * Acquire advisory lock, pin search_path, run pending migrations for
     * one schema. Invoked once per schema (source + each tenant).
     *
     * Each invocation opens its own QueryRunner and releases it on exit,
     * keeping connection pressure bounded — matches the per-schema
     * isolation pattern used by aqua-db-migrate's orchestrator.
     */
    private async runForSchema(
      schema: string,
      migrationsTableName: string,
    ): Promise<void> {
      const queryRunner = this.dataSource.createQueryRunner();
      try {
        await queryRunner.connect();

        // Advisory-lock key mirrors aqua-db-migrate's
        // `hashtext('aqua-db-migrate:<schema>')` so legacy per-service runners
        // and the consolidation container share a single lock namespace and
        // cannot slip past each other.
        const acquired = await this.acquireAdvisoryLock(queryRunner, schema);
        if (!acquired) {
          throw new Error(
            `[MigrationRunner:${sourceSchema}] Could not acquire advisory lock for ` +
              `"${schema}" within ${lockTimeoutSeconds}s. Another migration runner ` +
              `may be active — resolve before retrying.`,
          );
        }

        try {
          // ── Pin search_path at session level (NOT `SET LOCAL`) ──
          //
          // # The 2026-04-07 farm-service incident this enforcement closes
          //
          // `AddPurchaseOrders1772000000000.up()` ran `SET search_path TO
          // public` at the end of its execution as a "cleanup". Because
          // `SET search_path` without `LOCAL` is SESSION-level, that
          // setting persisted across BEGIN/COMMIT into every subsequent
          // migration — their unqualified `ALTER TABLE ...` statements
          // resolved against `public.*` (where the table does not exist)
          // and crashed every farm-service deploy.
          //
          // The fix is runner-level enforcement: we own the contract and
          // re-assert the correct search_path before every migration's
          // up(), regardless of what the previous migration left the
          // session state as.
          await queryRunner.query(
            `SET search_path TO "${schema}", public`,
          );

          const schemaRowsResult: unknown =
            await queryRunner.query(`SELECT current_schema()`);
          const observedSchema =
            stringColumn(
              rowsFromQueryResult(schemaRowsResult)[0],
              'current_schema',
            ) ?? '<unknown>';

          if (observedSchema !== schema) {
            throw new Error(
              `[MigrationRunner:${sourceSchema}] Failed to pin search_path on ` +
                `"${schema}": observed current_schema() = "${observedSchema}". ` +
                `Verify the schema exists and the DB user has USAGE on it.`,
            );
          }

          this.logger.log(
            `QueryRunner pinned on "${schema}" (current_schema() verified)`,
          );

          const dataSourceOptions = this.dataSource.options as {
            migrationsTableName?: string;
          };
          const previousMigrationsTableName = dataSourceOptions.migrationsTableName;
          const executor = (() => {
            dataSourceOptions.migrationsTableName = migrationsTableName;
            try {
              const migrationExecutor = new MigrationExecutor(
                this.dataSource,
                queryRunner,
              );
              const schemaScopedExecutor = migrationExecutor as unknown as {
                migrationsSchema?: string;
                migrationsTable: string;
              };
              // TypeORM caches the driver default schema from the first
              // connection's search_path. Tenant fan-out must not let that
              // default point every ledger probe at the source schema; make
              // the ledger table explicit for this schema instead.
              schemaScopedExecutor.migrationsSchema = schema;
              schemaScopedExecutor.migrationsTable =
                this.dataSource.driver.buildTableName(
                  migrationsTableName,
                  schema,
                );
              return migrationExecutor;
            } finally {
              dataSourceOptions.migrationsTableName = previousMigrationsTableName;
            }
          })();
          executor.transaction = 'each';

          const pending = await executor.getPendingMigrations();
          if (pending.length === 0) {
            this.logger.log(`No pending migrations on "${schema}"`);
            return;
          }

          this.logger.log(
            `Executing ${pending.length} pending migration(s) on "${schema}"`,
          );

          const appliedNames: string[] = [];
          for (const migration of pending) {
            // Re-assert search_path before every migration (see incident
            // note above — runner-level enforcement, not distributed).
            await queryRunner.query(
              `SET search_path TO "${schema}", public`,
            );

            const migrationStartedAt = Date.now();
            this.emit(schema, migration.name, 'start');

            // R6 runtime gate — contract-phase @ExpandContract
            // migrations MUST NOT run until their dependsOn expand-phase
            // migration has been applied in this environment. The
            // assertion lives at the runner layer so authors don't
            // have to remember to call it in every contract-phase
            // up() body. Fail-safe: bootstrap environments (pre-
            // Phase-0 observability schema) skip cleanly without
            // blocking.
            const migrationCtor =
              typeof migration.instance === 'object' &&
              migration.instance !== null
                ? (migration.instance as { constructor: MigrationTarget })
                    .constructor
                : undefined;
            if (migrationCtor !== undefined) {
              const env =
                this.configService.get<string>('AQUA_ENV') ??
                this.configService.get<string>('NODE_ENV') ??
                'development';
              await assertExpandContractDependency({
                dataSource: this.dataSource,
                migrationClass: migrationCtor,
                environment: env,
              });

              if (
                schema !== sourceSchema &&
                isSourceOnlyMigration(migrationCtor)
              ) {
                await this.recordSourceOnlySkip(
                  queryRunner,
                  schema,
                  migrationsTableName,
                  migration,
                );
                appliedNames.push(`${migration.name} (source-only skipped)`);
                this.logger.log(
                  `Migration "${migration.name}" recorded as source-only skipped on "${schema}"`,
                );
                this.emit(
                  schema,
                  migration.name,
                  'applied',
                  Date.now() - migrationStartedAt,
                );
                continue;
              }
            }

            // Per-migration transaction so a partial failure in migration
            // N does not leak uncommitted DDL into migration N+1.
            await queryRunner.startTransaction();
            try {
              await executor.executeMigration(migration);

              // Faz 1.1 — post-condition probe barrier.
              //
              // If the migration class declared `postCondition(qr)`, run
              // it now (inside the wrapper tx, after executeMigration
              // returned, before commit). A `false` return value or
              // thrown exception rolls back the wrapper tx so the ledger
              // row never commits and the silent-applied class
              // (HR HealHrEnumTypeDrift 1786900 docblock: "SAVEPOINT
              // band-aid swallowed the ALTER") becomes impossible.
              await this.runPostConditionProbe(
                migration,
                queryRunner,
                schema,
              );

              await queryRunner.commitTransaction();
              appliedNames.push(migration.name);
              this.logger.log(
                `Migration "${migration.name}" applied on "${schema}"`,
              );
              this.emit(
                schema,
                migration.name,
                'applied',
                Date.now() - migrationStartedAt,
              );
            } catch (migrationErr) {
              await queryRunner.rollbackTransaction();
              const msg =
                migrationErr instanceof Error
                  ? migrationErr.message
                  : String(migrationErr);
              this.logger.error(
                `Migration "${migration.name}" failed on "${schema}": ${msg}`,
                migrationErr instanceof Error
                  ? migrationErr.stack
                  : undefined,
              );
              this.emit(
                schema,
                migration.name,
                'failed',
                Date.now() - migrationStartedAt,
                migrationErr,
              );
              throw migrationErr;
            }
          }

          this.logger.log(
            `Applied ${appliedNames.length} migration(s) on "${schema}": ${appliedNames.join(', ')}`,
          );
        } finally {
          // Release advisory lock inside the inner try so we always free
          // it even if the SET search_path / MigrationExecutor step threw.
          await queryRunner.query(
            `SELECT pg_advisory_unlock(hashtext('aqua-db-migrate:' || $1))`,
            [schema],
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
          `Migration runner failed on schema "${schema}": ${message}`,
          stack,
        );
        // Re-throw — failed migrations indicate a deployment problem and
        // the service must not start with an inconsistent schema.
        throw error;
      } finally {
        // Always release the QueryRunner, even if a step threw. A leaked
        // QueryRunner pins a pool connection forever.
        await queryRunner.release();
      }
    }

    /**
     * Faz 1.1 — Post-condition probe barrier.
     *
     * Called inside the wrapper transaction after `executeMigration()`
     * returned successfully, before `commitTransaction()`. A `false` /
     * throw rolls back the wrapper tx — the migration's ledger row
     * never commits and the deploy aborts.
     *
     * The probe is OPTIONAL: migrations that do not declare
     * `postCondition` are committed unchanged (backwards-compatible).
     * The contract is documented on the `PostConditionAwareMigration`
     * interface near the top of this file.
     *
     * Defence-in-depth:
     *   - We narrow the instance shape locally and detect the method
     *     via `typeof` — no `any`, no unsafe casts.
     *   - Probe errors are wrapped with `cause` so the original stack
     *     remains attached.
     *   - The probe runs against the SAME `queryRunner` that holds the
     *     in-flight tx, so any `information_schema` lookup the migration
     *     wants to perform sees its own uncommitted DDL — no separate
     *     connection needed.
     */
    private async runPostConditionProbe(
      migration: { name: string; instance?: unknown },
      queryRunner: QueryRunner,
      schema: string,
    ): Promise<void> {
      const instance = migration.instance;
      if (instance === null || typeof instance !== 'object') {
        return;
      }
      const candidate = instance as PostConditionAwareMigration &
        MigrationInterface;
      if (typeof candidate.postCondition !== 'function') {
        return; // optional method
      }

      let result: unknown;
      try {
        result = await candidate.postCondition(queryRunner);
      } catch (probeErr) {
        const msg =
          probeErr instanceof Error ? probeErr.message : String(probeErr);
        this.logger.error(
          `[postCondition] Migration "${migration.name}" probe threw on "${schema}": ${msg}`,
          probeErr instanceof Error ? probeErr.stack : undefined,
        );
        const probeErrInstance = new Error(
          `Migration "${migration.name}" postCondition() threw on "${schema}" — ` +
            `DDL did not satisfy declared invariant. Rolling back.`,
        );
        // Attach cause without depending on Error options (lib.es2022.error.d.ts);
        // this stays compatible with older TS lib targets while preserving the chain.
        (probeErrInstance as Error & { cause?: unknown }).cause = probeErr;
        throw probeErrInstance;
      }

      if (result === false) {
        this.logger.error(
          `[postCondition] Migration "${migration.name}" returned false on "${schema}"`,
        );
        throw new Error(
          `Migration "${migration.name}" postCondition() returned false on "${schema}" — ` +
            `DDL did not satisfy declared invariant. Rolling back.`,
        );
      }

      // `undefined` / `void` / `true` all pass — runner proceeds to commit.
      this.logger.debug?.(
        `[postCondition] Migration "${migration.name}" passed on "${schema}"`,
      );
    }

    private async recordSourceOnlySkip(
      queryRunner: QueryRunner,
      schema: string,
      migrationsTableName: string,
      migration: Migration,
    ): Promise<void> {
      await queryRunner.query(
        `INSERT INTO "${schema}"."${migrationsTableName}" ("timestamp", "name")
         SELECT $1::bigint, $2::varchar
         WHERE NOT EXISTS (
           SELECT 1 FROM "${schema}"."${migrationsTableName}"
            WHERE "timestamp" = $1::bigint AND "name" = $2::varchar
         )`,
        [migration.timestamp, migration.name],
      );
    }

    /**
     * Acquire `pg_try_advisory_lock` with polling + timeout. Key matches
     * aqua-db-migrate orchestrator so both runners coordinate.
     */
    private async acquireAdvisoryLock(
      queryRunner: QueryRunner,
      schema: string,
    ): Promise<boolean> {
      const deadline = Date.now() + lockTimeoutSeconds * 1000;
      while (Date.now() < deadline) {
        const rowsResult: unknown = await queryRunner.query(
          `SELECT pg_try_advisory_lock(hashtext('aqua-db-migrate:' || $1)) AS locked`,
          [schema],
        );
        if (booleanColumn(rowsFromQueryResult(rowsResult), 'locked')) {
          return true;
        }
        this.logger.warn(
          `Waiting for advisory lock on schema "${schema}" (aqua-db-migrate may be active)`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
      return false;
    }
  }

  return MigrationRunnerService;
}
