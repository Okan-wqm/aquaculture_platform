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
  timestamp: Date;
  details?: Record<string, unknown>;
}

@Entity('impersonation_sessions')
@Index(['superAdminId', 'status'])
@Index(['targetTenantId', 'status'])
@Index(['status', 'expiresAt'])
@Index(['createdAt'])
export class ImpersonationSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  superAdminId: string;

  @Column({ length: 255, nullable: true })
  superAdminEmail: string;

  @Column({ type: 'uuid' })
  targetTenantId: string;

  @Column({ length: 255, nullable: true })
  targetTenantName: string;

  @Column({ type: 'uuid', nullable: true })
  targetUserId: string;

  @Column({ length: 255, nullable: true })
  targetUserEmail: string;

  @Column({ type: 'varchar', length: 50, default: ImpersonationStatus.ACTIVE })
  status: ImpersonationStatus;

  @Column({ type: 'varchar', length: 50 })
  reason: ImpersonationReason;

  @Column({ type: 'text', nullable: true })
  reasonDetails: string;

  @Column({ type: 'text', nullable: true })
  ticketReference: string;

  @Column({ type: 'jsonb', nullable: true })
  permissions: ImpersonationPermissions;

  @Column({ type: 'inet', nullable: true })
  ipAddress: string;

  @Column({ type: 'text', nullable: true })
  userAgent: string;

  @Column({ type: 'text', nullable: true })
  originalSessionToken: string;

  @Column({ type: 'text', nullable: true })
  impersonationToken: string;

  @Column()
  expiresAt: Date;

  @Column({ nullable: true })
  endedAt: Date;

  @Column({ type: 'text', nullable: true })
  endReason: string;

  @Column({ type: 'jsonb', nullable: true })
  actionsPerformed: ImpersonationAction[];

  @Column({ type: 'int', default: 0 })
  actionCount: number;

  @Column({ type: 'jsonb', nullable: true })
  accessedResources: Array<{
    type: string;
    id: string;
    action: string;
    timestamp: Date;
  }>;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('impersonation_permissions')
@Index(['superAdminId', 'isActive'])
export class ImpersonationPermission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  superAdminId: string;

  @Column({ length: 255, nullable: true })
  superAdminEmail: string;

  @Column({ default: true })
  canImpersonate: boolean;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', nullable: true })
  allowedTenants: string[];

  @Column({ type: 'jsonb', nullable: true })
  restrictedTenants: string[];

  @Column({ type: 'jsonb', nullable: true })
  defaultPermissions: ImpersonationPermissions;

  @Column({ type: 'int', default: 60 })
  maxSessionDurationMinutes: number;

  @Column({ type: 'int', default: 3 })
  maxConcurrentSessions: number;

  @Column({ default: true })
  requireReason: boolean;

  @Column({ default: false })
  requireTicketReference: boolean;

  @Column({ default: true })
  notifyTenantAdmin: boolean;

  @Column({ type: 'uuid', nullable: true })
  grantedBy: string;

  @Column({ nullable: true })
  grantedAt: Date;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
