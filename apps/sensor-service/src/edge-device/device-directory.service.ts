import {
  runInSourceRead,
  runInTenantRead,
  SENSOR_SOURCE_SCHEMA,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
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
 * `edge_devices` is the source of truth; the directory is its routing index,
 * written in the same transaction that creates the device (`saveNewDevice`,
 * the only creation path) and backfilled once by migration 1822000000000 for
 * devices created before every path wrote it. A miss is therefore a miss: the
 * unauthenticated CONNECT path never scans tenants, so an unknown identifier
 * costs one indexed read, not one transaction per tenant.
 */
@Injectable()
export class DeviceDirectoryService {
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
   * in O(1) via the directory index. Returns null on a miss.
   */
  async lookupTenantId(column: DirectoryLookupColumn, value: string): Promise<string | null> {
    const dirColumn = DeviceDirectoryService.COLUMN_MAP[column];
    // SENSOR-CRITICAL-143: the directory carries the tenant-isolation policy
    // (FORCED), and this lookup is cross-tenant by design — it is how an
    // unauthenticated MQTT CONNECT or a provisioning call FINDS its tenant. A
    // plain pooled read runs with no tenant and bypass 'off', so it matched
    // nothing and every edge device was refused. runInSourceRead is the
    // sanctioned, transaction-local cross-tenant read of a source-schema table.
    const rows = (await runInSourceRead(this.dataSource, SENSOR_SOURCE_SCHEMA, (qr) =>
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
   * inside THAT tenant's boundary, so a directory row that names the wrong
   * tenant resolves nothing. No directory row, no device.
   */
  async findDevice(column: DirectoryLookupColumn, value: string): Promise<EdgeDevice | null> {
    const tenantId = await this.lookupTenantId(column, value);
    if (!tenantId) {
      return null;
    }
    const property = DeviceDirectoryService.ENTITY_PROPERTY[column];
    return runInTenantRead(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
      tenantManagerRepo(qr.manager, EdgeDevice).findOne({ where: { [property]: value } }),
    );
  }

  /**
   * Persist a NEW device and publish its directory route through the same
   * manager, so one transaction commits both or neither. Every device-creating
   * path goes through here; a device that skipped the directory could never
   * authenticate, because the CONNECT path does not scan tenants.
   *
   * The caller owns the transaction and must have opened it inside the
   * device's tenant boundary (`runInTenantTransaction`): both tables carry the
   * FORCED tenant-isolation policy.
   */
  async saveNewDevice(device: EdgeDevice, manager: EntityManager): Promise<EdgeDevice> {
    const saved = await manager.save(device);
    await this.upsert(
      {
        deviceId: saved.id,
        deviceCode: saved.deviceCode,
        mqttClientId: saved.mqttClientId ?? null,
        tenantId: saved.tenantId,
      },
      manager,
    );
    return saved;
  }

  /**
   * Insert or refresh the directory row for a device, keyed on device_id, in
   * the caller's tenant transaction.
   */
  private async upsert(entry: DeviceDirectoryEntry, manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO "${SENSOR_SOURCE_SCHEMA}".edge_device_directory
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
}
