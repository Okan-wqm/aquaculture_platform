import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { VfdChangeSetStatus } from '../../vfd/entities/vfd.enums';
import { VfdChangeSetItem } from './vfd-change-set-item.entity';

/**
 * VFD Change Set Entity
 * Batch parameter change request — the core Maker-Checker entity.
 * Implements IEC 62443 SL-2 compliant approval workflow.
 */
@ObjectType({ description: 'VFD parameter change set (Maker-Checker)' })
@Entity('vfd_change_sets', { schema: 'sensor' })
@Index(['tenantId', 'vfdDeviceId'])
@Index(['tenantId', 'status'])
export class VfdChangeSet {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'vfd_device_id' })
  vfdDeviceId!: string;

  @Field(() => VfdChangeSetStatus)
  @Column({
    type: 'varchar',
    length: 30,
    default: VfdChangeSetStatus.DRAFT,
  })
  status!: VfdChangeSetStatus;

  @Field()
  @Column({ type: 'text' })
  description!: string;

  @Field()
  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'approved_by', nullable: true })
  approvedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'rejected_by', nullable: true })
  rejectedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', name: 'rejection_reason', nullable: true })
  rejectionReason?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamp with time zone', name: 'applied_at', nullable: true })
  appliedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamp with time zone', name: 'verified_at', nullable: true })
  verifiedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamp with time zone', name: 'scheduled_at', nullable: true })
  scheduledAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'automation_rule_id', nullable: true })
  automationRuleId?: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'rollback_of_id', nullable: true })
  rollbackOfId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => [VfdChangeSetItem])
  @OneToMany(() => VfdChangeSetItem, (item) => item.changeSet, {
    cascade: true,
    eager: true,
  })
  items!: VfdChangeSetItem[];

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;
}
