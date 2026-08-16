import type {
  AdminLegalHoldReleaseOperationV1,
  AdminLegalHoldV1,
  AdminMessagingRetentionPolicyV1,
} from '@platform/admin-http-contracts';

import type { LegalHoldReleaseOperation } from '../entities/legal-hold-release-operation.entity';
import type { LegalHold } from '../entities/legal-hold.entity';
import type { RetentionPolicy } from '../entities/retention-policy.entity';

export function toAdminLegalHoldV1(hold: LegalHold): AdminLegalHoldV1 {
  return {
    id: hold.id,
    tenantId: hold.tenantId,
    channelId: hold.channelId,
    legalMatterId: hold.legalMatterId,
    legalMatterDescription: hold.legalMatterDescription,
    reason: hold.reason,
    requestedBy: hold.requestedBy,
    startedBy: hold.startedBy,
    startedAt: hold.startedAt.toISOString(),
    releasedBy: hold.releasedBy,
    releasedByApprover: hold.releasedByApprover,
    releaseReason: hold.releaseReason,
    releasedAt: hold.releasedAt?.toISOString() ?? null,
    expiresAt: hold.expiresAt?.toISOString() ?? null,
    isActive: hold.isActive,
  };
}

export function toAdminMessagingRetentionPolicyV1(
  policy: RetentionPolicy,
): AdminMessagingRetentionPolicyV1 {
  return {
    id: policy.id,
    tenantId: policy.tenantId,
    channelId: policy.channelId,
    retentionDays: policy.retentionDays,
    createdBy: policy.createdBy,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

/** JSON-safe projection shared by NATS and HTTP consumers. */
export function toAdminLegalHoldReleaseOperationV1(
  operation: LegalHoldReleaseOperation,
): AdminLegalHoldReleaseOperationV1 {
  return {
    id: operation.id,
    tenantId: operation.tenantId,
    holdId: operation.holdId,
    status: operation.status,
    releaseReason: operation.releaseReason,
    initiationRequestId: operation.initiationRequestId,
    initiatedBy: operation.initiatedBy,
    initiatedAt: operation.initiatedAt.toISOString(),
    initiatorMfaVerifiedAt: operation.initiatorMfaVerifiedAt.toISOString(),
    expiresAt: operation.expiresAt.toISOString(),
    authorizationRequestId: operation.authorizationRequestId,
    authorizedBy: operation.authorizedBy,
    authorizedAt: operation.authorizedAt?.toISOString() ?? null,
    approverMfaVerifiedAt: operation.approverMfaVerifiedAt?.toISOString() ?? null,
    releasedAt: operation.releasedAt?.toISOString() ?? null,
    expiredAt: operation.expiredAt?.toISOString() ?? null,
    expiredBy: operation.expiredBy,
  };
}
