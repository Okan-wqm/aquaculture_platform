/**
 * Versioned admin messaging boundary contracts.
 *
 * This module is the sole authority for the browser -> admin-api HTTP command
 * shapes and the admin-api -> messaging-service NATS request coordinates.
 * Actor identity and MFA evidence deliberately exist only on the internal RPC
 * commands: browsers can never nominate either approver or manufacture
 * authentication evidence.
 */

import type { CursorPaginationResultV1 } from '@platform/pagination-contracts';

export const ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1 = 50 as const;
export const ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1 = 1_000 as const;
export const ADMIN_LEGAL_HOLD_RELEASE_APPROVAL_WINDOW_SECONDS_V1 = 15 * 60;
export const ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1 = 5 * 60;

export const ADMIN_MESSAGING_RPC_SUBJECTS_V1 = {
  complianceStats: 'request.messaging.admin.complianceStats',
  getLegalHolds: 'request.messaging.admin.getLegalHolds',
  createLegalHold: 'request.messaging.admin.createLegalHold',
  createLegalHoldReleaseOperation: 'request.messaging.admin.createLegalHoldReleaseOperation',
  authorizeLegalHoldReleaseOperation: 'request.messaging.admin.authorizeLegalHoldReleaseOperation',
  getLegalHoldReleaseOperations: 'request.messaging.admin.getLegalHoldReleaseOperations',
  getRetentionPolicies: 'request.messaging.admin.getRetentionPolicies',
  updateRetentionPolicy: 'request.messaging.admin.updateRetentionPolicy',
  getAuditLog: 'request.messaging.admin.getAuditLog',
  triggerExport: 'request.messaging.admin.triggerExport',
  getPersonas: 'request.messaging.admin.getPersonas',
} as const;

export type AdminMessagingRpcSubjectV1 =
  (typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1)[keyof typeof ADMIN_MESSAGING_RPC_SUBJECTS_V1];

export interface AdminMessagingTenantScopeV1 {
  readonly tenantId: string;
}

/** Browser-owned input. The authenticated actor is injected by admin-api. */
export interface AdminCreateLegalHoldReleaseOperationV1 extends AdminMessagingTenantScopeV1 {
  readonly requestId: string;
  readonly releaseReason: string;
}

/** Browser-owned input. The authenticated countersigner is injected by admin-api. */
export interface AdminAuthorizeLegalHoldReleaseOperationV1 extends AdminMessagingTenantScopeV1 {
  readonly requestId: string;
}

/**
 * Verified JWT projection forwarded only over the service-authenticated NATS
 * boundary. Both services validate freshness; a raw JWT is never forwarded.
 */
export interface AdminRecentMfaActorV1 {
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly mfaVerified: boolean;
  readonly tokenIssuedAt: string;
  readonly tokenId: string;
}

export const ADMIN_LEGAL_HOLD_RELEASE_OPERATION_STATUSES_V1 = [
  'PENDING',
  'RELEASED',
  'EXPIRED',
] as const;

export type AdminLegalHoldReleaseOperationStatusV1 =
  (typeof ADMIN_LEGAL_HOLD_RELEASE_OPERATION_STATUSES_V1)[number];

export interface AdminLegalHoldReleaseOperationV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly holdId: string;
  readonly status: AdminLegalHoldReleaseOperationStatusV1;
  readonly releaseReason: string;
  readonly initiationRequestId: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  readonly initiatorMfaVerifiedAt: string;
  readonly expiresAt: string;
  readonly authorizationRequestId: string | null;
  readonly authorizedBy: string | null;
  readonly authorizedAt: string | null;
  readonly approverMfaVerifiedAt: string | null;
  readonly releasedAt: string | null;
  readonly expiredAt: string | null;
  readonly expiredBy: string | null;
}

export interface AdminLegalHoldV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly channelId: string | null;
  readonly legalMatterId: string;
  readonly legalMatterDescription: string | null;
  readonly reason: string;
  readonly requestedBy: string | null;
  readonly startedBy: string;
  readonly startedAt: string;
  readonly releasedBy: string | null;
  readonly releasedByApprover: string | null;
  readonly releaseReason: string | null;
  readonly releasedAt: string | null;
  readonly expiresAt: string | null;
  readonly isActive: boolean;
}

