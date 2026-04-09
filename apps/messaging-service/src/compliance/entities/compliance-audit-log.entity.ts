import {
  Entity,
  PrimaryColumn,
  Column,
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
 * ## Partition Strategy (DB-CRITICAL-003, MSG-CRITICAL-009)
 *
 * This table uses PostgreSQL RANGE partitioning on `created_at` (monthly).
 * PostgreSQL requires the partition key to be part of the primary key.
 * Therefore the PK is composite: `(id, createdAt)`.
 *
 * Actual partition DDL (CREATE TABLE ... PARTITION BY RANGE, monthly
 * partition creation cron) is defined in `init-messaging-schema.sql`.
 * TypeORM `synchronize=false`; schema managed via migrations only.
 *
 * Partition benefits:
 * - Partition pruning on date-range audit queries (GDPR Article 30 compliance)
 * - Fast DROP PARTITION for data retention (instead of slow DELETE)
 * - Parallel sequential scans within partitions
 *
 * @see ADR-012 Phase 3 (Compliance Audit Log)
 */
@ObjectType()
@Entity('compliance_audit_log')
@Index('idx_compliance_audit_tenant_created', ['tenantId', 'createdAt'])
@Index('idx_compliance_audit_user_created', ['userId', 'createdAt'])
@Index('idx_compliance_audit_action_created', ['action', 'createdAt'])
export class ComplianceAuditLog {
  // WHY: Composite PK (id, createdAt) is required because PostgreSQL partitioned
  // tables must include the partition key in the primary key. Without createdAt in
  // the PK, the table cannot be partitioned by RANGE on created_at.
  // @see DB-CRITICAL-003, MSG-CRITICAL-009
  @Field(() => ID)
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
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

  // IMPORTANT: createdAt is part of the composite PK for partition compatibility.
  // PostgreSQL RANGE partition key must be in the PK.
  @Field()
  @PrimaryColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
