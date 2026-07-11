import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

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

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Resolve the owning tenantId for a device by one of its public identifiers,
   * in O(1) via the directory index. Returns null on a miss (caller falls back
   * to the cross-schema scan).
   */
  async lookupTenantId(column: DirectoryLookupColumn, value: string): Promise<string | null> {
    const dirColumn = DeviceDirectoryService.COLUMN_MAP[column];
    const rows: { tenant_id: string }[] = await this.dataSource.query(
      `SELECT tenant_id FROM sensor.edge_device_directory WHERE "${dirColumn}" = $1 LIMIT 1`,
      [value],
    );
    return rows[0]?.tenant_id ?? null;
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
      await this.upsert(entry);
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
