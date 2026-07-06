import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Edge Device Directory (SENSOR-MEDIUM-004)
 *
 * A cross-tenant O(1) index from a device's public identifiers
 * (`device_code`, `mqtt_client_id`) to its owning `tenant_id`. It exists to
 * kill a denial-of-service vector: public provisioning + MQTT-auth endpoints
 * have no tenant context, and previously resolved a device by UNION-ALL
 * scanning `edge_devices` across EVERY `tenant_*` schema on each uncached
 * request — O(number of tenants) work, unbounded on the un-rate-limited
 * MQTT-auth path.
 *
 * This directory lives once in the `sensor` schema (declares `schema:`), so a
 * single indexed lookup resolves the tenant and the caller then issues one
 * targeted query against that tenant's `edge_devices`. It is authoritative only
 * as a routing hint: the per-tenant `edge_devices` row remains the source of
 * truth, and a directory miss falls back to the UNION-ALL scan and backfills.
 *
 * Cross-tenant infrastructure table — listed in
 * MODULE_SCHEMAS['sensor'].infrastructureTables, NOT per-tenant cloned.
 */
@Entity({ name: 'edge_device_directory', schema: 'sensor' })
export class EdgeDeviceDirectory {
  /** edge_devices.id — stable primary key mirrored from the owning row. */
  @PrimaryColumn({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  @Column({ type: 'varchar', name: 'device_code', length: 50 })
  @Index('idx_edge_device_directory_device_code', { unique: true })
  deviceCode!: string;

  @Column({ type: 'varchar', name: 'mqtt_client_id', length: 200, nullable: true })
  @Index('idx_edge_device_directory_mqtt_client_id', { unique: true })
  mqttClientId?: string | null;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index('idx_edge_device_directory_tenant_id')
  tenantId!: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
