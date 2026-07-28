import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deliver the per-tenant `sensor_metrics` hypertable the declaration always
 * promised (SENSOR-HIGH-085).
 *
 * # The defect this closes
 *
 * `sensor_metrics` is declared PER TENANT — the entity omits `schema:` and
 * MODULE_SCHEMAS lists it as a tenant-fanned table — but no DDL ever created it
 * that way. Baseline creates the table and its hypertable explicitly qualified
 * into the source schema (1800000000000-Baseline.ts:61 and :361), so replaying
 * the migration set into a tenant schema re-targets the SHARED table instead of
 * creating the tenant's own. The per-tenant copies that did exist came from the
 * retired runtime CREATE-TABLE-LIKE seeding path, which produced PLAIN tables —
 * not hypertables — and that path is gone.
 *
 * So declaration and delivery disagreed: the model said per-tenant, the database
 * had one shared hypertable plus a scatter of plain leftovers. That mismatch is
 * what the earlier "make it one cross-tenant hypertable" attempt was reacting
 * to; it resolved the disagreement by moving the data OUT of tenant schemas,
 * which fixes the symptom by abandoning tenant isolation. This migration
 * resolves it the other way — by actually delivering what was declared.
 *
 * # Why an ordinary migration is the right vehicle
 *
 * Tenant provisioning IS migration replay: `tenant-schema-provisioner.ts`
 * calls `runSchemaMigrations({ schema: <tenant>, … })` and
 * `migration-orchestrator.ts` pins `SET search_path TO "<schema>", public`
 * before every migration. An UNQUALIFIED `CREATE TABLE` + unqualified
 * `create_hypertable()` therefore lands in whichever schema is being migrated —
 * every existing tenant on the next deploy, and every new tenant at provision
 * time — with no new provisioning hook. `create_hypertable` inside the default
 * per-migration transaction is already proven in-repo by Baseline:361.
 *
 * # Idempotent in BOTH schemas
 *
 * Every statement is IF NOT EXISTS / if_not_exists, so running against the
 * source `sensor` schema (where Baseline's shared hypertable already exists) is
 * a no-op rather than an error. The migration is safe wherever the replay
 * points it, which is what keeps it unqualified — the tenant-aware DDL guard
 * requires exactly that for per-tenant tables.
 *
 * # No data movement
 *
 * There is deliberately no copy-down from `sensor.sensor_metrics`. The
 * consolidation that would have moved tenant rows up was never released — it
 * exists only on this branch and no production ledger has run it — so there is
 * no consolidated data to bring back. Adding a copy-down would mean matching
 * tenants by a truncated-UUID schema-name prefix, which is not invertible and
 * could merge two tenants' telemetry into one schema. The correct move is not
 * to write that query more carefully; it is to not need it.
 */
export class CreateTenantSensorMetricsHypertable1815000000000 implements MigrationInterface {
  name = 'CreateTenantSensorMetricsHypertable1815000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Column set mirrors Baseline's sensor_metrics verbatim, including the
    // composite primary key TimescaleDB requires to contain the time column.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensor_metrics" (
        "time" TIMESTAMP WITH TIME ZONE NOT NULL,
        "sensor_id" uuid NOT NULL,
        "channel_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "site_id" uuid,
        "department_id" uuid,
        "system_id" uuid,
        "equipment_id" uuid,
        "tank_id" uuid,
        "pond_id" uuid,
        "farm_id" uuid,
        "raw_value" double precision NOT NULL,
        "value" double precision NOT NULL,
        "quality_code" smallint NOT NULL DEFAULT '192',
        "quality_bits" smallint NOT NULL DEFAULT '0',
        "source_protocol" character varying(20),
        "source_timestamp" TIMESTAMP WITH TIME ZONE,
        "ingestion_latency_ms" integer,
        "batch_id" uuid,
        CONSTRAINT "PK_tenant_sensor_metrics" PRIMARY KEY ("time", "sensor_id", "channel_id")
      )`);

    // Only promote to a hypertable where TimescaleDB is installed. Without this
    // guard the migration would hard-fail on a plain-Postgres environment
    // (local tooling, some CI jobs) that the table itself is perfectly usable in.
    const timescale: Array<{ present: boolean }> = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS present`,
    );
    if (timescale[0]?.present === true) {
      await queryRunner.query(
        `SELECT create_hypertable('sensor_metrics', 'time', if_not_exists => TRUE)`,
      );
    }

    // The lookup indexes Baseline gives the shared table, plus the
    // (sensor_id, channel_id, time DESC) index the as-of reading projection
    // needs so every per-channel "latest value at or before T" is an index seek.
    for (const [name, columns] of [
      ['idx_tenant_sensor_metrics_sensor_time', '("sensor_id", "time")'],
      ['idx_tenant_sensor_metrics_channel_time', '("channel_id", "time")'],
      ['idx_tenant_sensor_metrics_tenant_time', '("tenant_id", "time")'],
      ['idx_tenant_sensor_metrics_tank_time', '("tank_id", "time")'],
      ['idx_tenant_sensor_metrics_equipment_time', '("equipment_id", "time")'],
      [
        'idx_tenant_sensor_metrics_sensor_channel_time',
        '("sensor_id", "channel_id", "time" DESC)',
      ],
    ] as const) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "${name}" ON "sensor_metrics" ${columns}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: drops a tenant's telemetry table. Reversible only in the
    // sense that the schema can be re-created empty — the samples are gone.
    // Present so the migration is not a one-way door in a development database;
    // production rollback is a restore, not a down().
    await queryRunner.query(`DROP TABLE IF EXISTS "sensor_metrics"`);
  }
}
