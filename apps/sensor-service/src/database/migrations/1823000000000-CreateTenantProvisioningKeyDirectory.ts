import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cross-tenant route for tenant provisioning keys (SENSOR-HIGH-175).
 *
 * # Why
 *
 * The public self-register / tenant-installer endpoints resolve a presented
 * key with no tenant. `tenant_provisioning_keys` is per-tenant under FORCE RLS,
 * and the pooled UNION that read every tenant schema saw zero rows, so every
 * key was "invalid" and auto-provisioning never worked. The key now resolves
 * through `sensor.tenant_provisioning_key_directory` (route hash → tenant) and
 * is read inside that tenant's boundary; `TenantKeyService.createTenantKey`
 * writes the route in the key's own transaction.
 *
 * # What it does
 *
 * Source-schema pass (`current_schema() = 'sensor'`): create the table and arm
 * the FORCED tenant-isolation policy on it (it is cross-tenant infrastructure,
 * MODULE_SCHEMAS['sensor'].infrastructureTables). Each tenant-schema pass:
 * route that tenant's existing keys. The route hash is
 * sha256('sensor-provisioning-key-route:' || sha256(rawKey)) — computed here
 * from the at-rest digest (`key_token`, sha256 hex since 1803000000000), the
 * same derivation as `provisioningKeyRouteHash`. Rows whose `key_token` is not
 * a 64-hex digest cannot be routed and are skipped (none should exist).
 *
 * The runner migrates the source schema before any tenant schema, so the
 * table exists when the backfill runs. The backfill runs under
 * `app.bypass_rls = 'on'` set transaction-locally inside one DO block, like
 * 1822000000000. `ON CONFLICT (route_hash) DO NOTHING` makes re-runs and
 * tenant provisioning replays (no keys yet) no-ops.
 *
 * # Reversibility
 *
 * `down` drops the table: it is a derived index of `tenant_provisioning_keys`.
 */
export class CreateTenantProvisioningKeyDirectory1823000000000 implements MigrationInterface {
  name = 'CreateTenantProvisioningKeyDirectory1823000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const where: Array<{ schema: string }> = await queryRunner.query(
      `SELECT current_schema() AS schema`,
    );
    const schema = where[0]?.schema ?? '';

    if (schema === 'sensor') {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS sensor.tenant_provisioning_key_directory (
          route_hash varchar(64) PRIMARY KEY,
          key_id uuid NOT NULL,
          tenant_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_provisioning_key_directory_key_id
           ON sensor.tenant_provisioning_key_directory (key_id)`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS idx_tenant_provisioning_key_directory_tenant_id
           ON sensor.tenant_provisioning_key_directory (tenant_id)`,
      );
      await applyTenantRlsToSchema(queryRunner, {
        schemaOverride: 'sensor',
        tenantIdColumns: ['tenant_id'],
        includeTables: ['tenant_provisioning_key_directory'],
      });
      return;
    }

    const ready: Array<{ ready: boolean }> = await queryRunner.query(
      `SELECT left(current_schema(), 7) = 'tenant_'
              AND to_regclass('tenant_provisioning_keys') IS NOT NULL
              AND to_regclass('sensor.tenant_provisioning_key_directory') IS NOT NULL AS ready`,
    );
    if (ready[0]?.ready !== true) {
      return;
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        PERFORM pg_catalog.set_config('app.bypass_rls', 'on', true);
        INSERT INTO sensor.tenant_provisioning_key_directory (route_hash, key_id, tenant_id)
        SELECT encode(
                 sha256(convert_to('sensor-provisioning-key-route:', 'UTF8')
                        || decode(key_token, 'hex')),
                 'hex'),
               id,
               tenant_id
          FROM tenant_provisioning_keys
         WHERE key_token ~ '^[0-9a-f]{64}$'
        ON CONFLICT (route_hash) DO NOTHING;
        PERFORM pg_catalog.set_config('app.bypass_rls', 'off', true);
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const where: Array<{ schema: string }> = await queryRunner.query(
      `SELECT current_schema() AS schema`,
    );
    if (where[0]?.schema === 'sensor') {
      await queryRunner.query(`DROP TABLE IF EXISTS sensor.tenant_provisioning_key_directory`);
    }
  }
}
