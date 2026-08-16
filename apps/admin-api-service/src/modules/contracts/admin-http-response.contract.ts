import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const modulesSystemModuleContract = adminResponse.object({
  id: adminResponse.string(),
  code: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.nullable(adminResponse.string()),
  defaultRoute: adminResponse.string(),
  icon: adminResponse.nullable(adminResponse.string()),
  isCore: adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  price: adminResponse.number(),
  tenantsCount: adminResponse.number(),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type ModulesSystemModuleDto = AdminResponseProjection<typeof modulesSystemModuleContract>;

export const modulesModuleStatsContract = adminResponse.object({
  totalModules: adminResponse.number(),
  activeModules: adminResponse.number(),
  coreModules: adminResponse.number(),
  totalAssignments: adminResponse.number(),
  moduleUsage: adminResponse.array(
    adminResponse.object({
      moduleId: adminResponse.string(),
      moduleName: adminResponse.string(),
      tenantsCount: adminResponse.number(),
    }),
  ),
});

export type ModulesModuleStatsDto = AdminResponseProjection<typeof modulesModuleStatsContract>;

export const modulesGetAllAssignmentsResponseContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  tenantName: adminResponse.string(),
  moduleId: adminResponse.string(),
  moduleCode: adminResponse.string(),
  moduleName: adminResponse.string(),
  assignedAt: adminResponse.dateString(),
  expiresAt: adminResponse.nullable(adminResponse.dateString()),
});

export type ModulesGetAllAssignmentsResponseDto = AdminResponseProjection<
  typeof modulesGetAllAssignmentsResponseContract
>;

export const modulesGetModuleTenantsResponseContract = adminResponse.object({
  id: adminResponse.string(),
  name: adminResponse.string(),
  slug: adminResponse.string(),
  status: adminResponse.string(),
  assignedAt: adminResponse.dateString(),
  expiresAt: adminResponse.nullable(adminResponse.dateString()),
});

export type ModulesGetModuleTenantsResponseDto = AdminResponseProjection<
  typeof modulesGetModuleTenantsResponseContract
>;

export const voidResponseContract = adminResponse.void();

export type VoidResponseDto = AdminResponseProjection<typeof voidResponseContract>;

export const modulesTenantModuleAssignmentContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  tenantName: adminResponse.string(),
  moduleId: adminResponse.string(),
  moduleCode: adminResponse.string(),
  moduleName: adminResponse.string(),
  assignedAt: adminResponse.dateString(),
  expiresAt: adminResponse.nullable(adminResponse.dateString()),
});

export type ModulesTenantModuleAssignmentDto = AdminResponseProjection<
  typeof modulesTenantModuleAssignmentContract
>;

export const modulesSystemModulePageContract = adminResponse.page(modulesSystemModuleContract);

export const modulesGetAllAssignmentsResponsePageContract = adminResponse.page(
  modulesGetAllAssignmentsResponseContract,
);

export const modulesGetModuleTenantsResponsePageContract = adminResponse.page(
  modulesGetModuleTenantsResponseContract,
);
