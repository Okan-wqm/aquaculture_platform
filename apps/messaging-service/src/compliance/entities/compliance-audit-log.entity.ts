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
 * ## Immutability (MSG-HIGH-021)
 *
 * This table MUST have a PostgreSQL trigger that prevents UPDATE and DELETE:
 *
 * ```sql
 * CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
 * RETURNS TRIGGER AS $$
 * BEGIN
 *   RAISE EXCEPTION 'compliance_audit_log is immutable: % not allowed', TG_OP;
 * END;
 * $$ LANGUAGE plpgsql;
 *
 * CREATE TRIGGER trg_audit_log_immutable
 *   BEFORE UPDATE OR DELETE ON compliance_audit_log
 *   FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
 * ```
 *
 * This trigger should be installed via migration. Once installed, UPDATE and
 * DELETE on audit_log rows will throw an exception at the database level,
 * making audit record tampering structurally impossible.
 *
 * ## Schema authority (INFRA-CRITICAL-011)
 *
 * This table is managed by the active TypeORM migration ledger only.
 * Service-local init SQL is forbidden because it creates a second, stale DDL
 * source outside the migration table and outside SchemaDriftValidator evidence.
 *
 * The PK is composite: `(id, createdAt)`. Keeping `createdAt` in the key
 * preserves compatibility with an audited future partitioning migration without
 * letting runtime synchronize or an init script mutate table shape.
 *
 * @see MSG-HIGH-021 (audit records immutability protection)
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
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid' })
  userId!: string;

  @Field(() => ComplianceAction)
  @Column({ type: 'varchar', length: 30 })
  action!: ComplianceAction;

  @Field()
  @Column({ type: 'varchar', length: 50 })
  resourceType!: string;

  @Field()
  @Column({ type: 'uuid' })
  resourceId!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress!: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  // IMPORTANT: createdAt is part of the composite PK so future audited
  // partitioning can keep entity identity stable without runtime DDL.
  @Field()
  @PrimaryColumn({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
