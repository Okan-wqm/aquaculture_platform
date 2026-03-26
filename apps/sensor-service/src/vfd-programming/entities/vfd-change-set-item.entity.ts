import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

import { VfdChangeSetItemStatus } from '../../vfd/entities/vfd.enums';
import { VfdChangeSet } from './vfd-change-set.entity';

/**
 * VFD Change Set Item Entity
 * Individual parameter change within a change set.
 * Tracks requested, previous, and applied values for verification.
 */
@ObjectType({ description: 'Individual parameter change within a VFD change set' })
@Entity('vfd_change_set_items')
@Index(['changeSetId'])
export class VfdChangeSetItem {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'change_set_id' })
  changeSetId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'parameter_definition_id' })
  parameterDefinitionId!: string;

  @Field()
  @Column({ type: 'varchar', length: 100, name: 'parameter_name' })
  parameterName!: string;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', name: 'previous_value', nullable: true })
  previousValue?: number;

  @Field(() => Float)
  @Column({ type: 'float', name: 'requested_value' })
  requestedValue!: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', name: 'applied_value', nullable: true })
  appliedValue?: number;

  @Field(() => VfdChangeSetItemStatus)
  @Column({
    type: 'varchar',
    length: 20,
    default: VfdChangeSetItemStatus.PENDING,
  })
  status!: VfdChangeSetItemStatus;

  @Field({ nullable: true })
  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamp with time zone', name: 'applied_at', nullable: true })
  appliedAt?: Date;

  @ManyToOne(() => VfdChangeSet, (cs) => cs.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'change_set_id' })
  changeSet!: VfdChangeSet;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;
}
