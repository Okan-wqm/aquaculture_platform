import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One `suderra.result.v1` document a Suderra OS device reported (ADR-048
 * DEC-27): what root's installer, update worker, lockdown, health gate and
 * time helper concluded, stored per device as device-reported evidence — the
 * fleet view of the installed version, the verification results, the
 * rollbacks and the lockdown state.
 *
 * An unsigned observation, never authority: nothing on the cloud treats a row
 * as proof that a device is in a state. `document` is the document as the
 * device sent it; the typed columns are read from it for queries.
 *
 * The contract deduplicates on (device_id, seq), `seq` being monotonic per
 * device and assigned by root, so the pair is the row's identity and a
 * republication after a reconnect stores nothing new.
 *
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@ObjectType('EdgeDeviceResult')
@Entity('edge_device_results')
@Index('uq_edge_device_results_device_seq', ['deviceId', 'seq'], { unique: true })
@Index('idx_edge_device_results_kind', ['tenantId', 'deviceId', 'kind', 'seq'])
@Index('idx_edge_device_results_received', ['deviceId', 'receivedAt'])
export class EdgeDeviceResult {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  /** Monotonic per device, assigned by root (a safe integer: result.schema.json `sequence`). */
  @Field(() => Float)
  @Column({
    type: 'bigint',
    name: 'seq',
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number): number => Number(value),
    },
  })
  seq!: number;

  @Field()
  @Column({ type: 'varchar', length: 32 })
  kind!: string;

  @Field()
  @Column({ type: 'varchar', length: 16 })
  outcome!: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  reason!: string | null;

  /** When root concluded it, on the clock `timeState` describes: not necessarily true time. */
  @Field()
  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;

  @Field()
  @Column({ type: 'varchar', length: 32, name: 'time_state' })
  timeState!: string;

  @Field()
  @Column({ type: 'varchar', length: 32, name: 'board_profile' })
  boardProfile!: string;

  @Field()
  @Column({ type: 'varchar', length: 32, name: 'os_version' })
  osVersion!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  subject!: Record<string, unknown> | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  /** The document exactly as the device sent it (parsed). */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  document!: Record<string, unknown>;

  /** sha256 of the message bytes, so a seq reused with other content is detectable. */
  @Column({ type: 'char', length: 64, name: 'document_sha256' })
  documentSha256!: string;

  @Field()
  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}

/** The newest result of one kind: the fleet view's "last known" per kind. */
@ObjectType('EdgeDeviceResultSummary')
export class EdgeDeviceResultSummary {
  @Field(() => ID)
  deviceId!: string;

  @Field(() => [EdgeDeviceResult])
  latestByKind!: EdgeDeviceResult[];

  @Field(() => Int)
  stored!: number;
}
