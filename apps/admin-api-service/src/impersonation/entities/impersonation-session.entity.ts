import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import type {
  AdminImpersonationActionV1,
  AdminImpersonationPermissionV1,
  AdminImpersonationPermissionsV1,
  AdminImpersonationSessionV1,
} from '@platform/admin-http-contracts';

/**
 * RBAC-MEDIUM-009 (M7): the ONE impersonation session-duration ceiling, in
 * minutes. Policy: impersonation sessions are short-lived support windows —
 * absolute cap 1 hour. Every enforcement point derives from this constant
 * (request DTO @Max, grant DTO @Max, extend DTO @Max, and the service-side
 * use-time clamps that neutralize historical grants stored before the cap).
 * Raising the policy is a deliberate single-line change here, never a
 * per-DTO edit.
 */
export const IMPERSONATION_MAX_SESSION_MINUTES = 60;
export const IMPERSONATION_MAX_CONCURRENT_SESSIONS = 10;

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

export type ImpersonationPermissions = AdminImpersonationPermissionsV1;

export type ImpersonationAction = AdminImpersonationActionV1;

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

/** Public JSON boundary owned by the versioned admin HTTP contract library. */
export type SafeImpersonationSession = AdminImpersonationSessionV1;

/**
 * Project an entity through an explicit allowlist. A future entity column is
 * private by default, so credentials and high-volume detail cannot leak merely
 * because a persistence model gained a field.
 */
export function toSafeImpersonationSession(
  session: ImpersonationSession,
): SafeImpersonationSession {
  return {
    id: session.id,
    superAdminId: session.superAdminId,
    superAdminEmail: session.superAdminEmail,
    targetTenantId: session.targetTenantId,
    targetTenantName: session.targetTenantName,
    targetUserId: session.targetUserId,
    targetUserEmail: session.targetUserEmail,
    status: session.status,
    reason: session.reason,
    reasonDetails: session.reasonDetails,
    ticketReference: session.ticketReference,
    permissions: session.permissions ? { ...session.permissions } : undefined,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    mfaCompleted: session.mfaCompleted,
    expiresAt: session.expiresAt.toISOString(),
    endedAt: session.endedAt?.toISOString(),
    endReason: session.endReason,
    actionCount: session.actionCount,
    metadata: session.metadata ? { ...session.metadata } : undefined,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

@Entity('impersonation_permissions', { schema: 'admin' })
@Index('UQ_admin_impersonation_permissions_super_admin', ['superAdminId'], { unique: true })
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

  @Column({ default: false })
  notifyTenantAdmin!: boolean;

  @Column({ type: 'uuid', nullable: true })
  grantedBy?: string;

  @Column({ type: 'timestamptz', nullable: true })
  grantedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'uuid', nullable: true })
  revokedBy?: string;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @Column({ type: 'text', nullable: true })
  revocationReason?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

export function toAdminImpersonationPermissionV1(
  permission: ImpersonationPermission,
): AdminImpersonationPermissionV1 {
  return {
    id: permission.id,
    superAdminId: permission.superAdminId,
    superAdminEmail: permission.superAdminEmail,
    canImpersonate: permission.canImpersonate,
    isActive: permission.isActive,
    allowedTenants: permission.allowedTenants ? [...permission.allowedTenants] : undefined,
    restrictedTenants: permission.restrictedTenants ? [...permission.restrictedTenants] : undefined,
    defaultPermissions: permission.defaultPermissions
      ? { ...permission.defaultPermissions }
      : undefined,
    maxSessionDurationMinutes: permission.maxSessionDurationMinutes,
    maxConcurrentSessions: permission.maxConcurrentSessions,
    requireReason: permission.requireReason,
    requireTicketReference: permission.requireTicketReference,
    notifyTenantAdmin: permission.notifyTenantAdmin,
    grantedBy: permission.grantedBy,
    grantedAt: permission.grantedAt?.toISOString(),
    revokedBy: permission.revokedBy,
    revokedAt: permission.revokedAt?.toISOString(),
    revocationReason: permission.revocationReason,
    expiresAt: permission.expiresAt?.toISOString(),
    notes: permission.notes,
    createdAt: permission.createdAt.toISOString(),
    updatedAt: permission.updatedAt.toISOString(),
  };
}
