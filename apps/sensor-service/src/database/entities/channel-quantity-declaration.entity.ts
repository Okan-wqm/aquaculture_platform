import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What changed a channel's declared quantity. */
export enum QuantityDeclarationReason {
  /** An operator declared a quantity. */
  DECLARED = 'declared',
  /** An operator cleared the declaration; the key's own meaning stands. */
  CLEARED = 'cleared',
  /** Rediscovery re-created the channel and its unit no longer fit the declaration. */
  REDISCOVERY_CLEARED = 'rediscovery_cleared',
}

registerEnumType(QuantityDeclarationReason, { name: 'QuantityDeclarationReason' });

/**
 * Append-only history of what a channel was declared to measure.
 *
 * A declaration reinterprets every value the channel has reported — `ammonia`
 * read as NH3-N or as TAN differs ten- to a hundredfold — so who changed it,
 * when, and from what must be on record, as calibration is
 * (`calibration_events`). The channel's `declared_quantity` column is the
 * current state; this ledger is its history, written in the same transaction
 * by the one write path. Keyed by (sensor_id, channel_key) as well as the
 * channel id, because rediscovery re-creates channels under new ids while the
 * device's key — and what it means — stays.
 *
 * Per-tenant table (no `schema:`), cloned into every tenant schema
 * (MODULE_SCHEMAS sensor tables).
 */
@ObjectType({ description: 'Immutable record of one change to a channel’s declared quantity' })
@Entity('channel_quantity_declarations')
@Index(['tenantId', 'sensorId', 'channelKey', 'declaredAt'])
export class ChannelQuantityDeclaration {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'sensor_id' })
  sensorId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'channel_id' })
  channelId!: string;

  @Field()
  @Column({ name: 'channel_key', length: 100 })
  channelKey!: string;

  /** The declared quantity id; null when the declaration was cleared. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 32, nullable: true })
  quantity!: string | null;

  /** The channel's unit as of this change. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  unit!: string | null;

  @Field(() => QuantityDeclarationReason)
  @Column({ type: 'varchar', length: 32 })
  reason!: QuantityDeclarationReason;

  @Field()
  @Column({ name: 'declared_by', length: 255 })
  declaredBy!: string;

  @Field()
  @CreateDateColumn({ name: 'declared_at', type: 'timestamptz' })
  declaredAt!: Date;
}
