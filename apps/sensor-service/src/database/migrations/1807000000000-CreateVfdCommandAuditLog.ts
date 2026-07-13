import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-SENSOR-HIGH-003 — durable audit for VFD runtime control commands.
 *
 * Runtime VFD control commands (START/STOP/SET_FREQUENCY/EMERGENCY_STOP/…) left
 * only a log line — no durable who/when/what/result record, a forensic +
 * IEC 62443 gap for industrial actuator writes. This creates the cross-tenant
 * `vfd_command_audit_logs` audit ledger — one table in the `sensor` schema,
 * discriminated by `tenant_id`, NOT per-tenant cloned (the platform convention
 * for audit ledgers; registered in MODULE_SCHEMAS['sensor'].infrastructureTables).
 *
 * Blue-green safe: additive only (new table + index), `IF NOT EXISTS`, no
 * column dropped or altered on an existing table.
 */
export class CreateVfdCommandAuditLog1807000000000 implements MigrationInterface {
  name = 'CreateVfdCommandAuditLog1807000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.vfd_command_audit_logs (
        id                 uuid NOT NULL DEFAULT uuid_generate_v4(),
        tenant_id          uuid NOT NULL,
        vfd_device_id      uuid NOT NULL,
        command            character varying(30) NOT NULL,
        value              numeric(15,6),
        success            boolean NOT NULL,
        error              text,
        performed_by       character varying(255) NOT NULL,
        performed_by_email character varying(255),
        source             character varying(30) NOT NULL DEFAULT 'operator',
        latency_ms         integer,
        metadata           jsonb,
        timestamp          timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT pk_vfd_command_audit_logs PRIMARY KEY (id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_vfd_command_audit_tenant_device_time
        ON sensor.vfd_command_audit_logs (tenant_id, vfd_device_id, timestamp)
    `);

    // Append-only immutability: audit rows are never updated or deleted
    // (protected-tables-guard; mirrors sensor_audit_logs / payroll_audit).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION sensor.vfd_command_audit_prevent_update_or_delete()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'Audit table "sensor"."vfd_command_audit_logs" is append-only; UPDATE/DELETE refused (protected-tables-guard).';
        END;
        $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_vfd_command_audit_prevent_update
        ON sensor.vfd_command_audit_logs;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_vfd_command_audit_prevent_update
        BEFORE UPDATE OR DELETE ON sensor.vfd_command_audit_logs
        FOR EACH ROW EXECUTE FUNCTION sensor.vfd_command_audit_prevent_update_or_delete();
    `);
    await queryRunner.query(
      `REVOKE UPDATE, DELETE ON sensor.vfd_command_audit_logs FROM PUBLIC`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_vfd_command_audit_prevent_update ON sensor.vfd_command_audit_logs`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS sensor.vfd_command_audit_prevent_update_or_delete()`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS sensor.idx_vfd_command_audit_tenant_device_time`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.vfd_command_audit_logs`);
  }
}
