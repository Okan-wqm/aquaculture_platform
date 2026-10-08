import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill `sensor.edge_device_directory` from every tenant's `edge_devices`
 * (SENSOR-MEDIUM-004, security review of PR #1805).
 *
 * # Why
 *
 * The MQTT CONNECT / ACL hook and the public provisioning endpoints resolve a
 * device ONLY through the directory now; a directory miss is a denial. The
 * per-tenant scan that used to run on a miss — one transaction per active
 * tenant, on the unauthenticated CONNECT path — is gone. 1805000000000 filled
 * the directory once, but `EdgeDeviceService.registerDevice` never wrote it
 * and `createProvisionedDevice` wrote it outside the device's transaction, so
 * devices created since may have no route. Every creation path now goes
 * through `DeviceDirectoryService.saveNewDevice` (device + route, one
 * transaction); this migration routes the devices created before that.
 *
 * # Tenant routing and RLS
 *
 * The migration runner executes this file once per tenant schema with the
 * search_path pinned to it, so the unqualified `edge_devices` below is that
 * tenant's table; the `sensor` source-schema pass is skipped by the
 * `current_schema()` guard. Both tables carry the FORCED tenant-isolation
 * policy and the runner has no tenant, so the statement runs under
 * `app.bypass_rls = 'on'` — set transaction-locally inside the same DO block,
 * so it holds for this statement only, whether or not the runner wraps the
 * migration in a transaction.
 *
 * # Idempotency and reversibility
 *
 * `ON CONFLICT (device_id) DO UPDATE` refreshes an existing route to the
 * device row's current identifiers and tenant, so a re-run (or tenant
 * provisioning replay, where `edge_devices` is empty) is a no-op. `down` is a
 * no-op: the rows are a derived index of `edge_devices`, indistinguishable
 * from the ones the application writes, and dropping them would lock every
 * such device out of the broker.
 */
export class BackfillEdgeDeviceDirectory1822000000000 implements MigrationInterface {
  name = 'BackfillEdgeDeviceDirectory1822000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const present: Array<{ ready: boolean }> = await queryRunner.query(
      `SELECT left(current_schema(), 7) = 'tenant_'
              AND to_regclass('edge_devices') IS NOT NULL
              AND to_regclass('sensor.edge_device_directory') IS NOT NULL AS ready`,
    );
    if (present[0]?.ready !== true) {
      return;
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        PERFORM pg_catalog.set_config('app.bypass_rls', 'on', true);
        INSERT INTO sensor.edge_device_directory
          (device_id, device_code, mqtt_client_id, tenant_id, updated_at)
        SELECT id, device_code, mqtt_client_id, tenant_id, now()
          FROM edge_devices
        ON CONFLICT (device_id) DO UPDATE SET
          device_code = EXCLUDED.device_code,
          mqtt_client_id = EXCLUDED.mqtt_client_id,
          tenant_id = EXCLUDED.tenant_id,
          updated_at = now();
        PERFORM pg_catalog.set_config('app.bypass_rls', 'off', true);
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Intentionally a no-op — see the class docblock.
  }
}
