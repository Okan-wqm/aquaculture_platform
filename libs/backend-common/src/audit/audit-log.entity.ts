import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Severity level for audit log entries
 */
export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * AuditLogEntity - Immutable audit trail record
 *
 * Stored in the public/shared schema (not per-tenant) so that
 * audit records survive even if a tenant schema is dropped.
 * Tenant isolation is enforced via the tenantId column + composite indexes.
 *
 * NO soft delete - audit logs are immutable by design.
 */
@Entity('audit_logs')
@Index('IDX_audit_log_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_audit_log_user_tenant', ['userId', 'tenantId'])
@Index('IDX_audit_log_resource', ['resource', 'resourceId', 'tenantId'])
@Index('IDX_audit_log_action', ['action', 'tenantId'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Action performed, e.g. 'CREATE_FARM', 'UPDATE_BATCH', 'ASSIGN_ROLE'
   */
  @Column({ type: 'varchar', length: 100 })
  action!: string;

  /**
   * Resource/entity type, e.g. 'Farm', 'Batch', 'TenantRole'
   */
  @Column({ type: 'varchar', length: 100 })
  resource!: string;

  /**
   * ID of the affected resource (extracted from mutation result)
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  resourceId!: string | null;

  /**
   * ID of the user who performed the action
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userId!: string | null;

  /**
   * Email of the user (denormalized for easy display)
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userEmail!: string | null;

  /**
   * Tenant ID for multi-tenant isolation
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  tenantId!: string | null;

  /**
   * Database schema name (e.g. 'tenant_abc123')
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  schemaName!: string | null;

  /**
   * Additional metadata: sanitized args, description, etc.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  /**
   * Client IP address
   */
  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;

  /**
   * Client user agent string
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  /**
   * Severity level
   */
  @Column({
    type: 'enum',
    enum: AuditSeverity,
    default: AuditSeverity.INFO,
  })
  severity!: AuditSeverity;

  /**
   * Request correlation ID for distributed tracing
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId!: string | null;

  /**
   * Timestamp of the audit event (immutable)
   */
  @CreateDateColumn()
  createdAt!: Date;
}
