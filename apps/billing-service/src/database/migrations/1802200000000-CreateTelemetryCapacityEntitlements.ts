import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateTelemetryCapacityEntitlements1802200000000 (Task 8, SENSOR-HIGH-011)
 *
 * `billing.telemetry_capacity_entitlements` — the per-tenant telemetry
 * capacity reservation ledger backing the entitlement contract in
 * `@platform/event-contracts` (billing/telemetry-capacity.ts).
 *
 * The state machine (PENDING_CAPACITY → ACTIVE → SUPERSEDED/RELEASED) is
 * enforced structurally by two PARTIAL unique indexes:
 *
 *   - one ACTIVE row per tenant (the envelope only ever counts one version)
 *   - one PENDING_CAPACITY row per tenant (a retried reservation command
 *     must not stack pending rows)
 *
 * billing is a cross-tenant platform schema (no per-tenant clones), so the
 * DDL is addressed with its `billing`-qualified names — same discipline as
 * 1801900000000.
 *
 * Blue-green safe: CREATE TABLE/INDEX IF NOT EXISTS only; no data
 * transformation. Idempotent on re-run.
 */
export class CreateTelemetryCapacityEntitlements1802200000000 implements MigrationInterface {
  name = 'CreateTelemetryCapacityEntitlements1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE billing.telemetry_capacity_entitlement_state AS ENUM
          ('PENDING_CAPACITY', 'ACTIVE', 'SUPERSEDED', 'RELEASED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.telemetry_capacity_entitlements (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id uuid NOT NULL,
        version integer NOT NULL,
        state billing.telemetry_capacity_entitlement_state NOT NULL,
        m integer NOT NULL,
        r integer NOT NULL,
        observed_remaining_m integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_tce_positive_values CHECK (m > 0 AND r > 0),
        CONSTRAINT ck_tce_positive_version CHECK (version > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tce_one_active_per_tenant
        ON billing.telemetry_capacity_entitlements (tenant_id)
        WHERE state = 'ACTIVE'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tce_one_pending_per_tenant
        ON billing.telemetry_capacity_entitlements (tenant_id)
        WHERE state = 'PENDING_CAPACITY'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tce_tenant_version
        ON billing.telemetry_capacity_entitlements (tenant_id, version)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS billing.telemetry_capacity_entitlements`);
    await queryRunner.query(`DROP TYPE IF EXISTS billing.telemetry_capacity_entitlement_state`);
  }

  /** Fail-closed: the partial unique guards must exist after the run. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ missing: string }> = await queryRunner.query(`
      WITH expected(idxname) AS (VALUES
        ('uq_tce_one_active_per_tenant'),
        ('uq_tce_one_pending_per_tenant'))
      SELECT COUNT(*)::text AS missing
        FROM expected x
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'billing'
            AND indexname = x.idxname)
    `);
    return Number(rows[0]?.missing ?? '1') === 0;
  }
}
