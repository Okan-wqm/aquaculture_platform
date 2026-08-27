import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EnforceSingleActiveVfdChangeSet1818000000000
 * (SEC-MEDIUM-083 — 2026-08-23 scan №28)
 *
 * WHY: "only one active change set per device" was enforced ONLY by
 * ensureNoActiveChangeSet — a check-then-act read with no DB backing, so two
 * concurrent submits/approvals for the same device could both pass it. The
 * partial unique index makes the invariant structural: the second
 * PENDING_APPROVAL/APPROVED/APPLYING row for the same (tenant, device)
 * cannot exist, whatever the racing code paths do. The service-level check
 * remains for its friendly ConflictException, not as the enforcement.
 *
 * Blue-green safe — SINGLE step: an index over existing rows either builds
 * or fails loudly. A failure means live invariant violations that MUST be
 * resolved (superseded sets stuck in an active status), not papered over.
 *
 * Idempotent via IF NOT EXISTS / IF EXISTS.
 */
export class EnforceSingleActiveVfdChangeSet1818000000000 implements MigrationInterface {
  name = 'EnforceSingleActiveVfdChangeSet1818000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_vfd_change_sets_one_active_per_device"
      ON "sensor"."vfd_change_sets" ("tenant_id", "vfd_device_id")
      WHERE "status" IN ('pending_approval', 'approved', 'applying')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "sensor"."uq_vfd_change_sets_one_active_per_device"
    `);
  }
}
