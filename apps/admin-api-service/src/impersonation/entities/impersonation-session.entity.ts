import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

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

/**
 * Secret columns on ImpersonationSession that MUST NEVER be serialized onto a
 * read response (DB-ADMIN-HIGH-002). `originalSessionToken` is stored plaintext
 * and `impersonationToken` is a live credential hash; both are set once at
 * creation and consumed internally (validateSession). admin-api registers no
 * global ClassSerializerInterceptor, so `@Exclude()` would be inert — the
 * boundary is enforced by returning the safe view below from every read path.
 * This array is the single source of truth for what to strip.
 */
export const IMPERSONATION_SESSION_SECRET_FIELDS = [
  'originalSessionToken',
  'impersonationToken',
] as const;

/** ImpersonationSession without its secret token columns — the read-response shape. */
export type SafeImpersonationSession = Omit<
  ImpersonationSession,
  (typeof IMPERSONATION_SESSION_SECRET_FIELDS)[number]
>;

/** Strip every secret column so a session can never carry a token onto a read response. */
export function toSafeImpersonationSession(
  session: ImpersonationSession,
): SafeImpersonationSession {
  const safe: Record<string, unknown> = { ...session };
  for (const field of IMPERSONATION_SESSION_SECRET_FIELDS) {
    // Reflect.deleteProperty: same strip without the `delete` operator on a
    // computed key (no-dynamic-delete) — repo-established pattern.
    Reflect.deleteProperty(safe, field);
  }
  return safe as SafeImpersonationSession;
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

  // Revocation audit. Revoking impersonation permission strips an operator's
  // ability to enter tenant data and ends every session they hold; before these
  // columns the only trace was `isActive` flipping and `updatedAt` moving, and
  // `updatedAt` moves for every write, so it cannot say who. NULL on a row that
  // has never been revoked, and on rows revoked before the audit existed —
  // inventing a value there would be worse than admitting there is none.
  @Column({ type: 'uuid', nullable: true })
  revokedBy?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
