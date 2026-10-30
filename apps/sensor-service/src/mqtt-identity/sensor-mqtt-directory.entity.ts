import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Sensor MQTT directory (ADR-047 §1): which tenant and sensor an issued broker
 * username belongs to, read by the broker's CONNECT and ACL hooks, which carry
 * no tenant. A directory miss is a denial; there is no tenant scan.
 *
 * A derived index of the per-tenant `sensors.mqtt_username`, written only by
 * the trigger migration 1826000000000 puts on every tenant's `sensors` table,
 * in the statement that issues, rotates, clears or deletes the username. The
 * code reads it (SensorMqttIdentityService.findPrincipal) and never writes it.
 *
 * Cross-tenant infrastructure table — listed in
 * MODULE_SCHEMAS['sensor'].infrastructureTables, NOT per-tenant cloned; FORCE
 * RLS on tenant_id; tenant erasure deletes its rows (RouteDirectoryPurgeHook).
 */
@Entity({ name: 'sensor_mqtt_directory', schema: 'sensor' })
export class SensorMqttDirectory {
  @PrimaryColumn({ type: 'varchar', name: 'mqtt_username', length: 23 })
  mqttUsername!: string;

  @Column({ type: 'uuid', name: 'sensor_id' })
  @Index('uq_sensor_mqtt_directory_sensor_id', { unique: true })
  sensorId!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index('idx_sensor_mqtt_directory_tenant_id')
  tenantId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
