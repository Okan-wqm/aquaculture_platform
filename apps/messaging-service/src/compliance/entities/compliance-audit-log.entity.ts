import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

/**
 * All auditable actions within the messaging domain.
 * @see ADR-012 Phase 3 (Compliance Audit Log)
 */
export enum ComplianceAction {
  MESSAGE_SEND = 'message_send',
  MESSAGE_EDIT = 'message_edit',
  MESSAGE_DELETE = 'message_delete',
  CHANNEL_CREATE = 'channel_create',
  CHANNEL_ARCHIVE = 'channel_archive',
  MEMBER_ADD = 'member_add',
  MEMBER_REMOVE = 'member_remove',
  MESSAGE_EXPORT = 'message_export',
  DATA_ANONYMIZE = 'data_anonymize',
  RETENTION_SET = 'retention_set',
  LEGAL_HOLD_TOGGLE = 'legal_hold_toggle',
}

registerEnumType(ComplianceAction, { name: 'ComplianceAction' });

/**
 * Compliance audit log entity — records every messaging operation for
 * regulatory and forensic purposes.
 *
 * Partitioned by createdAt (monthly, same strategy as messages table).
 * TypeORM synchronize=false; managed via migrations.
 *
 * @see ADR-012 Phase 3 (Compliance Audit Log)
 */
@ObjectType()
@Entity('compliance_audit_log')
@Index('idx_compliance_audit_tenant_created', ['tenantId', 'createdAt'])
@Index('idx_compliance_audit_user_created', ['userId', 'createdAt'])
@Index('idx_compliance_audit_action_created', ['action', 'createdAt'])
export class ComplianceAuditLog {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ type: 'uuid' })
  tenantId: string;

  @Field()
  @Column({ type: 'uuid' })
  userId: string;

  @Field(() => ComplianceAction)
  @Column({ type: 'varchar', length: 30 })
  action: ComplianceAction;

  @Field()
  @Column({ type: 'varchar', length: 50 })
  resourceType: string;

  @Field()
  @Column({ type: 'uuid' })
  resourceId: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 512, nullable: true })
  userAgent: string | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
