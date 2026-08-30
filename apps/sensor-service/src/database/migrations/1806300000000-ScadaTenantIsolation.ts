import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-SENSOR-CRITICAL-001 + SENSOR-HIGH-004 (2026-07-11 database E2E audit).
 *
 * # Root cause
 *
 * The SCADA runtime alarm/history persistence was ported from single-project
 * FUXA with no tenant dimension. `scada_alarms` and `scada_alarm_chronicle`
 * were created directly in the shared `sensor` schema with NO `tenant_id`, and
 * every read (`getActiveAlarms`, `getAlarmHistory`) was an unfiltered
 * `SELECT` — so the moment the subsystem is activated, one tenant's operator
 * reads every tenant's SCADA alarms and history (a cross-tenant leak).
 * `scada_tag_history` was written by `DaqStorageService` but NO migration ever
 * created it (SENSOR-HIGH-004) — the same root defect (a tenant-less SCADA
 * persistence table) caught one step earlier.
 *
 * # Fix (Tier-1 make-it-impossible)
 *
 * Give every SCADA persistence table a mandatory `tenant_id` discriminator and
 * create the missing history table with the same discipline. These are
 * cross-tenant INFRASTRUCTURE tables in the `sensor` schema (registered in
 * `MODULE_SCHEMAS['sensor'].infrastructureTables`) — like `edge_device_directory`
 * they carry `tenant_id` and are never per-tenant cloned, because the SCADA
 * engine is a process-wide singleton with no per-request `search_path`; a
 * per-tenant clone would never receive the singleton writer's rows. Reads and
 * writes in the storage services are now tenant-parameterised and fail closed.
 *
 * # Blue-green safety
 *
 * The alarm engine has been dormant in production (no rules loaded, no tenant
 * bound — verified 2026-07-11), so these tables are empty in practice. Any
 * pre-existing row is un-attributable pre-fix leak surface and is removed
 * before `NOT NULL` is enforced, so the tenant boundary is total. Column adds
 * are `IF NOT EXISTS`; the history table is `CREATE TABLE IF NOT EXISTS`.
 * `id` stays the primary key on the two alarm tables (alarm ids are globally
 * unique UUIDs), so `ON CONFLICT (id)` upserts are unaffected.
 */
export class ScadaTenantIsolation1806300000000 implements MigrationInterface {
  name = 'ScadaTenantIsolation1806300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- scada_alarms: add tenant discriminator, enforce, index ---
    await queryRunner.query(
      `ALTER TABLE sensor.scada_alarms ADD COLUMN IF NOT EXISTS tenant_id uuid`,
    );
    // Remove any pre-fix, un-attributable rows before enforcing NOT NULL.
    await queryRunner.query(`DELETE FROM sensor.scada_alarms WHERE tenant_id IS NULL`);
    // Idempotent SET NOT NULL — no-op on replay once the column is already NOT NULL.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'sensor' AND table_name = 'scada_alarms'
            AND column_name = 'tenant_id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE sensor.scada_alarms ALTER COLUMN tenant_id SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_scada_alarms_tenant ON sensor.scada_alarms (tenant_id)`,
    );

    // --- scada_alarm_chronicle: same discriminator; tenant-leading history indexes ---
    await queryRunner.query(
      `ALTER TABLE sensor.scada_alarm_chronicle ADD COLUMN IF NOT EXISTS tenant_id uuid`,
    );
    await queryRunner.query(`DELETE FROM sensor.scada_alarm_chronicle WHERE tenant_id IS NULL`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'sensor' AND table_name = 'scada_alarm_chronicle'
            AND column_name = 'tenant_id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE sensor.scada_alarm_chronicle ALTER COLUMN tenant_id SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_scada_chronicle_tenant_ontime
         ON sensor.scada_alarm_chronicle (tenant_id, on_time DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_scada_chronicle_tenant_severity
         ON sensor.scada_alarm_chronicle (tenant_id, severity)`,
    );

    // --- scada_tag_history: create the table the historian always assumed (SENSOR-HIGH-004) ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.scada_tag_history (
        tenant_id  uuid             NOT NULL,
        tag_id     text             NOT NULL,
        timestamp  timestamptz      NOT NULL,
        value      double precision,
        quality    text             NOT NULL DEFAULT 'good',
        PRIMARY KEY (tenant_id, tag_id, timestamp)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_scada_tag_history_tenant_tag_ts
         ON sensor.scada_tag_history (tenant_id, tag_id, timestamp DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.scada_tag_history`);
    await queryRunner.query(`DROP INDEX IF EXISTS sensor.idx_scada_chronicle_tenant_severity`);
    await queryRunner.query(`DROP INDEX IF EXISTS sensor.idx_scada_chronicle_tenant_ontime`);
    await queryRunner.query(
      `ALTER TABLE sensor.scada_alarm_chronicle DROP COLUMN IF EXISTS tenant_id`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS sensor.idx_scada_alarms_tenant`);
    await queryRunner.query(`ALTER TABLE sensor.scada_alarms DROP COLUMN IF EXISTS tenant_id`);
  }
}
