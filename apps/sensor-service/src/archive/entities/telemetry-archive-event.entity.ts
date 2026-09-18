import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Task 4 (SENSOR-HIGH-094): one append-only state transition of a tenant's
 * telemetry archive lifecycle.
 *
 * State machine: EXPORT_STARTED → EXPORTED → VERIFIED → DROPPED; FAILED is
 * always a NEW event (rows are never UPDATEd — the current state per
 * operation is the newest transition). A raw chunk drop is legal only when
 * the newest event for its range is VERIFIED; the retention orchestrator
 * enforces that and nothing else may call drop_chunks on sensor_metrics.
 *
 * PER-TENANT (ADR-011): the ledger carries a tenant_id discriminator, so it
 * is cloned into every tenant_<16hex> schema — a tenant's archive history
 * drops with its schema at erasure, leaving no cross-tenant residue. The
 * retention orchestrator addresses it inside the tenant's own schema.
 */
export const TELEMETRY_ARCHIVE_STATES = [
  'EXPORT_STARTED',
  'EXPORTED',
  'VERIFIED',
  'DROPPED',
  'FAILED',
] as const;

export type TelemetryArchiveState = (typeof TELEMETRY_ARCHIVE_STATES)[number];

@ObjectType()
@Entity('telemetry_archive_events')
@Index('idx_telemetry_archive_events_operation', ['operationId', 'occurredAt'])
@Index('idx_telemetry_archive_events_tenant_range', ['tenantId', 'rangeStart', 'rangeEnd'])
export class TelemetryArchiveEvent {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** All transitions of one logical export/drop share this id. */
  @Field()
  @Column({ name: 'operation_id', type: 'uuid' })
  operationId!: string;

  @Field()
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  /** tenant_<16hex> — the platform SSoT shape, validated at write. */
  @Field()
  @Column({ name: 'tenant_schema', type: 'varchar', length: 23 })
  tenantSchema!: string;

  @Field(() => GraphQLISODateTime)
  @Column({ name: 'range_start', type: 'timestamptz' })
  rangeStart!: Date;

  @Field(() => GraphQLISODateTime)
  @Column({ name: 'range_end', type: 'timestamptz' })
  rangeEnd!: Date;

  @Field()
  @Column({ name: 'state', type: 'enum', enum: TELEMETRY_ARCHIVE_STATES })
  state!: TelemetryArchiveState;

  /** Source COUNT(*) captured at export time — the verify comparator. */
  @Field({ nullable: true })
  @Column({ name: 'source_row_count', type: 'bigint', nullable: true })
  sourceRowCount?: string | null;

  /** txid_current_snapshot() at export — provenance for the manifest. */
  @Field({ nullable: true })
  @Column({ name: 'source_snapshot', type: 'text', nullable: true })
  sourceSnapshot?: string | null;

  /** Parquet object key in the tenant's bucket. */
  @Field({ nullable: true })
  @Column({ name: 'object_key', type: 'text', nullable: true })
  objectKey?: string | null;

  @Field({ nullable: true })
  @Column({ name: 'parquet_sha256', type: 'varchar', length: 64, nullable: true })
  parquetSha256?: string | null;

  @Field(() => GraphQLISODateTime)
  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  /** Who/what drove the transition (service identity or operator id). */
  @Field()
  @Column({ name: 'actor', type: 'text' })
  actor!: string;
}
