import { ADMIN_MESSAGING_RPC_SUBJECTS_V1 } from './messaging-compliance';

export * from './messaging-compliance';

/** Version of the zero-dependency admin HTTP/NATS boundary read models. */
export const ADMIN_HTTP_CONTRACT_VERSION = 1 as const;

/**
 * The request/reply subject is part of the same contract as its payload.
 * Producers and both gateway consumers import this value instead of copying it.
 */
export const ADMIN_MESSAGING_AUDIT_QUERY_SUBJECT_V1 = ADMIN_MESSAGING_RPC_SUBJECTS_V1.getAuditLog;

export type AdminComplianceFrameworkV1 = 'gdpr' | 'ccpa' | 'hipaa' | 'pci_dss' | 'sox' | 'iso27001';

export interface AdminComplianceRequirementV1 {
  readonly id: string;
  readonly framework: AdminComplianceFrameworkV1;
  readonly requirement: string;
  readonly description: string;
  readonly category: string;
  readonly isMandatory: boolean;
  readonly verificationMethod: string;
}

export type AdminComplianceCheckStatusV1 =
  | 'compliant'
  | 'non_compliant'
  | 'partial'
  | 'not_applicable';

export interface AdminComplianceCheckResultV1 {
  readonly requirement: AdminComplianceRequirementV1;
  readonly status: AdminComplianceCheckStatusV1;
  readonly details: string;
  readonly evidence?: string;
  readonly remediation?: string;
}

export interface AdminImpersonationActionV1 {
  readonly action: string;
  readonly resource: string;
  readonly resourceId?: string;
  readonly timestamp: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AdminImpersonationPermissionsV1 {
  readonly canViewData: boolean;
  readonly canModifyData: boolean;
  readonly canAccessSettings: boolean;
  readonly canManageUsers: boolean;
  readonly canViewBilling: boolean;
  readonly canExportData: boolean;
  readonly restrictedModules?: readonly string[];
  readonly allowedModules?: readonly string[];
}

export interface AdminImpersonationPermissionV1 {
  readonly id: string;
  readonly superAdminId: string;
  readonly superAdminEmail?: string;
  readonly canImpersonate: boolean;
  readonly isActive: boolean;
  readonly allowedTenants?: readonly string[];
  readonly restrictedTenants?: readonly string[];
  readonly defaultPermissions?: AdminImpersonationPermissionsV1;
  readonly maxSessionDurationMinutes: number;
  readonly maxConcurrentSessions: number;
  readonly requireReason: boolean;
  readonly requireTicketReference: boolean;
  readonly notifyTenantAdmin: boolean;
  readonly grantedBy?: string;
  readonly grantedAt?: string;
  readonly revokedBy?: string;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
  readonly expiresAt?: string;
  readonly notes?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Validated browser-to-controller grant contract; actor identity is JWT-owned. */
export interface AdminGrantImpersonationPermissionV1 {
  readonly superAdminId: string;
  readonly superAdminEmail?: string;
  readonly allowedTenants: readonly string[];
  readonly restrictedTenants?: readonly string[];
  readonly defaultPermissions?: AdminImpersonationPermissionsV1;
  readonly maxSessionDurationMinutes?: number;
  readonly maxConcurrentSessions?: number;
  readonly requireReason?: boolean;
  readonly requireTicketReference?: boolean;
  readonly expiresAt?: string;
  readonly notes?: string;
}

/** Validated start request; operator identity and network context are server-owned. */
export interface AdminStartImpersonationRequestV1 {
  readonly targetTenantId: string;
  readonly targetTenantName?: string;
  readonly targetUserId?: string;
  readonly targetUserEmail?: string;
  readonly reason: AdminImpersonationReasonV1;
  readonly reasonDetails?: string;
  readonly ticketReference?: string;
  readonly permissions?: Partial<AdminImpersonationPermissionsV1>;
  readonly durationMinutes?: number;
}

export type AdminImpersonationSessionStatusV1 = 'active' | 'ended' | 'expired' | 'terminated';

export type AdminImpersonationReasonV1 =
  | 'support_request'
  | 'debugging'
  | 'configuration'
  | 'onboarding_assistance'
  | 'security_investigation'
  | 'data_verification'
  | 'other';

export const ADMIN_IMPERSONATION_SESSION_SCOPES_V1 = ['active', 'history'] as const;

export type AdminImpersonationSessionScopeV1 =
  (typeof ADMIN_IMPERSONATION_SESSION_SCOPES_V1)[number];

/** JSON-safe session summary returned by every read and mutation endpoint. */
export interface AdminImpersonationSessionV1 {
  readonly id: string;
  readonly superAdminId: string;
  readonly superAdminEmail?: string;
  readonly targetTenantId: string;
  readonly targetTenantName?: string;
  readonly targetUserId?: string;
  readonly targetUserEmail?: string;
  readonly status: AdminImpersonationSessionStatusV1;
  readonly reason: AdminImpersonationReasonV1;
  readonly reasonDetails?: string;
  readonly ticketReference?: string;
  readonly permissions?: AdminImpersonationPermissionsV1;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly mfaCompleted: boolean;
  readonly expiresAt: string;
  readonly endedAt?: string;
  readonly endReason?: string;
  readonly actionCount: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminStartedImpersonationSessionV1 extends AdminImpersonationSessionV1 {
  /** Raw bearer credential, revealed exactly once by the start operation. */
  readonly impersonationToken: string;
}

export interface AdminImpersonationPermissionCheckV1 {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly permission?: AdminImpersonationPermissionV1;
}

export interface AdminImpersonationPermissionRevocationV1 {
  readonly reason: string;
}

export interface AdminImpersonationStatsV1<TSession> {
  readonly window: {
    readonly days: number;
    readonly startAt: string;
    readonly endAt: string;
  };
  readonly activeSessions: number;
  readonly totalSessions: number;
  readonly actionsLogged: number;
  readonly activePermissions: number;
  readonly topAdmins: readonly {
    readonly adminId: string;
    readonly email: string;
    readonly sessionCount: number;
  }[];
  readonly recentSessions: readonly TSession[];
}
