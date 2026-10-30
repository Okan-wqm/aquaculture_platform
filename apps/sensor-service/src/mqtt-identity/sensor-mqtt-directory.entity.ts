import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Sensor MQTT directory (ADR-047 §1): the one home of a sensor's broker
 * principal — its username, tenant and sensor, and the HMAC of its secret
 * under the pepper `secretKeyId` names. The broker's CONNECT and ACL hooks,
 * which carry no tenant, answer from this one row (one indexed read); a miss
 * is a denial and there is no tenant scan.
 *
 * SensorMqttIdentityService inserts a row when it issues a credential, in the
 * transaction that sets the sensor's `mqtt_username`. The triggers migration
 * 1826000000000 puts on every tenant's `sensors` table remove it when the
 * username is cleared or changed or the sensor deleted, and refuse at commit
 * a sensor naming a username no row routes to it; a suspended sensor holds
 * none. So a row exists exactly while a live, unsuspended sensor holds it.
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

  /** HMAC-SHA-256 (hex) of the issued secret; the secret itself is never stored. */
  @Column({ type: 'char', name: 'secret_hmac', length: 64 })
  secretHmac!: string;

  /** Which pepper of the keyring `secretHmac` was computed under. */
  @Column({ type: 'varchar', name: 'secret_key_id', length: 64 })
  secretKeyId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
