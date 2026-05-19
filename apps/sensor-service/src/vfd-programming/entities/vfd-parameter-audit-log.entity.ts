import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { VfdAuditAction } from '../../vfd/entities/vfd.enums';

/**
 * VFD Parameter Audit Log Entity
 * Immutable audit trail for IEC 62443 compliance.
 * No UpdateDateColumn — records are never modified after creation.
 */
@ObjectType({ description: 'Immutable VFD parameter change audit log' })
@Entity('vfd_parameter_audit_logs')
@Index(['tenantId', 'vfdDeviceId', 'timestamp'])
@Index(['changeSetId'])
export class VfdParameterAuditLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid', name: 'vfd_device_id' })
  vfdDeviceId!: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'change_set_id', nullable: true })
  changeSetId?: string;

  @Field()
  @Column({ type: 'varchar', length: 100, name: 'parameter_name' })
  parameterName!: string;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'numeric', precision: 15, scale: 6, name: 'previous_value', nullable: true })
  previousValue?: number;

  @Field(() => Float)
  @Column({ type: 'numeric', precision: 15, scale: 6, name: 'new_value' })
  newValue!: number;

  @Field(() => VfdAuditAction)
  @Column({ type: 'varchar', length: 30 })
  action!: VfdAuditAction;

  @Field()
  @Column({ type: 'varchar', length: 255, name: 'performed_by' })
  performedBy!: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 45, name: 'client_ip', nullable: true })
  clientIp?: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 500, name: 'user_agent', nullable: true })
  userAgent?: string;

  @Field({ nullable: true })
  @Column({ type: 'uuid', name: 'automation_rule_id', nullable: true })
  automationRuleId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  @CreateDateColumn({ type: 'timestamp with time zone' })
  timestamp!: Date;
}
