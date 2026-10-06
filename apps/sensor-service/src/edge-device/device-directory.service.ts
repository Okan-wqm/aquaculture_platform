import {
  listActiveTenantSchemaIdentities,
  runInSourceRead,
  runInTenantRead,
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { EdgeDevice } from './entities/edge-device.entity';

/** Public identifier columns the directory can resolve a tenant by. */
export type DirectoryLookupColumn = 'device_code' | 'mqtt_client_id' | 'id';

/** A row to (re)publish into the directory. */
export interface DeviceDirectoryEntry {
  deviceId: string;
  deviceCode: string;
  mqttClientId?: string | null;
  tenantId: string;
}

/**
 * Device Directory Service (SENSOR-MEDIUM-004)
 *
 * Owns the cross-tenant `sensor.edge_device_directory` index that maps a
 * device's public identifiers to its owning tenant in O(1). Public
 * provisioning + MQTT-auth endpoints use it to resolve the tenant with a single
 * indexed query instead of a UNION-ALL scan across every tenant schema.
 *
 * The directory is a routing hint, not the source of truth: writers keep it in
 * sync inside the same transaction that mutates `edge_devices`, and readers
 * treat a miss as "fall back to the scan and backfill me".
 */
@Injectable()
export class DeviceDirectoryService {
  private readonly logger = new Logger(DeviceDirectoryService.name);

  // The directory column that a given edge_devices lookup column maps to.
  private static readonly COLUMN_MAP: Record<DirectoryLookupColumn, string> = {
    device_code: 'device_code',
    mqtt_client_id: 'mqtt_client_id',
    id: 'device_id',
  };

  // The EdgeDevice property a given lookup column maps to.
  private static readonly ENTITY_PROPERTY: Record<
    DirectoryLookupColumn,
    'deviceCode' | 'mqttClientId' | 'id'
  > = {
    device_code: 'deviceCode',
    mqtt_client_id: 'mqttClientId',
    id: 'id',
  };

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Resolve the owning tenantId for a device by one of its public identifiers,
   * in O(1) via the directory index. Returns null on a miss (caller falls back
   * to the cross-schema scan).
   */
  async lookupTenantId(column: DirectoryLookupColumn, value: string): Promise<string | null> {
    const dirColumn = DeviceDirectoryService.COLUMN_MAP[column];
    // SENSOR-CRITICAL-143: the directory carries the tenant-isolation policy
    // (FORCED), and this lookup is cross-tenant by design — it is how an
    // unauthenticated MQTT CONNECT or a provisioning call FINDS its tenant. A
    // plain pooled read runs with no tenant and bypass 'off', so it matched
    // nothing and every edge device was refused. runInSourceRead is the
    // sanctioned, transaction-local cross-tenant read of a source-schema table.
    const rows = (await runInSourceRead(this.dataSource, 'sensor', (qr) =>
      qr.query(`SELECT tenant_id FROM edge_device_directory WHERE "${dirColumn}" = $1 LIMIT 1`, [
        value,
      ]),
    )) as Array<{ tenant_id: string }>;
    return rows[0]?.tenant_id ?? null;
  }

  /**
   * Resolve a device by a public identifier with no tenant context — the MQTT
   * CONNECT / ACL hook and the public provisioning endpoints (SENSOR-CRITICAL-143).
   *
   * The directory names the tenant (runInSourceRead); the row is then read
   * inside THAT tenant's boundary. On a directory miss every active tenant is
   * read inside its own boundary — never one cross-schema UNION, which FORCE
   * RLS on the deny-by-default pool answers with zero rows — and a hit
   * backfills the directory.
   */
  async findDevice(column: DirectoryLookupColumn, value: string): Promise<EdgeDevice | null> {
    const property = DeviceDirectoryService.ENTITY_PROPERTY[column];
    const readIn = (tenantId: string): Promise<EdgeDevice | null> =>
      runInTenantRead(this.dataSource, 'sensor', tenantId, (qr) =>
        tenantManagerRepo(qr.manager, EdgeDevice).findOne({ where: { [property]: value } }),
      );

    const tenantId = await this.lookupTenantId(column, value);
    if (tenantId) {
      const device = await readIn(tenantId);
      if (device) {
        return device;
      }
      // Stale directory entry (device moved / deleted): fall through.
    }

    for (const identity of await listActiveTenantSchemaIdentities(this.dataSource)) {
      const device = await readIn(identity.tenantId);
      if (device) {
        await this.backfill({
          deviceId: device.id,
          deviceCode: device.deviceCode,
          mqttClientId: device.mqttClientId ?? null,
          tenantId: device.tenantId,
        });
        return device;
      }
    }
    return null;
  }

  /**
   * Insert or refresh the directory row for a device. Keyed on device_id so a
   * re-registration or identifier change updates in place. Runs inside the
   * caller's transaction when a manager is supplied.
   */
  async upsert(entry: DeviceDirectoryEntry, manager?: EntityManager): Promise<void> {
    const runner = manager ?? this.dataSource.manager;
    await runner.query(
      `INSERT INTO sensor.edge_device_directory
         (device_id, device_code, mqtt_client_id, tenant_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (device_id) DO UPDATE SET
         device_code = EXCLUDED.device_code,
         mqtt_client_id = EXCLUDED.mqtt_client_id,
         tenant_id = EXCLUDED.tenant_id,
         updated_at = now()`,
      [entry.deviceId, entry.deviceCode, entry.mqttClientId ?? null, entry.tenantId],
    );
  }

  /**
   * Best-effort backfill from a device row a scan just resolved. Never throws —
   * the caller already has its answer; a directory hiccup must not fail the
   * request. Self-heals the directory for the next lookup.
   */
  async backfill(entry: DeviceDirectoryEntry): Promise<void> {
    try {
      // The auth path that resolves a device has no request tenant; the write
      // runs inside the device's own tenant boundary so the policy's
      // WITH CHECK (tenant_id = current tenant) admits it.
      await runInTenantTransaction(this.dataSource, 'sensor', entry.tenantId, (qr) =>
        this.upsert(entry, qr.manager),
      );
    } catch (error) {
      this.logger.warn(
        `Directory backfill failed for device ${entry.deviceId}: ${(error as Error).message}`,
      );
    }
  }

  /** Remove a device from the directory (decommission / hard delete). */
  async remove(deviceId: string, manager?: EntityManager): Promise<void> {
    const runner = manager ?? this.dataSource.manager;
    await runner.query(`DELETE FROM sensor.edge_device_directory WHERE device_id = $1`, [deviceId]);
  }
}
