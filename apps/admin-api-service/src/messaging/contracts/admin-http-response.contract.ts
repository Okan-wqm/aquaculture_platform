import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const messagingAdminComplianceStatsResponseContract = adminResponse.object({
  activeHoldsCount: adminResponse.number(),
  retentionPoliciesCount: adminResponse.number(),
  auditLogEntriesCount: adminResponse.number(),
});

export type MessagingAdminComplianceStatsResponseDto = AdminResponseProjection<
  typeof messagingAdminComplianceStatsResponseContract
>;

export const messagingAdminLegalHoldResponseContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  channelId: adminResponse.nullable(adminResponse.string()),
  reason: adminResponse.string(),
  isActive: adminResponse.boolean(),
  createdAt: adminResponse.string(),
});

export type MessagingAdminLegalHoldResponseDto = AdminResponseProjection<
  typeof messagingAdminLegalHoldResponseContract
>;

export const messagingAdminRetentionPolicyResponseContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  channelId: adminResponse.nullable(adminResponse.string()),
  retentionDays: adminResponse.number(),
});

export type MessagingAdminRetentionPolicyResponseDto = AdminResponseProjection<
  typeof messagingAdminRetentionPolicyResponseContract
>;

export const neverResponseContract = adminResponse.never();

export type NeverResponseDto = AdminResponseProjection<typeof neverResponseContract>;

export const messagingAdminAuditLogResponseContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      action: adminResponse.string(),
      resourceType: adminResponse.string(),
      createdAt: adminResponse.string(),
    }),
  ),
  hasMore: adminResponse.boolean(),
  cursor: adminResponse.nullable(adminResponse.string()),
  totalCount: adminResponse.number(),
});

export type MessagingAdminAuditLogResponseDto = AdminResponseProjection<
  typeof messagingAdminAuditLogResponseContract
>;

export const messagingAdminExportResponseContract = adminResponse.object({
  exportId: adminResponse.string(),
  status: adminResponse.string(),
});

export type MessagingAdminExportResponseDto = AdminResponseProjection<
  typeof messagingAdminExportResponseContract
>;

export const messagingAdminPersonaResponseContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.string(),
  isActive: adminResponse.boolean(),
});

export type MessagingAdminPersonaResponseDto = AdminResponseProjection<
  typeof messagingAdminPersonaResponseContract
>;

export const messagingAdminLegalHoldResponseArrayContract = adminResponse.array(
  messagingAdminLegalHoldResponseContract,
);

export const messagingAdminPersonaResponseArrayContract = adminResponse.array(
  messagingAdminPersonaResponseContract,
);

export const messagingAdminRetentionPolicyResponseArrayContract = adminResponse.array(
  messagingAdminRetentionPolicyResponseContract,
);
