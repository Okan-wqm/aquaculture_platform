import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a channel is declared to measure, and the history of that declaration.
 *
 * # Why
 *
 * Most channel keys say what they measure (`ph`, `tan`, `h2s`), and the
 * measured-quantity registry (`@aquaculture/shared-contracts`) reads that from
 * the key. Some do not: an `ammonia` probe may report total ammonia nitrogen,
 * un-ionized NH3-N or ammonium, and a vendor key like `probe_7_ch2` says
 * nothing. Before such a channel can feed a water-chemistry input, its
 * operator declares the quantity.
 *
 * - `sensor_data_channels.declared_quantity` holds the current declaration
 *   (a registry quantity id). It is NULL for every existing row and stays
 *   NULL unless an operator declares one, so today's channels keep their
 *   key's meaning. No SQL CHECK lists the ids: a migration cannot follow the
 *   registry as it grows; the one write path checks them.
 * - `channel_quantity_declarations` is its append-only history — who
 *   declared or cleared what, when, with which unit — because a declaration
 *   reinterprets every value the channel has reported. Like
 *   `calibration_events`, it is written in the same transaction as the
 *   channel, and keyed by (sensor_id, channel_key) as well as the channel id,
 *   since rediscovery re-creates channels under new ids.
 *
 * # Tenant routing
 *
 * Both are per-tenant. The orchestrator runs this file once per schema (the
 * `sensor` source schema and every `tenant_*`) with the search_path pinned,
 * so the unqualified names resolve to the schema being migrated; the guard
 * skips a schema without the channel table. New tenants get both through
 * migration replay; the ledger is listed in MODULE_SCHEMAS sensor tables.
 *
 * Blue-green safe: a nullable column with no default and a new empty table.
 * `down` drops both.
 */
export class AddChannelQuantityDeclarations1820000000000 implements MigrationInterface {
  name = 'AddChannelQuantityDeclarations1820000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await hasChannelTable(queryRunner))) {
      return;
    }
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(
      `ALTER TABLE "sensor_data_channels"
         ADD COLUMN IF NOT EXISTS "declared_quantity" character varying(32)`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "channel_quantity_declarations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "sensor_id" uuid NOT NULL,
        "channel_id" uuid NOT NULL,
        "channel_key" character varying(100) NOT NULL,
        "quantity" character varying(32),
        "unit" character varying(50),
        "reason" character varying(32) NOT NULL,
        "declared_by" character varying(255) NOT NULL,
        "declared_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_channel_quantity_declarations" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_channel_quantity_declarations_key"
         ON "channel_quantity_declarations" ("tenant_id", "sensor_id", "channel_key", "declared_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await hasChannelTable(queryRunner))) {
      return;
    }
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`DROP TABLE IF EXISTS "channel_quantity_declarations"`);
    await queryRunner.query(
      `ALTER TABLE "sensor_data_channels" DROP COLUMN IF EXISTS "declared_quantity"`,
    );
  }
}

async function hasChannelTable(queryRunner: QueryRunner): Promise<boolean> {
  const present: Array<{ ready: boolean }> = await queryRunner.query(
    `SELECT to_regclass('sensor_data_channels') IS NOT NULL AS ready`,
  );
  return present[0]?.ready === true;
}
