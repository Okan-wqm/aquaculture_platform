/**
 * Tenant Admin API Service - Backward Compatibility Layer
 *
 * CRIT-04: The canonical implementation lives in lib/api.ts.
 * This file re-exports the typed functions for backward compatibility so
 * existing imports like:
 *   import { getMyTenant, type User } from '../services/tenant-api.service';
 * continue to work without modification. The untyped graphqlRequest escape
 * hatch is gone — every call goes through a typed lib/api function.
 */

// ============================================================================
// Re-export ALL types from lib/types
// ============================================================================

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
  UserRole,
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
  // Communication types
  MessageThread,
  Message,
  Announcement,
  ApiSupportTicket,
  ApiTicketComment,
  ApiTicketCategory,
} from '../lib/types';

// ============================================================================
// Re-export ALL API functions from lib/api
// ============================================================================

export {
  getMyTenant,
  getTenantStats,
  updateTenant,
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
  // Communication
  getMyThreads,
  getThreadMessages,
  sendMessage,
  createThread,
  closeThread,
  reopenThread,
  getMyTickets,
  getTicketComments,
  createTicket,
  addTicketComment,
  rateTicket,
  getMyAnnouncements,
  viewAnnouncement,
  acknowledgeAnnouncement,
} from '../lib/api';

export type {
  TenantBillingData,
  TenantActivityData,
  AuditLogPage,
  EdgeDeviceDetail,
} from '../lib/api';
