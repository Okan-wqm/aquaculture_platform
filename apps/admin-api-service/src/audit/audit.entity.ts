import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AuditAction {
  // Tenant actions
  TENANT_CREATED = 'TENANT_CREATED',
  TENANT_UPDATED = 'TENANT_UPDATED',
  TENANT_SUSPENDED = 'TENANT_SUSPENDED',
  TENANT_ACTIVATED = 'TENANT_ACTIVATED',
  TENANT_DEACTIVATED = 'TENANT_DEACTIVATED',
  TENANT_ARCHIVED = 'TENANT_ARCHIVED',
  TENANT_TIER_CHANGED = 'TENANT_TIER_CHANGED',
  TENANT_LIMITS_UPDATED = 'TENANT_LIMITS_UPDATED',
  TENANT_CREATE_REQUESTED = 'TENANT_CREATE_REQUESTED',
  TENANT_PROVISIONED = 'TENANT_PROVISIONED',
  TENANT_ERASURE_REQUESTED = 'TENANT_ERASURE_REQUESTED',

  // User actions
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_DELETED = 'USER_DELETED',
  USER_ROLE_CHANGED = 'USER_ROLE_CHANGED',
  USER_IMPERSONATED = 'USER_IMPERSONATED',
  USER_PASSWORD_RESET = 'USER_PASSWORD_RESET',
  USER_LOCKED = 'USER_LOCKED',
  USER_UNLOCKED = 'USER_UNLOCKED',

  // Configuration actions
  CONFIG_CREATED = 'CONFIG_CREATED',
  CONFIG_UPDATED = 'CONFIG_UPDATED',
  CONFIG_DELETED = 'CONFIG_DELETED',

  // System actions
  SYSTEM_SETTING_CHANGED = 'SYSTEM_SETTING_CHANGED',
  MAINTENANCE_MODE_ENABLED = 'MAINTENANCE_MODE_ENABLED',
  MAINTENANCE_MODE_DISABLED = 'MAINTENANCE_MODE_DISABLED',

  // Security actions
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  TOKEN_REVOKED = 'TOKEN_REVOKED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',

  // Data actions
  DATA_EXPORT = 'DATA_EXPORT',
  DATA_IMPORT = 'DATA_IMPORT',
  BULK_OPERATION = 'BULK_OPERATION',
  AUDIT_LOG_ACCESSED = 'AUDIT_LOG_ACCESSED',

  // Impersonation actions
  IMPERSONATION_STARTED = 'IMPERSONATION_STARTED',
  IMPERSONATION_ENDED = 'IMPERSONATION_ENDED',
  IMPERSONATION_TERMINATED = 'IMPERSONATION_TERMINATED',
  IMPERSONATION_EXTENDED = 'IMPERSONATION_EXTENDED',
  IMPERSONATION_EXPIRED = 'IMPERSONATION_EXPIRED',

  // Database-explorer actions
  DATABASE_EXPLORER_READ = 'DATABASE_EXPLORER_READ',
  DATABASE_EXPLORER_EXPORT = 'DATABASE_EXPLORER_EXPORT',
  DATABASE_EXPLORER_RAW_SQL = 'DATABASE_EXPLORER_RAW_SQL',

  // Schema / backup actions
  SCHEMA_BACKUP_CREATE_REQUESTED = 'SCHEMA_BACKUP_CREATE_REQUESTED',
  SCHEMA_BACKUP_DELETE_REQUESTED = 'SCHEMA_BACKUP_DELETE_REQUESTED',
  SCHEMA_RESTORE_REQUESTED = 'SCHEMA_RESTORE_REQUESTED',
}

export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

/**
 * admin-api-service's own audit log table — distinct from
 * `shared.audit_logs` (cross-service trail) and `auth.audit_logs`
 * (auth-service operational audit).
 *
 * # Why three audit tables
 *
 * Admin-api's audit captures cross-tenant SUPER_ADMIN actions: tenant
 * impersonation start/stop, tenant suspension, plan changes, etc. These
 * are written under `BypassRlsService.withBypass()` (admin-api wraps every
 * request via AdminBypassRlsInterceptor) and need extended fields
 * (`AuditAction` enum, `AuditSeverity`, structured details) that don't
 * fit `shared.audit_logs`'s tighter schema.
 *
 * # Why explicit `schema: 'admin'`
 *
 * Same rationale as the auth-service AuditLog comment: without a schema
 * decorator, TypeORM defaults to `public`. Combined with autoLoadEntities
 * + transitive import of backend-common's AuditLogEntity (now in `shared`),
 * three classes named `AuditLog` would have collided in TypeORM's metadata
 * store with two of them defaulting to `public`. The schema-invariants CI
 * test would fail. Closes CRITICAL-002 from the 2026-04-14 review.
 */
@Entity('audit_logs', { schema: 'admin' })
@Index(['action'])
@Index(['entityType', 'entityId'])
@Index(['performedBy'])
@Index(['tenantId'])
@Index(['createdAt'])
@Index(['severity'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 50 })
  entityType!: string;

  @Column({ type: 'uuid', nullable: true })
  entityId?: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string;

  @Column({ type: 'varchar', length: 100 })
  performedBy!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  performedByEmail?: string;

  // DBR-MEDIUM-003 cure: native Postgres inet for INSERT-time
  // validation + efficient indexing + operator-side range queries
  // via `<<`. Migration 1788000000000-ConvertAuditIpColumnsToInet
  // performs the column-type rewrite.
  @Column({ type: 'inet', nullable: true })
  ipAddress?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent?: string;

  @Column({ type: 'jsonb', nullable: true })
  details?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  previousValue?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  newValue?: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: AuditSeverity,
    default: AuditSeverity.INFO,
  })
  severity!: AuditSeverity;

  @Column({ type: 'varchar', length: 100, nullable: true })
  requestId?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionId?: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  /**
   * Litigation-hold flag (AUDITTRAIL-HIGH-006 cure).
   *
   * Mirror of the DB-level guard installed by migration
   * 1787800000000. When true, BEFORE DELETE trigger
   * `trg_audit_logs_prevent_legal_hold_delete` refuses deletion at the
   * DB level — preserves SUPER_ADMIN cross-tenant audit evidence even
   * if a buggy retention sweep, misconfigured CASCADE, or compromised
   * application role attempts to drop held rows.
   */
  @Column({ type: 'boolean', default: false })
  legalHold!: boolean;
}
