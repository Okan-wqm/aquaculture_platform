import type { TelemetryCapacityActivationState } from '@platform/event-contracts';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export type TelemetryCapacityEnvelopeState = 'ACTIVE' | 'SUPERSEDED';
export type TelemetryRetentionApprovalState = 'UNAPPROVED' | 'APPROVED';

@Entity({
  schema: 'admin',
  name: 'telemetry_capacity_envelopes',
})
@Index('uq_telemetry_capacity_envelopes_version', ['version'], {
  unique: true,
})
@Index('idx_telemetry_capacity_envelopes_state_effective', ['state', 'effectiveAt'])
export class TelemetryCapacityEnvelope {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 16 })
  state!: TelemetryCapacityEnvelopeState;

  @Column({
    name: 'sustained_ingress_messages_per_second',
    type: 'double precision',
  })
  sustainedIngressMessagesPerSecond!: number;

  @Column({ name: 'sustained_metric_rows_per_minute', type: 'double precision' })
  sustainedMetricRowsPerMinute!: number;

  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  @Column({ name: 'created_by', type: 'varchar', length: 255 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({
  schema: 'admin',
  name: 'telemetry_capacity_entitlements',
})
@Index('uq_telemetry_capacity_entitlements_operation', ['operationId'], {
  unique: true,
})
@Index('uq_telemetry_capacity_entitlements_reservation', ['reservationId'], {
  unique: true,
})
@Index('uq_telemetry_capacity_entitlements_tenant_version', ['tenantId', 'entitlementVersion'], {
  unique: true,
})
export class TelemetryCapacityEntitlement {
  @PrimaryColumn({ name: 'entitlement_id', type: 'uuid' })
  entitlementId!: string;

  @Column({ name: 'reservation_id', type: 'uuid' })
  reservationId!: string;

  @Column({ name: 'operation_id', type: 'uuid' })
  operationId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'entitlement_version', type: 'integer' })
  entitlementVersion!: number;

  @Column({ name: 'capacity_envelope_id', type: 'uuid' })
  capacityEnvelopeId!: string;

  @Column({ name: 'capacity_envelope_version', type: 'integer' })
  capacityEnvelopeVersion!: number;

  @Column({
    name: 'sustained_ingress_messages_per_second',
    type: 'double precision',
  })
  sustainedIngressMessagesPerSecond!: number;

  @Column({ name: 'sustained_metric_rows_per_minute', type: 'double precision' })
  sustainedMetricRowsPerMinute!: number;

  @Column({ name: 'reserved_ingress_delta', type: 'double precision' })
  reservedIngressDelta!: number;

  @Column({ name: 'reserved_metric_rows_delta', type: 'double precision' })
  reservedMetricRowsDelta!: number;

  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  @Column({
    name: 'retention_approval_state',
    type: 'varchar',
    length: 16,
    default: 'UNAPPROVED',
  })
  retentionApprovalState!: TelemetryRetentionApprovalState;

  @Column({ name: 'archive_tier', type: 'varchar', length: 64, nullable: true })
  archiveTier!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({
  schema: 'admin',
  name: 'telemetry_capacity_activation_events',
})
@Index('idx_telemetry_capacity_activation_entitlement_created', ['entitlementId', 'createdAt'])
export class TelemetryCapacityActivationEvent {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'entitlement_id', type: 'uuid' })
  entitlementId!: string;

  @Column({ name: 'activation_state', type: 'varchar', length: 32 })
  activationState!: TelemetryCapacityActivationState;

  @Column({ name: 'capacity_envelope_version', type: 'integer' })
  capacityEnvelopeVersion!: number;

  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
