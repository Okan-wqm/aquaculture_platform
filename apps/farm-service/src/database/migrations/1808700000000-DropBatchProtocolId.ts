import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropBatchProtocolId1808700000000 — retire the batch→protocol binding that
 * never existed.
 *
 * WHY: `batches_v2.protocolId` was added by AddBatchProtocolId1802000000000 and
 * documented as "the protocol is bound to the batch and follows the fish".
 * Neither half was ever true:
 *   (a) it referenced the v1 `feeding_protocols` table, superseded by
 *       `feeding_protocols_v2` + `feeding_protocol_assignments`;
 *   (b) it had NO WRITER anywhere in the repository — no create handler, no
 *       update handler, no input DTO, no seeder, no backfill. It was NULL in
 *       every row of every environment from the day it was created.
 * The three readers that consulted it (the tanks-page DataLoader,
 * FeedSelectorService, and the legacy daily-plan engine) therefore always took
 * their "no protocol" branch, while the v2 engine planned those same tanks from
 * their assignment bands. The same PR re-points all three at
 * `feeding_protocol_assignments.unitId`, which is the real authority: at most
 * ONE active assignment per unit, enforced structurally by the partial unique
 * index `(tenantId, unitId) WHERE status = 'active'`.
 *
 * WHY no backfill and no data guard: an all-NULL column carries nothing to
 * preserve or migrate. Where a protocol binding genuinely exists it already
 * lives in `feeding_protocol_assignments` — written by the v2 assignment
 * handlers and by MigrateFeedingProgramsToProtocolV2 /
 * FeedingCutoverActivateAssignments. Nothing is lost that the v2 tables do not
 * already hold. The column-existence probe below is the only guard needed: it
 * makes the drop idempotent across schemas that never ran 1802000000000.
 *
 * WHY current_schema-relative: `batches_v2` is a per-tenant table. db-migrate
 * fans farm migrations out with search_path pinned to `farm` and then to each
 * `tenant_<uuid>`, and every schema owns its own clone. Pinning every reference
 * to current_schema() keeps each pass strictly self-scoped — no cross-schema
 * DDL (the 2026-07-07 #926 outage class). The index goes with the column
 * automatically; dropping it explicitly first would be a second, redundant
 * catalog lookup.
 *
 * ORDERING / blue-green:
 *   1. This release removes every reader of the column (code change, same PR).
 *   2. This migration drops it.
 * That order is the only safe one, and it is the order db-migrate enforces at
 * deploy time: the `db-migrate` one-shot container runs to completion BEFORE
 * any backend container starts (`depends_on: service_completed_successfully` in
 * docker-compose.droplet.yml), so the image that runs against the post-drop
 * schema is always the new one. The drop itself is metadata-only in PostgreSQL
 * (no table rewrite, no long lock), and it is forward-only.
 *
 * RESIDUAL WINDOW, stated rather than hidden: a selective
 * `docker compose up -d --no-deps` recreates db-migrate before it recreates
 * farm-service, so the PREVIOUS farm-service image is briefly live against the
 * post-drop schema. In that window its three protocol reads raise
 * `42703 column "protocolId" does not exist` instead of returning NULL. Two of
 * the three already degrade behind existing catches (EquipmentResolver logs and
 * returns empty feed info; FeedSelectorService.selectFeedForBatch catches and
 * returns null), so the tanks page loses feed labels rather than erroring. The
 * third — the legacy daily-plan generator — would surface the error to its
 * caller; it is an operator-triggered/cron path that is retried, and it is the
 * same window in which farm-service is being replaced anyway. Because the
 * column was always NULL, no old reader loses a value it used to have: the only
 * difference in that window is an error instead of the same empty answer.
 * Operators who want a zero-error window run this migration in the release
 * AFTER the reader removal is live; the drop is idempotent either way.
 *
 * down(): forward-only. Re-adding an always-NULL column would resurrect the
 * exact lie this migration removes; the recovery path for a genuine protocol
 * binding is a v2 assignment, not this column.
 */
export class DropBatchProtocolId1808700000000 implements MigrationInterface {
  name = 'DropBatchProtocolId1808700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'batches_v2'
             AND column_name = 'protocolId'
        ) THEN
          EXECUTE format(
            -- DESTRUCTIVE: drops an all-NULL, writer-less v1 column. The live protocol binding is feeding_protocol_assignments.unitId; rollback = create a v2 assignment for the unit, never a batch column.
            'ALTER TABLE %I.batches_v2 DROP COLUMN IF EXISTS "protocolId"',
            current_schema()
          );
        ELSE
          RAISE NOTICE 'DropBatchProtocolId: %.batches_v2.protocolId absent — skipping',
            current_schema();
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement — see the docblock. Intentionally a no-op.
  }
}
