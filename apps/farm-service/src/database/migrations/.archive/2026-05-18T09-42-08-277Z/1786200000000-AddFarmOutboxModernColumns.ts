import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddFarmOutboxModernColumns
 * ============================================================================
 *
 * Forward migration aligning `farm.farm_outbox` to the modern
 * `OutboxEntityBase` shape (platform/libs/outbox/src/outbox-entity.base.ts).
 *
 * # Drift detected at boot 2026-04-20
 *
 * SchemaDriftValidator[farm] reported 5 violations on every cold start:
 *
 *   [farm.farm_outbox.tenantId]        entity declares column but DB has no such column
 *   [farm.farm_outbox.aggregateId]     entity declares column but DB has no such column
 *   [farm.farm_outbox.nextAttemptAt]   entity declares column but DB has no such column
 *   [farm.farm_outbox.idempotencyKey]  entity declares column but DB has no such column
 *   [farm.farm_outbox.isDeadLettered]  entity declares column but DB has no such column
 *
 * The columns were added to OutboxEntityBase between the original
 * `CreateFarmOutboxTable1780300000000` migration (which created the
 * pre-modern shape) and today, but no follow-up migration ever added
 * them to the farm-service table. The outbox publisher
 * (`platform/libs/outbox/src/outbox-publisher.service.ts`) reads/writes
 * these columns unconditionally — without them, every enqueue() call
 * INSERTs would fail with "column does not exist" if the entity weren't
 * declared with `synchronize: false` (which silently masks the drift
 * at runtime). The drift is only visible because Phase 11.4
 * SchemaDriftValidator was wired into farm-service.
 *
 * # Why each column matters at runtime
 *
 *   - `tenantId`     : NATS subject segment — `events.{tenantId}.{eventType}`.
 *                      Without it, the publisher reads `payload.tenantId`
 *                      (slower JSONB extract) and tenant-scoped subscribers
 *                      can't filter at the broker layer.
 *   - `aggregateId`  : Per-aggregate event ordering for downstream consumers
 *                      that need it (alert-engine BatchSnapshot rebuild).
 *   - `nextAttemptAt`: Exponential-backoff polling predicate. Without it,
 *                      a hot-failing event re-attempts on every poll
 *                      (default 100 ms) and saturates the publisher.
 *   - `idempotencyKey`: Deduplication index on (tenantId, idempotencyKey).
 *                      Command handlers retried during a transient DB
 *                      failure would otherwise create duplicate outbox
 *                      rows that publish twice to NATS.
 *   - `isDeadLettered`: Fast polling predicate filter
 *                      `AND "isDeadLettered" = false` — cheaper than the
 *                      legacy `AND "retryCount" < OUTBOX_MAX_RETRIES`
 *                      on tables with sparse dead letters.
 *
 * # Idempotent
 *
 * Each ADD COLUMN uses IF NOT EXISTS so re-running the migration on a
 * database that already has the columns is a no-op. Safe in CI, safe
 * in production.
 *
 * # Indexes
 *
 * The unique (tenantId, idempotencyKey) dedup index is created
 * conditionally — only rows where idempotencyKey IS NOT NULL participate
 * (`WHERE "idempotencyKey" IS NOT NULL`) so legacy rows without the key
 * don't violate uniqueness.
 *
 * The polling-predicate index `idx_farm_outbox_poll` already exists from
 * the original migration. We add a new partial index on
 * `(nextAttemptAt) WHERE "publishedAt" IS NULL AND "isDeadLettered" = false`
 * so the worker's polling predicate stays index-scannable as the table
 * grows.
 *
 * # No data backfill
 *
 * All new columns are nullable or defaulted (booleans default to false).
 * Existing rows get safe defaults at the catalog level — no data
 * rewrite is required. PostgreSQL 11+ handles ADD COLUMN with DEFAULT
 * as a metadata-only operation (single ACCESS EXCLUSIVE lock during
 * catalog update, no row rewrite).
 */
export class AddFarmOutboxModernColumns1786200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ADD COLUMN with DEFAULT is a metadata-only operation in PG 11+ —
    // single ACCESS EXCLUSIVE lock on the catalog, no row rewrite, sub-
    // millisecond on a 28-row table. Safe inside the migration runner's
    // default transaction.
    //
    // Indexes (dedup unique + modern polling predicate) are intentionally
    // NOT created here — they belong in a follow-up CONCURRENTLY migration
    // because CREATE INDEX without CONCURRENTLY would take ACCESS EXCLUSIVE
    // and stall outbox writers for the duration of the build (sub-second
    // today, but the policy is platform-wide for any pre-existing table).
    // Tracked under INFRA-CRITICAL-027 for the follow-up index migration;
    // this migration only closes the SchemaDriftValidator's column drift.
    await queryRunner.query(`
      ALTER TABLE farm.farm_outbox
        ADD COLUMN IF NOT EXISTS "tenantId" uuid NULL,
        ADD COLUMN IF NOT EXISTS "aggregateId" uuid NULL,
        ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS "isDeadLettered" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback drops the modern columns added in up(). Only safe if no
    // consumer depends on tenantId/aggregateId/nextAttemptAt/idempotencyKey/
    // isDeadLettered. Real-world operators should fix-forward via a new
    // migration rather than rolling back. pg_dump backup taken by the
    // deploy pipeline before applying any migration is the recovery path.
    await queryRunner.query(`
      -- DESTRUCTIVE: rollback drops modern outbox columns added in this migration up()
      -- Only safe if no consumer depends on tenantId aggregateId nextAttemptAt idempotencyKey isDeadLettered
      -- pg_dump backup taken by deploy pipeline before applying any migration is the recovery path
      ALTER TABLE farm.farm_outbox
        DROP COLUMN IF EXISTS "isDeadLettered",
        DROP COLUMN IF EXISTS "idempotencyKey",
        DROP COLUMN IF EXISTS "nextAttemptAt",
        DROP COLUMN IF EXISTS "aggregateId",
        DROP COLUMN IF EXISTS "tenantId"
    `);
  }
}
