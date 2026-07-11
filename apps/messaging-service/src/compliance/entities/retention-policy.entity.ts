import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

/**
 * Retention policy entity — configurable per tenant or per channel.
 *
 * When channelId is null, the policy applies to the entire tenant (default policy).
 * When channelId is set, it overrides the tenant-level policy for that channel.
 *
 * Allowed retentionDays values: 90, 365, 1095 (3 years), -1 (indefinite).
 *
 * @see ADR-012 Phase 3 (Compliance)
 */
@ObjectType()
@Entity('retention_policies')
@Unique('uq_retention_tenant_channel', ['tenantId', 'channelId'])
@Index('idx_retention_tenant', ['tenantId'])
export class RetentionPolicy {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  channelId!: string | null;

  /**
   * Number of days to retain messages.
   * -1 means indefinite (no automatic deletion).
   * Typical values: 90, 365, 1095.
   */
  @Field(() => Int)
  @Column({ type: 'integer', default: 365 })
  retentionDays!: number;

  @Field()
  @Column({ type: 'uuid' })
  createdBy!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
