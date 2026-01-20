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
}

export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

@Entity('audit_logs')
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

  @Column({ type: 'varchar', length: 45, nullable: true })
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
}
