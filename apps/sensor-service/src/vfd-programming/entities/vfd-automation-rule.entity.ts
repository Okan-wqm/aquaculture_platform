import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

/**
 * Trigger condition structure for automation rules
 */
export interface VfdAutomationTriggerCondition {
  conditions: Array<{
    sensorTag: string;
    operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
    value: number;
  }>;
  logicalOperator: 'AND' | 'OR';
  cooldownSeconds: number;
}

/**
 * Parameter change instruction for automation rules
 */
export interface VfdAutomationParameterChange {
  parameterName: string;
  value: number;
}

/**
 * VFD Automation Rule Entity
 * Event-driven automation rules that create change sets
 * based on sensor conditions.
 */
@ObjectType({ description: 'VFD automation rule for event-driven parameter changes' })
@Entity('vfd_automation_rules')
@Index(['tenantId', 'isActive'])
export class VfdAutomationRule {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', name: 'trigger_condition' })
  triggerCondition!: VfdAutomationTriggerCondition;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', name: 'target_vfd_device_ids' })
  targetVfdDeviceIds!: string[];

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', name: 'parameter_changes' })
  parameterChanges!: VfdAutomationParameterChange[];

  @Field()
  @Column({ type: 'boolean', name: 'requires_approval', default: true })
  requiresApproval!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 100 })
  priority!: number;

  @Field()
  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamp with time zone', name: 'last_triggered_at', nullable: true })
  lastTriggeredAt?: Date;

  @Field(() => Int)
  @Column({ type: 'int', name: 'trigger_count', default: 0 })
  triggerCount!: number;

  @Field()
  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;
}
