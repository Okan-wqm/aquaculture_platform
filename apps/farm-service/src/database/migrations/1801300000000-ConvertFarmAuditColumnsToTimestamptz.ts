import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  convertAuditColumnsToTimestamptz,
  MigrationLogger,
  TenantFanOut,
} from '@aquaculture/backend-common/database';

/**
 * ConvertFarmAuditColumnsToTimestamptz1801300000000
 * ============================================================================
 *
 * # Why this migration exists (audit-column timezone drift)
 *
 * Three farm-service per-tenant tables carry their `createdAt`/`updatedAt`
 * audit columns as bare `TIMESTAMP WITHOUT TIME ZONE` in the consolidated
 * baseline (1800000000000), while every other farm audit column is
 * `TIMESTAMPTZ`:
 *
 *   - `farms`         (farm.entity.ts — bare `@CreateDateColumn()`/`@UpdateDateColumn()`)
 *   - `ponds`         (pond.entity.ts — same)
 *   - `farm_workers`  (worker.entity.ts — same)
 *
 * ROOT CAUSE: those three entities declared the bare TypeORM decorators with
 * no explicit `type:`. The postgres driver default for `@CreateDateColumn()`
 * is `timestamp` (without tz) — confirmed in
 * `convert-audit-columns-to-timestamptz.helper.ts` docblock — so the baseline
 * froze them as naked TIMESTAMP. A naked TIMESTAMP silently drops the offset,
 * re-interpreting every stored instant against the session `TimeZone` GUC on
 * read: a ±1h DST drift on the audit trail, which is a compliance finding for
 * an aquaculture record that backs Mattilsynet / FDIR reporting.
 *
 * # Two halves of this fix (both shipped in this PR)
 *
 *   (a) ENTITY pin: `type: 'timestamptz'` was added to the
 *       `@CreateDateColumn()`/`@UpdateDateColumn()` on Farm, Pond, and Worker
 *       so a future baseline regen keeps the correct type (Tier-1
 *       make-it-structural — the entity is the schema SSoT).
 *   (b) MIGRATION (this file): convert the already-deployed columns in-place
 *       on the live source schema AND every tenant clone.
 *
 * # Why the shared helper, not hand-rolled ALTERs
 *
 * `convertAuditColumnsToTimestamptz` discovers columns via
 * `information_schema.columns` filtered on `data_type =
 * 'timestamp without time zone'`. It is therefore SELF-BOUNDING: it touches
 * ONLY the three drifted tables in the current schema and is a guaranteed
 * no-op everywhere else (and on re-run, since already-converted columns no
 * longer match the discovery filter). That makes it idempotent without an
 * explicit table allowlist that could rot as entities evolve. We restrict the
 * audit column set to `['createdAt', 'updatedAt']` because those are the only
 * camelCase audit columns farm-service uses (stock_movements uses snake_case
 * `created_at` but is already TIMESTAMPTZ in the baseline, so it never matches
 * the discovery filter regardless).
 *
 * # Schema routing & fan-out
 *
 * `farms`, `ponds`, and `farm_workers` are per-tenant tables (their entities
 * omit `schema:`), so the conversion must land on the `farm` source schema
 * AND every `tenant_<uuid>` clone. The migration runner already fans this
 * migration out across all tenant schemas with `search_path` pinned to each;
 * the helper queries `current_schema()` so it operates on whichever schema
 * the runner pinned. `@TenantFanOut({ lockClass: 'tenant-local' })` declares
 * that the per-tenant DDL has no cross-tenant catalog serialization, so the
 * orchestrator may parallelise up to `concurrency: 8` schemas.
 *
 * # Locking
 *
 * `ALTER COLUMN ... TYPE TIMESTAMPTZ USING ... AT TIME ZONE 'UTC'` takes
 * ACCESS EXCLUSIVE and rewrites the table. The three target tables are
 * dimension-sized (farms/ponds/workers — not high-volume measurement tables),
 * so the rewrite is bounded. We still set a `lock_timeout` envelope so a
 * blocked ALTER fails fast rather than queueing behind a long transaction,
 * and a generous `statement_timeout` so the rewrite itself is not killed
 * mid-flight. We do NOT `SET search_path` — the runner owns the session pin
 * (sql-lint R4) and a migration-body override is the 2026-04-07 split-brain
 * incident class.
 *
 * # down()
 *
 * Documented no-op. Reverting TIMESTAMPTZ → naked TIMESTAMP would
 * re-introduce the DST drift bug this migration cures; the break-glass
 * inverse lives in `revertAuditColumnsToTimestamp` and is only ever invoked
 * by an explicit incident-rollback path, never by a routine `down()`.
 */
@TenantFanOut({ lockClass: 'tenant-local', concurrency: 8 })
export class ConvertFarmAuditColumnsToTimestamptz1801300000000
  implements MigrationInterface
{
  name = 'ConvertFarmAuditColumnsToTimestamptz1801300000000';

  private readonly logger = new MigrationLogger(
    'ConvertFarmAuditColumnsToTimestamptz1801300000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Lock-timeout envelope for the table-rewrite ALTERs (bounded ACCESS
    // EXCLUSIVE wait + generous rewrite ceiling). SET LOCAL releases on
    // COMMIT so the pooled connection is never contaminated. search_path is
    // owned by the runner (session pin) — a migration-body SET search_path
    // is forbidden (sql-lint R4).
    await queryRunner.query(`SET LOCAL lock_timeout = '30s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    // Self-bounding, idempotent conversion: discovers only the columns still
    // typed `timestamp without time zone` in the current (runner-pinned)
    // schema, which are exactly farms/ponds/farm_workers createdAt+updatedAt.
    await convertAuditColumnsToTimestamptz(queryRunner, {
      auditColumns: ['createdAt', 'updatedAt'],
      logger: this.logger,
    });
  }

  public async down(): Promise<void> {
    // Intentional no-op — see class docblock § down(). Reverting to naked
    // TIMESTAMP re-introduces DST drift; use the break-glass
    // `revertAuditColumnsToTimestamp` helper under an incident only.
    this.logger.warn(
      'down() is a no-op: reverting audit columns to naked TIMESTAMP would ' +
        're-introduce DST drift. Use revertAuditColumnsToTimestamp under an ' +
        'explicit incident-rollback procedure if a revert is genuinely required.',
    );
  }
}
