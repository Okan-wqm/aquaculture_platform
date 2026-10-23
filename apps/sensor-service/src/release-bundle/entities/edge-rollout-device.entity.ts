import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One device of a rollout's cohort and the wave it is in (ADR-048 DEC-23). The
 * cohort is fixed when the rollout is created.
 *
 * `request_id` is the device's first update request of this rollout, set in the
 * transaction that signs and stores it, so a device is issued exactly once however
 * many replicas run the rollout. What became of the request (delivered, refused,
 * re-issued, done, rolled back) is read from the request's campaign
 * (`edge_update_requests.intent_id`), never copied here. `refusal` is why the cloud
 * would not sign a statement for the device at all.
 *
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@Entity('edge_rollout_devices')
@Check('CHK_edge_rollout_devices_wave', `"wave" >= 1`)
@Index('uq_edge_rollout_devices_rollout_device', ['rolloutId', 'deviceId'], { unique: true })
@Index('idx_edge_rollout_devices_wave', ['tenantId', 'rolloutId', 'wave'])
@Index('idx_edge_rollout_devices_device', ['tenantId', 'deviceId'])
export class EdgeRolloutDevice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'rollout_id' })
  rolloutId!: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  /** 1-based; wave n+1 starts only when wave n has concluded within the failure allowance. */
  @Column({ type: 'smallint' })
  wave!: number;

  @Column({ type: 'uuid', name: 'request_id', nullable: true })
  requestId!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  refusal!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
