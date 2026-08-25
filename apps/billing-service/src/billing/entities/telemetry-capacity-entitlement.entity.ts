import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({
  schema: 'billing',
  name: 'telemetry_capacity_entitlements',
})
@Index('uq_billing_telemetry_capacity_operation', ['operationId'], {
  unique: true,
})
@Index('uq_billing_telemetry_capacity_tenant_version', ['tenantId', 'entitlementVersion'], {
  unique: true,
})
export class BillingTelemetryCapacityEntitlement {
  @PrimaryColumn({ name: 'entitlement_id', type: 'uuid' })
  entitlementId!: string;

  @Column({ name: 'operation_id', type: 'uuid' })
  operationId!: string;

  @Column({ name: 'reservation_id', type: 'uuid' })
  reservationId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'entitlement_version', type: 'integer' })
  entitlementVersion!: number;

  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  @Column({ name: 'capacity_envelope_version', type: 'integer' })
  capacityEnvelopeVersion!: number;

  @Column({
    name: 'sustained_ingress_messages_per_second',
    type: 'double precision',
  })
  sustainedIngressMessagesPerSecond!: number;

  @Column({ name: 'sustained_metric_rows_per_minute', type: 'double precision' })
  sustainedMetricRowsPerMinute!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
