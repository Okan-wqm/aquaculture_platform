/**
 * Services barrel export.
 *
 * CRIT-04: The canonical API layer lives in lib/api.ts and lib/types.ts.
 * This file re-exports from both the new lib layer and the legacy service
 * files so that existing consumers continue to work without changes.
 */

// API client infrastructure (still canonical here)
export { apiClient, TenantApiClient } from './api-client';
export type { GraphQLError, GraphQLResponse } from './api-client';

// Re-export the canonical API functions from lib/api
export {
  getMyTenant,
  getTenantStats,
  updateTenantSettings,
  getTenantUsers,
  createTenantUser,
  updateTenantUser,
  deleteTenantUser,
  deactivateTenantUser,
  getMyModules,
  getMyModuleIds,
  getMyTenantModules,
  getModuleUsageStats,
  assignModuleManager,
  removeModuleManager,
  getTenantDatabase,
  getTableSchema,
  getTableData,
  getTenantRoles,
  getTenantRole,
  getDefaultTenantRole,
  getPermissionCategories,
  createTenantRole,
  updateTenantRole,
  deleteTenantRole,
  seedTenantRoles,
  getTenantBilling,
  getMySubscription,
  getTenantActivity,
  getTenantAuditLogs,
  getNotificationPreferences,
  updateNotificationPreferences,
  getMobileUsersSettings,
  updateMobileUserSettings,
  getEdgeDevices,
  getEdgeDevice,
  getDeviceEvents,
  approveDevice,
  pingDevice,
  rebootDevice,
  setDeviceMaintenanceMode,
  decommissionDevice,
  createProvisioningKey,
  listProvisioningKeys,
  revokeProvisioningKey,
} from '../lib/api';

// Re-export canonical types from lib/types
export type {
  Tenant,
  TenantStats,
  TenantModule,
  MyModule,
  ModuleUsageStat,
  User,
  TenantDatabaseInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  TableSchemaInfo,
  GetTableDataInput,
  TableDataResult,
  TenantRole,
  CreateTenantRoleInput,
  UpdateTenantRoleInput,
  TenantPlan,
  TenantStatus,
  UserStatus,
  SubscriptionInfo,
  EdgeDeviceListItem,
  DeviceStats,
  DeviceEvent,
  NotificationPreferences,
  MobileUserSettingsData,
  TenantKeyResponse,
  TenantProvisioningKey,
  PermissionCategory,
  PanelPermissions,
  TenantRolePermissions,
  PermissionAction,
  PermissionResource,
} from '../lib/types';

// REST API services (messaging, announcements, tickets) remain in tenantApi.ts
export * from './tenantApi';
