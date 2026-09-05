import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import {
  TelemetryCapacityEntitlementState,
  TelemetryCapacityEntitlementValues,
} from '@platform/event-contracts';

// GraphQL enum registration mirrors the subscription-entity pattern so the
// admin panel can render the state machine without a hand-copied literal.
registerEnumType(TelemetryCapacityEntitlementState, {
  name: 'TelemetryCapacityEntitlementState',
});

/**
 * One telemetry capacity entitlement version for a tenant (Task 8,
 * SENSOR-HIGH-011). Append-mostly: a state transition SUPERSEDES/RELEASES a
 * row and inserts the next version — rows are never mutated in place except
 * the state column, which only ever moves forward through the machine.
 *
 * Platform-level table (billing is cross-tenant by design, D14): declared
 * `schema: 'billing'` per ADR-011 and NOT cloned into tenant schemas.
 */
@ObjectType()
@Entity({ schema: 'billing', name: 'telemetry_capacity_entitlements' })
// Exactly one ACTIVE version per tenant — the structural half of the
// reservation invariant (the service's transactional CAS is the other).
@Index('uq_tce_one_active_per_tenant', ['tenantId'], {
  unique: true,
  where: `"state" = 'ACTIVE'`,
})
// One durable PENDING_CAPACITY reservation per tenant version — a retried
// reservation command must not stack pending rows.
@Index('uq_tce_one_pending_per_tenant', ['tenantId'], {
  unique: true,
  where: `"state" = 'PENDING_CAPACITY'`,
})
@Index('idx_tce_tenant_version', ['tenantId', 'version'])
export class TelemetryCapacityEntitlementEntity {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  /** Monotonic per-tenant version — 1, 2, 3, … */
  @Field(() => Int)
  @Column({ type: 'integer' })
  version!: number;

  @Field(() => TelemetryCapacityEntitlementState)
  @Column({ type: 'enum', enum: TelemetryCapacityEntitlementState })
  state!: TelemetryCapacityEntitlementState;

  /** M axis — MQTT msg/s the tenant may ingest. */
  @Field(() => Int)
  @Column({ type: 'integer' })
  m!: number;

  /** R axis — PG rows/s the ingestion fans out to. */
  @Field(() => Int)
  @Column({ type: 'integer' })
  r!: number;

  /**
   * Envelope headroom (M axis) observed at reservation time. Diagnostic:
   * explains WHY a reservation landed PENDING_CAPACITY without a second
   * platform-wide SUM query later.
   */
  @Field(() => Int, { nullable: true })
  @Column({ name: 'observed_remaining_m', type: 'integer', nullable: true })
  observedRemainingM?: number | null;

  @Field()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** Flat snapshot for events/API responses. */
  toValues(): TelemetryCapacityEntitlementValues {
    return { m: this.m, r: this.r };
  }
}
