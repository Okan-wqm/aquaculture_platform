import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SENSOR-HIGH-053 (RT-007) — SCADA tag history storage.
 *
 * DaqStorageService queried `scada_tag_history` but NO migration ever created
 * it, and the gateway's DAQ_QUERY handler was a stub — historical trends
 * rendered "successfully" empty. Created here as a cross-tenant
 * infrastructure table in `sensor` (registered in MODULE_SCHEMAS[sensor]
 * .infrastructureTables): the SCADA runtime's storage services run on the
 * service-wide DataSource, so isolation is enforced by the mandatory
 * `tenant_id` column carried in every insert and filter — the same
 * tenant-qualified pattern the WS value fan-out uses. tag_id is the registry
 * fqn (`deviceCode/localName`), matching live-plane keys.
 *
 * The composite PK doubles as the (tenant_id, tag_id, timestamp) query index;
 * converting to a TimescaleDB hypertable is an ops-side optimisation that can
 * be applied later without a schema change.
 */
export class CreateScadaTagHistory1806100000000 implements MigrationInterface {
  name = 'CreateScadaTagHistory1806100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.scada_tag_history (
        tenant_id UUID NOT NULL,
        tag_id TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        value DOUBLE PRECISION,
        quality TEXT NOT NULL DEFAULT 'good',
        PRIMARY KEY (tenant_id, tag_id, timestamp)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_scada_tag_history_tenant_time
        ON sensor.scada_tag_history (tenant_id, timestamp DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS sensor.idx_scada_tag_history_tenant_time`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.scada_tag_history`);
  }
}
