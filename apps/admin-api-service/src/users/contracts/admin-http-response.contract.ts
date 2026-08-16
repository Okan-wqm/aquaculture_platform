import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';
import { PLATFORM_ROLE_CODES } from '@platform/identity';

export const usersUserDtoContract = adminResponse.object({
  id: adminResponse.string(),
  email: adminResponse.string(),
  firstName: adminResponse.string(),
  lastName: adminResponse.string(),
  role: adminResponse.literalSet(PLATFORM_ROLE_CODES),
  tenantId: adminResponse.nullable(adminResponse.string()),
  tenantName: adminResponse.nullable(adminResponse.string()),
  isActive: adminResponse.boolean(),
  lastLoginAt: adminResponse.nullable(adminResponse.dateString()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type UsersUserDtoDto = AdminResponseProjection<typeof usersUserDtoContract>;

export const usersUserStatsContract = adminResponse.object({
  totalUsers: adminResponse.number(),
  activeUsers: adminResponse.number(),
  inactiveUsers: adminResponse.number(),
  usersByRole: adminResponse.array(
    adminResponse.object({
      role: adminResponse.literalSet(PLATFORM_ROLE_CODES),
      count: adminResponse.number(),
    }),
  ),
  usersByTenant: adminResponse.array(
    adminResponse.object({
      tenantId: adminResponse.string(),
      tenantName: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  newUsersLast30Days: adminResponse.number(),
  loginsLast24Hours: adminResponse.number(),
});

export type UsersUserStatsDto = AdminResponseProjection<typeof usersUserStatsContract>;

export const usersUserActivityContract = adminResponse.object({
  id: adminResponse.string(),
  action: adminResponse.string(),
  entityType: adminResponse.string(),
  entityId: adminResponse.string(),
  metadata: adminResponse.record(adminResponse.json('extension-metadata')),
  ipAddress: adminResponse.string(),
  userAgent: adminResponse.string(),
  createdAt: adminResponse.dateString(),
});

export type UsersUserActivityDto = AdminResponseProjection<typeof usersUserActivityContract>;

export const usersUserSessionContract = adminResponse.object({
  id: adminResponse.string(),
  token: adminResponse.string(),
  ipAddress: adminResponse.string(),
  userAgent: adminResponse.string(),
  createdAt: adminResponse.dateString(),
  expiresAt: adminResponse.dateString(),
  isActive: adminResponse.boolean(),
});

export type UsersUserSessionDto = AdminResponseProjection<typeof usersUserSessionContract>;

export const usersResetUserPasswordResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type UsersResetUserPasswordResponseDto = AdminResponseProjection<
  typeof usersResetUserPasswordResponseContract
>;

export const usersForceLogoutResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  count: adminResponse.number(),
});

export type UsersForceLogoutResponseDto = AdminResponseProjection<
  typeof usersForceLogoutResponseContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const usersUserLimitCheckResultContract = adminResponse.object({
  canCreate: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  currentCount: adminResponse.number(),
  limit: adminResponse.number(),
  remaining: adminResponse.number(),
  message: adminResponse.optional(adminResponse.string()),
});

export type UsersUserLimitCheckResultDto = AdminResponseProjection<
  typeof usersUserLimitCheckResultContract
>;

export const usersInviteUserResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  userId: adminResponse.string(),
  invitationId: adminResponse.string(),
});

export type UsersInviteUserResponseDto = AdminResponseProjection<
  typeof usersInviteUserResponseContract
>;

export const usersRoleTemplateContract = adminResponse.object({
  code: adminResponse.literalSet(PLATFORM_ROLE_CODES),
  name: adminResponse.string(),
  description: adminResponse.string(),
  level: adminResponse.number(),
  permissionMode: adminResponse.union([
    adminResponse.literal('all'),
    adminResponse.literal('assigned'),
  ] as const),
  permissions: adminResponse.array(adminResponse.string()),
  isSystem: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  color: adminResponse.string(),
  icon: adminResponse.string(),
});

export type UsersRoleTemplateDto = AdminResponseProjection<typeof usersRoleTemplateContract>;

export const usersPermissionContract = adminResponse.object({
  code: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.string(),
  category: adminResponse.string(),
});

export type UsersPermissionDto = AdminResponseProjection<typeof usersPermissionContract>;

export const usersGetPermissionsByCategoryResponseContract = adminResponse.record(
  adminResponse.array(
    adminResponse.object({
      code: adminResponse.string(),
      name: adminResponse.string(),
      description: adminResponse.string(),
      category: adminResponse.string(),
    }),
  ),
);

export type UsersGetPermissionsByCategoryResponseDto = AdminResponseProjection<
  typeof usersGetPermissionsByCategoryResponseContract
>;

export const usersGetRoleHierarchyResponseContract = adminResponse.object({
  code: adminResponse.literalSet(PLATFORM_ROLE_CODES),
  name: adminResponse.string(),
  level: adminResponse.number(),
  permissionMode: adminResponse.union([
    adminResponse.literal('all'),
    adminResponse.literal('assigned'),
  ] as const),
  description: adminResponse.string(),
  color: adminResponse.string(),
  icon: adminResponse.string(),
  isSystem: adminResponse.boolean(),
  permissionCount: adminResponse.number(),
});

export type UsersGetRoleHierarchyResponseDto = AdminResponseProjection<
  typeof usersGetRoleHierarchyResponseContract
>;

export const usersCanAssignRoleResponseContract = adminResponse.object({
  allowed: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  reason: adminResponse.optional(adminResponse.string()),
});

export type UsersCanAssignRoleResponseDto = AdminResponseProjection<
  typeof usersCanAssignRoleResponseContract
>;

export const usersGetRolePermissionsResponseContract = adminResponse.string();

export type UsersGetRolePermissionsResponseDto = AdminResponseProjection<
  typeof usersGetRolePermissionsResponseContract
>;

export const usersUserDtoPageContract = adminResponse.page(usersUserDtoContract);

export const usersGetRoleHierarchyResponseArrayContract = adminResponse.array(
  usersGetRoleHierarchyResponseContract,
);

export const usersGetRolePermissionsResponseArrayContract = adminResponse.array(
  usersGetRolePermissionsResponseContract,
);

export const usersPermissionArrayContract = adminResponse.array(usersPermissionContract);

export const usersRoleTemplateArrayContract = adminResponse.array(usersRoleTemplateContract);

export const usersUserActivityArrayContract = adminResponse.array(usersUserActivityContract);

export const usersUserDtoArrayContract = adminResponse.array(usersUserDtoContract);

export const usersUserSessionArrayContract = adminResponse.array(usersUserSessionContract);
