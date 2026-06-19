import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ImpersonationStatus {
  ACTIVE = 'active',
  ENDED = 'ended',
  EXPIRED = 'expired',
  TERMINATED = 'terminated',
}

export enum ImpersonationReason {
  SUPPORT_REQUEST = 'support_request',
  DEBUGGING = 'debugging',
  CONFIGURATION = 'configuration',
  ONBOARDING_ASSISTANCE = 'onboarding_assistance',
  SECURITY_INVESTIGATION = 'security_investigation',
  DATA_VERIFICATION = 'data_verification',
  OTHER = 'other',
}

export interface ImpersonationPermissions {
  canViewData: boolean;
  canModifyData: boolean;
  canAccessSettings: boolean;
  canManageUsers: boolean;
  canViewBilling: boolean;
  canExportData: boolean;
  restrictedModules?: string[];
  allowedModules?: string[];
}

export interface ImpersonationAction {
  action: string;
  resource: string;
  resourceId?: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

@Entity('impersonation_sessions', { schema: 'admin' })
@Index(['superAdminId', 'status'])
@Index(['targetTenantId', 'status'])
@Index(['status', 'expiresAt'])
@Index(['createdAt'])
export class ImpersonationSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  superAdminId!: string;

  @Column({ length: 255, nullable: true })
  superAdminEmail?: string;

  @Column({ type: 'uuid' })
  targetTenantId!: string;

  @Column({ length: 255, nullable: true })
  targetTenantName?: string;

  @Column({ type: 'uuid', nullable: true })
  targetUserId?: string;

  @Column({ length: 255, nullable: true })
  targetUserEmail?: string;

  @Column({ type: 'varchar', length: 50, default: ImpersonationStatus.ACTIVE })
  status!: ImpersonationStatus;

  @Column({ type: 'varchar', length: 50 })
  reason!: ImpersonationReason;

  @Column({ type: 'text', nullable: true })
  reasonDetails?: string;

  @Column({ type: 'text', nullable: true })
  ticketReference?: string;

  @Column({ type: 'jsonb', nullable: true })
  permissions?: ImpersonationPermissions;

  /**
   * SECURITY (ADMIN-MEDIUM-001): Source IP captured at session creation.
   * Every subsequent request MUST be validated against this IP.
   * A stolen token used from a different IP is rejected.
   */
  @Column({ type: 'inet', nullable: true })
  @Index()
  ipAddress?: string;

  @Column({ type: 'text', nullable: true })
  userAgent?: string;

  @Column({ type: 'text', nullable: true })
  originalSessionToken?: string;

  @Column({ type: 'text', nullable: true })
  impersonationToken?: string;

  /**
   * ADMIN-MEDIUM-004: Whether the admin completed MFA before starting this session.
   * Enables the session list UI to show MFA status inline and simplifies
   * guard logic (check one field instead of joining a separate MFA table).
   * Default false -- set to true by the auth flow after MFA challenge passes.
   */
  @Column({ type: 'boolean', default: false })
  mfaCompleted!: boolean;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt?: Date;

  @Column({ type: 'text', nullable: true })
  endReason?: string;

  @Column({ type: 'jsonb', nullable: true })
  actionsPerformed?: ImpersonationAction[];

  @Column({ type: 'int', default: 0 })
  actionCount!: number;

  @Column({ type: 'jsonb', nullable: true })
  accessedResources?: Array<{
    type: string;
    id: string;
    action: string;
    timestamp: string;
  }>;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('impersonation_permissions', { schema: 'admin' })
@Index(['superAdminId', 'isActive'])
export class ImpersonationPermission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  superAdminId!: string;

  @Column({ length: 255, nullable: true })
  superAdminEmail?: string;

  @Column({ default: true })
  canImpersonate!: boolean;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  allowedTenants?: string[];

  @Column({ type: 'jsonb', nullable: true })
  restrictedTenants?: string[];

  @Column({ type: 'jsonb', nullable: true })
  defaultPermissions?: ImpersonationPermissions;

  @Column({ type: 'int', default: 60 })
  maxSessionDurationMinutes!: number;

  @Column({ type: 'int', default: 3 })
  maxConcurrentSessions!: number;

  @Column({ default: true })
  requireReason!: boolean;

  @Column({ default: false })
  requireTicketReference!: boolean;

  @Column({ default: true })
  notifyTenantAdmin!: boolean;

  @Column({ type: 'uuid', nullable: true })
  grantedBy?: string;

  @Column({ type: 'timestamptz', nullable: true })
  grantedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