export interface AdminMessagingComplianceStatsV1 {
  readonly activeHoldsCount: number;
  readonly retentionPoliciesCount: number;
  readonly auditLogEntriesCount: number;
}

export interface AdminMessagingAuditQueryV1 extends AdminMessagingTenantScopeV1 {
  readonly limit: number;
  readonly cursor: string | null;
  readonly userId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

/** JSON-safe audit row shared by messaging-service, admin gateway, and browser. */
export interface AdminMessagingAuditEntryV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

export type AdminMessagingAuditPageV1 = CursorPaginationResultV1<AdminMessagingAuditEntryV1>;

export interface AdminMessagingRetentionPolicyV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly channelId: string | null;
  readonly retentionDays: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminMessagingExportResultV1 {
  readonly jobId: string;
  readonly status: string;
  readonly format: string;
  readonly recordCount: number;
  readonly isUnderLegalHold: boolean;
  readonly exportedAt: string;
}

export interface AdminMessagingPersonaV1 {
  readonly id: string | null;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly color: string;
  readonly capabilities: readonly string[];
}

export interface AdminCreateLegalHoldRpcV1 extends AdminMessagingTenantScopeV1 {
  readonly userId: string;
  readonly channelId: string | null;
  readonly reason: string;
  readonly legalMatterId: string;
  readonly legalMatterDescription?: string;
  readonly requestedBy?: string;
  readonly expiresAt?: string;
}

export interface AdminCreateLegalHoldReleaseOperationRpcV1
  extends AdminCreateLegalHoldReleaseOperationV1 {
  readonly holdId: string;
  readonly initiator: AdminRecentMfaActorV1;
}

export interface AdminAuthorizeLegalHoldReleaseOperationRpcV1
  extends AdminAuthorizeLegalHoldReleaseOperationV1 {
  readonly operationId: string;
  readonly approver: AdminRecentMfaActorV1;
}

export interface AdminGetLegalHoldReleaseOperationsRpcV1 extends AdminMessagingTenantScopeV1 {
  readonly status?: AdminLegalHoldReleaseOperationStatusV1;
}

export interface AdminUpdateRetentionPolicyRpcV1 extends AdminMessagingTenantScopeV1 {
  readonly userId: string;
  readonly channelId: string | null;
  readonly retentionDays: number;
}

export interface AdminTriggerMessagingExportRpcV1 extends AdminMessagingTenantScopeV1 {
  readonly userId: string;
  readonly format: 'csv' | 'json';
}

/** Subject -> payload map; every NATS producer and consumer indexes this map. */
export interface AdminMessagingRpcRequestV1 {
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.complianceStats]: AdminMessagingTenantScopeV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHolds]: AdminMessagingTenantScopeV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHold]: AdminCreateLegalHoldRpcV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHoldReleaseOperation]: AdminCreateLegalHoldReleaseOperationRpcV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.authorizeLegalHoldReleaseOperation]: AdminAuthorizeLegalHoldReleaseOperationRpcV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHoldReleaseOperations]: AdminGetLegalHoldReleaseOperationsRpcV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getRetentionPolicies]: AdminMessagingTenantScopeV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.updateRetentionPolicy]: AdminUpdateRetentionPolicyRpcV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getAuditLog]: AdminMessagingAuditQueryV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.triggerExport]: AdminTriggerMessagingExportRpcV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getPersonas]: AdminMessagingTenantScopeV1;
}

/** Subject -> JSON-safe response map. Entity instances never cross this boundary. */
export interface AdminMessagingRpcResponseV1 {
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.complianceStats]: AdminMessagingComplianceStatsV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHolds]: readonly AdminLegalHoldV1[];
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHold]: AdminLegalHoldV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.createLegalHoldReleaseOperation]: AdminLegalHoldReleaseOperationV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.authorizeLegalHoldReleaseOperation]: AdminLegalHoldReleaseOperationV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getLegalHoldReleaseOperations]: readonly AdminLegalHoldReleaseOperationV1[];
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getRetentionPolicies]: readonly AdminMessagingRetentionPolicyV1[];
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.updateRetentionPolicy]: AdminMessagingRetentionPolicyV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getAuditLog]: AdminMessagingAuditPageV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.triggerExport]: AdminMessagingExportResultV1;
  [ADMIN_MESSAGING_RPC_SUBJECTS_V1.getPersonas]: readonly AdminMessagingPersonaV1[];
}
