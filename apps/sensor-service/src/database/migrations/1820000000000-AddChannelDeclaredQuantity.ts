import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A channel's declared measured quantity (`sensor_data_channels.declared_quantity`).
 *
 * # Why
 *
 * Most channel keys say what they measure (`ph`, `tan`, `h2s`), and the
 * measured-quantity registry (`@aquaculture/shared-contracts`) reads that from
 * the key. Some do not: an `ammonia` or `nh3` probe may report total ammonia
 * nitrogen, un-ionized NH3-N or ammonium, and a vendor key like `probe_7_ch2`
 * says nothing. Before such a channel can feed a water-chemistry input, its
 * operator declares the quantity; this column holds that declaration.
 *
 * It is NULL for every existing row and stays NULL unless an operator declares
 * one, so the effective quantity of today's channels is unchanged (the key's).
 * The value is a registry quantity id, checked at the one write path
 * (`declareChannelQuantity`); no SQL CHECK lists the ids, because a migration
 * cannot follow the registry as it grows.
 *
 * # Tenant routing
 *
 * `sensor_data_channels` is per-tenant. The orchestrator runs this file once
 * per schema (the `sensor` source schema and every `tenant_*`) with the
 * search_path pinned, so the unqualified name resolves to the schema being
 * migrated; the guard skips a schema without the table.
 *
 * Blue-green safe: nullable, no default, no rewrite. `down` drops the column.
 */
export class AddChannelDeclaredQuantity1820000000000 implements MigrationInterface {
  name = 'AddChannelDeclaredQuantity1820000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const present: Array<{ ready: boolean }> = await queryRunner.query(
      `SELECT to_regclass('sensor_data_channels') IS NOT NULL AS ready`,
    );
    if (present[0]?.ready !== true) {
      return;
    }
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(
      `ALTER TABLE "sensor_data_channels"
         ADD COLUMN IF NOT EXISTS "declared_quantity" character varying(32)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const present: Array<{ ready: boolean }> = await queryRunner.query(
      `SELECT to_regclass('sensor_data_channels') IS NOT NULL AS ready`,
    );
    if (present[0]?.ready !== true) {
      return;
    }
    await queryRunner.query(
      `ALTER TABLE "sensor_data_channels" DROP COLUMN IF EXISTS "declared_quantity"`,
    );
  }
}
