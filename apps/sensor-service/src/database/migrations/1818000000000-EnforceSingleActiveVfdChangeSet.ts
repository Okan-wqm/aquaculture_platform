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
 * vfd_change_sets is a per-tenant table (schema-per-tenant), so the index is
 * created on the canonical `sensor` source schema AND fanned out to every
 * provisioned tenant_<hex> schema holding the table — the same fan-out
 * pattern as 1808000000000-AddVfdDeviceEdgeBinding. The first version of
 * this migration only touched the source schema, leaving every live tenant
 * without the structural guard.
 *
 * Blue-green safe — SINGLE step: an index over existing rows either builds
 * or fails loudly. A failure means live invariant violations that MUST be
 * resolved (superseded sets stuck in an active status), not papered over.
 *
 * Idempotent via IF NOT EXISTS / IF EXISTS.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: db-migrate-owned per-tenant index add.
 */
export class EnforceSingleActiveVfdChangeSet1818000000000 implements MigrationInterface {
  name = 'EnforceSingleActiveVfdChangeSet1818000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Canonical source schema.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_vfd_change_sets_one_active_per_device"
      ON "sensor"."vfd_change_sets" ("tenant_id", "vfd_device_id")
      WHERE "status" IN ('pending_approval', 'approved', 'applying')
    `);

    // Fan out to every provisioned tenant schema that holds vfd_change_sets.
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'vfd_change_sets'
          ) THEN
            EXECUTE format(
              'CREATE UNIQUE INDEX IF NOT EXISTS uq_vfd_change_sets_one_active_per_device ON %I.vfd_change_sets (tenant_id, vfd_device_id) WHERE status IN (''pending_approval'', ''approved'', ''applying'')',
              r.nspname
            );
          END IF;
        END LOOP;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'vfd_change_sets'
          ) THEN
            EXECUTE format(
              'DROP INDEX IF EXISTS %I.uq_vfd_change_sets_one_active_per_device',
              r.nspname
            );
          END IF;
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "sensor"."uq_vfd_change_sets_one_active_per_device"
    `);
  }
}
