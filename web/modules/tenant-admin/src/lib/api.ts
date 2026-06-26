/**
 * Tenant Admin API - Single Source of Truth
 *
 * CRIT-04: Every GraphQL query and mutation is wrapped in a typed function
 * here. No file outside lib/api.ts should call graphqlRequest or
 * apiClient.graphql directly.
 *
 * Functions are organized by domain (tenant, users, modules, roles, etc.)
 * and return properly typed results.
 */

import { apiClient } from '../services/api-client';

// GraphQL query/mutation strings
import {
  MY_TENANT_QUERY,
  TENANT_STATS_QUERY,
  MY_TENANT_MODULES_QUERY,
  TENANT_USERS_QUERY,
  TENANT_DATABASE_QUERY,
  TABLE_SCHEMA_QUERY,
  TABLE_DATA_QUERY,
  UPDATE_TENANT_MUTATION,
  CREATE_TENANT_USER_MUTATION,
  UPDATE_USER_MUTATION,
  DELETE_USER_MUTATION,
  DEACTIVATE_TENANT_USER_MUTATION,
  TENANT_ROLES_QUERY,
  TENANT_ROLE_QUERY,
  DEFAULT_TENANT_ROLE_QUERY,
  PERMISSION_CATEGORIES_QUERY,
  CREATE_TENANT_ROLE_MUTATION,
  UPDATE_TENANT_ROLE_MUTATION,
  DELETE_TENANT_ROLE_MUTATION,
  SEED_TENANT_ROLES_MUTATION,
  MY_MODULES_QUERY,
  MY_MODULES_ID_QUERY,
  MODULE_USAGE_STATS_QUERY,
  ASSIGN_MODULE_MANAGER_MUTATION,
  REMOVE_MODULE_MANAGER_MUTATION,
  EDGE_DEVICES_QUERY,
  EDGE_DEVICE_QUERY,
  DEVICE_EVENTS_QUERY,
  APPROVE_DEVICE_MUTATION,
  PING_DEVICE_MUTATION,
  REBOOT_DEVICE_MUTATION,
  MAINTENANCE_DEVICE_MUTATION,
  DECOMMISSION_DEVICE_MUTATION,
  CREATE_PROVISIONING_KEY_MUTATION,
  LIST_PROVISIONING_KEYS_QUERY,
  REVOKE_PROVISIONING_KEY_MUTATION,
  TENANT_BILLING_QUERY,
  MY_SUBSCRIPTION_QUERY,
  TENANT_ACTIVITY_QUERY,
  TENANT_AUDIT_LOGS_QUERY,
  GET_NOTIFICATION_PREFERENCES_QUERY,
  UPDATE_NOTIFICATION_PREFERENCES_MUTATION,
  GET_MOBILE_USERS_SETTINGS_QUERY,
  UPDATE_MOBILE_USER_SETTINGS_MUTATION,
  // Communication
  MY_THREADS_QUERY,
  THREAD_MESSAGES_QUERY,
  SEND_MESSAGE_MUTATION,
  CREATE_THREAD_MUTATION,
  CLOSE_THREAD_MUTATION,
  REOPEN_THREAD_MUTATION,
  MY_TICKETS_QUERY,
  TICKET_COMMENTS_QUERY,
  CREATE_TICKET_MUTATION,
  ADD_TICKET_COMMENT_MUTATION,
  RATE_TICKET_MUTATION,
  MY_ANNOUNCEMENTS_QUERY,
  VIEW_ANNOUNCEMENT_MUTATION,
  ACKNOWLEDGE_ANNOUNCEMENT_MUTATION,
} from '../graphql';

// Types
import type {
  Tenant,
  TenantStats,
  TenantModule,
  MyModule,
  ModuleUsageStat,
  User,
  TenantDatabaseInfo,
  TableSchemaInfo,
  GetTableDataInput,
  TableDataResult,
  TenantRole,
  CreateTenantRoleInput,
  UpdateTenantRoleInput,
  PermissionCategory,
  SubscriptionInfo,
  EdgeDeviceListItem,
  DeviceStats,
  DeviceEvent,
  NotificationPreferences,
  MobileUserSettingsData,
  TenantKeyResponse,
  TenantProvisioningKey,
  MessageThread,
  Message,
  Announcement,
  ApiSupportTicket,
  ApiTicketComment,
  ApiTicketCategory,
} from './types';

// ============================================================================
// Tenant
// ============================================================================

export async function getMyTenant(): Promise<Tenant> {
  const data = await apiClient.graphql<{ myTenant: Tenant }>(MY_TENANT_QUERY);
  return data.myTenant;
}

export async function getTenantStats(): Promise<TenantStats> {
  const data = await apiClient.graphql<{ tenantStats: TenantStats }>(
    TENANT_STATS_QUERY,
  );
  return data.tenantStats;
}

export async function updateTenant(
  id: string,
  input: Partial<
    Pick<
      Tenant,
      | 'name'
      | 'description'
      | 'logoUrl'
      | 'contactEmail'
      | 'contactPhone'
      | 'address'
      | 'settings'
    >
  >,
): Promise<Tenant> {
  const data = await apiClient.graphql<{ updateTenant: Tenant }>(
    UPDATE_TENANT_MUTATION,
    { id, input },
  );
  return data.updateTenant;
}

/** @deprecated Use updateTenant instead */
export const updateTenantSettings = updateTenant;

// ============================================================================
// Users
// ============================================================================

export async function getTenantUsers(options?: {
  status?: string;
  role?: string;
  limit?: number;
  offset?: number;
}): Promise<User[]> {
  const data = await apiClient.graphql<{ tenantUsers: User[] }>(
    TENANT_USERS_QUERY,
    options,
  );
  return data.tenantUsers;
}

export async function createTenantUser(input: {
  firstName: string;
  lastName: string;
  email: string;
  roleId?: string;
  sendInvitation?: boolean;
}): Promise<{
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  roleAssignment: { id: string; roleId: string; roleName: string };
  invitationSent: boolean;
  createdAt: string;
}> {
  const data = await apiClient.graphql<{
    createTenantUser: {
      userId: string;
      email: string;
      firstName: string;
      lastName: string;
      roleAssignment: { id: string; roleId: string; roleName: string };
      invitationSent: boolean;
      createdAt: string;
    };
  }>(CREATE_TENANT_USER_MUTATION, { input });
  return data.createTenantUser;
}

export async function updateTenantUser(
  userId: string,
  input: {
    firstName?: string;
    lastName?: string;
    roleId?: string;
  },
): Promise<User> {
  const data = await apiClient.graphql<{ updateTenantUser: User }>(
    UPDATE_USER_MUTATION,
    { userId, input },
  );
  return data.updateTenantUser;
}

export async function deleteTenantUser(userId: string): Promise<boolean> {
  const data = await apiClient.graphql<{ deleteTenantUser: boolean }>(
    DELETE_USER_MUTATION,
    { userId },
  );
  return data.deleteTenantUser;
}

export async function deactivateTenantUser(
  userId: string,
): Promise<{ id: string; isActive: boolean }> {
  const data = await apiClient.graphql<{
    deactivateTenantUser: { id: string; isActive: boolean };
  }>(DEACTIVATE_TENANT_USER_MUTATION, { userId });
  return data.deactivateTenantUser;
}

// ============================================================================
// Modules
// ============================================================================

export async function getMyModules(): Promise<MyModule[]> {
  const data = await apiClient.graphql<{ myModules: MyModule[] }>(
    MY_MODULES_QUERY,
  );
  return data.myModules;
}

export async function getMyModuleIds(): Promise<
  Array<{ id: string; code: string }>
> {
  const data = await apiClient.graphql<{
    myModules: Array<{ id: string; code: string }>;
  }>(MY_MODULES_ID_QUERY);
  return data.myModules;
}

export async function getMyTenantModules(): Promise<TenantModule[]> {
  const data = await apiClient.graphql<{ myTenantModules: TenantModule[] }>(
    MY_TENANT_MODULES_QUERY,
  );
  return data.myTenantModules;
}

export async function getModuleUsageStats(): Promise<ModuleUsageStat[]> {
  const data = await apiClient.graphql<{
    moduleUsageStats: ModuleUsageStat[];
  }>(MODULE_USAGE_STATS_QUERY);
  return data.moduleUsageStats;
}

export async function assignModuleManager(
  moduleId: string,
  userId: string,
): Promise<TenantModule> {
  const data = await apiClient.graphql<{ assignModuleManager: TenantModule }>(
    ASSIGN_MODULE_MANAGER_MUTATION,
    { input: { moduleId, userId } },
  );
  return data.assignModuleManager;
}

export async function removeModuleManager(
  moduleId: string,
): Promise<TenantModule> {
  const data = await apiClient.graphql<{ removeModuleManager: TenantModule }>(
    REMOVE_MODULE_MANAGER_MUTATION,
    { moduleId },
  );
  return data.removeModuleManager;
}

// ============================================================================
// Database
// ============================================================================

export async function getTenantDatabase(): Promise<TenantDatabaseInfo> {
  const data = await apiClient.graphql<{
    tenantDatabase: TenantDatabaseInfo;
  }>(TENANT_DATABASE_QUERY);
  return data.tenantDatabase;
}

export async function getTableSchema(
  schemaName: string,
  tableName: string,
): Promise<TableSchemaInfo> {
  const data = await apiClient.graphql<{ tableSchema: TableSchemaInfo }>(
    TABLE_SCHEMA_QUERY,
    { schemaName, tableName },
  );
  return data.tableSchema;
}

export async function getTableData(
  input: GetTableDataInput,
): Promise<TableDataResult> {
  const data = await apiClient.graphql<{ tableData: TableDataResult }>(
    TABLE_DATA_QUERY,
    { input },
  );
  return data.tableData;
}

// ============================================================================
// Roles & Permissions
// ============================================================================

export async function getTenantRoles(): Promise<TenantRole[]> {
  const data = await apiClient.graphql<{ tenantRoles: TenantRole[] }>(
    TENANT_ROLES_QUERY,
  );
  return data.tenantRoles;
}

export async function getTenantRole(roleId: string): Promise<TenantRole> {
  const data = await apiClient.graphql<{ tenantRole: TenantRole }>(
    TENANT_ROLE_QUERY,
    { roleId },
  );
  return data.tenantRole;
}

export async function getDefaultTenantRole(): Promise<TenantRole | null> {
  const data = await apiClient.graphql<{
    defaultTenantRole: TenantRole | null;
  }>(DEFAULT_TENANT_ROLE_QUERY);
  return data.defaultTenantRole;
}

export async function getPermissionCategories(): Promise<
  PermissionCategory[]
> {
  const data = await apiClient.graphql<{
    permissionCategories: PermissionCategory[];
  }>(PERMISSION_CATEGORIES_QUERY);
  return data.permissionCategories;
}

export async function createTenantRole(
  input: CreateTenantRoleInput,
): Promise<TenantRole> {
  const data = await apiClient.graphql<{ createTenantRole: TenantRole }>(
    CREATE_TENANT_ROLE_MUTATION,
    { input },
  );
  return data.createTenantRole;
}

export async function updateTenantRole(
  roleId: string,
  input: UpdateTenantRoleInput,
): Promise<TenantRole> {
  const data = await apiClient.graphql<{ updateTenantRole: TenantRole }>(
    UPDATE_TENANT_ROLE_MUTATION,
    { roleId, input },
  );
  return data.updateTenantRole;
}

export async function deleteTenantRole(roleId: string): Promise<boolean> {
  const data = await apiClient.graphql<{ deleteTenantRole: boolean }>(
    DELETE_TENANT_ROLE_MUTATION,
    { roleId },
  );
  return data.deleteTenantRole;
}

export async function seedTenantRoles(): Promise<TenantRole[]> {
  const data = await apiClient.graphql<{ seedTenantRoles: TenantRole[] }>(
    SEED_TENANT_ROLES_MUTATION,
  );
  return data.seedTenantRoles;
}

// ============================================================================
// Billing & Subscription
// ============================================================================

/**
 * Billing data structure (matches TENANT_BILLING_QUERY shape).
 * Kept inline since it is only used here and in the billing hook.
 */
export interface TenantBillingData {
  subscription: {
    id: string;
    plan: string;
    status: string;
    billingPeriod: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    trialEndDate: string | null;
    monthlyPrice: number;
    currency: string;
  } | null;
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    amount: number;
    currency: string;
    status: string;
    issuedAt: string;
    dueDate: string;
    paidAt: string | null;
    description: string;
  }>;
  planLimits: {
    maxFarms: number;
    maxSensors: number;
    maxUsers: number;
    maxStorage: number;
    currentFarms: number;
    currentSensors: number;
    currentUsers: number;
    currentStorage: number;
  } | null;
  usageMetrics: {
    apiCallsThisMonth: number;
    apiCallsLimit: number;
    storageUsedGb: number;
    storageLimit: number;
    sensorReadingsThisMonth: number;
    sensorReadingsLimit: number;
  } | null;
}

export async function getTenantBilling(): Promise<TenantBillingData> {
  const data = await apiClient.graphql<{ tenantBilling: TenantBillingData }>(
    TENANT_BILLING_QUERY,
  );
  return data.tenantBilling;
}

export async function getMySubscription(): Promise<SubscriptionInfo | null> {
  const data = await apiClient.graphql<{
    subscription: SubscriptionInfo | null;
  }>(MY_SUBSCRIPTION_QUERY);
  return data.subscription;
}

// ============================================================================
// Activity & Audit
// ============================================================================

export interface TenantActivityData {
  recentLogins: Array<{
    id: string;
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    loginAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    deviceType: string | null;
    success: boolean;
  }>;
  activeSessions: number;
  userActivitySummaries: Array<{
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    totalActions: number;
    lastActiveAt: string | null;
    loginCount: number;
  }>;
  dailyActiveUsers: Array<{
    date: string;
    count: number;
  }>;
}

export async function getTenantActivity(
  period?: string,
): Promise<TenantActivityData> {
  const data = await apiClient.graphql<{
    tenantActivity: TenantActivityData;
  }>(TENANT_ACTIVITY_QUERY, period ? { period } : undefined);
  return data.tenantActivity;
}

export interface AuditLogPage {
  data: Array<{
    id: string;
    performedBy: string;
    performedByEmail: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    details: Record<string, unknown> | null;
    severity: 'info' | 'warning' | 'error' | 'critical';
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
  }>;
  total: number;
}

export async function getTenantAuditLogs(variables?: {
  startDate?: string;
  endDate?: string;
  action?: string;
  severity?: string;
  performedBy?: string;
  limit?: number;
  offset?: number;
}): Promise<AuditLogPage> {
  const data = await apiClient.graphql<{ tenantAuditLogs: AuditLogPage }>(
    TENANT_AUDIT_LOGS_QUERY,
    variables,
  );
  return data.tenantAuditLogs;
}

// ============================================================================
// Notifications & Mobile Settings
// ============================================================================

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const data = await apiClient.graphql<{
    getMyNotificationPreferences: NotificationPreferences;
  }>(GET_NOTIFICATION_PREFERENCES_QUERY);
  return data.getMyNotificationPreferences;
}

export async function updateNotificationPreferences(
  input: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const data = await apiClient.graphql<{
    updateMyNotificationPreferences: NotificationPreferences;
  }>(UPDATE_NOTIFICATION_PREFERENCES_MUTATION, { input });
  return data.updateMyNotificationPreferences;
}

export async function getMobileUsersSettings(): Promise<
  MobileUserSettingsData[]
> {
  const data = await apiClient.graphql<{
    getMobileUsersSettings: MobileUserSettingsData[];
  }>(GET_MOBILE_USERS_SETTINGS_QUERY);
  return data.getMobileUsersSettings;
}

export async function updateMobileUserSettings(input: {
  userId: string;
  isMobileEnabled: boolean;
  mortality: boolean;
  cull: boolean;
  harvest: boolean;
  feeding: boolean;
  waterQuality: boolean;
  tankView: boolean;
}): Promise<MobileUserSettingsData> {
  const data = await apiClient.graphql<{
    updateMobileUserSettings: MobileUserSettingsData;
  }>(UPDATE_MOBILE_USER_SETTINGS_MUTATION, { input });
  return data.updateMobileUserSettings;
}

// ============================================================================
// Edge Devices
// ============================================================================

export async function getEdgeDevices(variables?: {
  lifecycleState?: string;
  isOnline?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{
  edgeDevices: { items: EdgeDeviceListItem[]; total: number };
  edgeDeviceStats: DeviceStats;
}> {
  return apiClient.graphql<{
    edgeDevices: { items: EdgeDeviceListItem[]; total: number };
    edgeDeviceStats: DeviceStats;
  }>(EDGE_DEVICES_QUERY, variables);
}

export interface EdgeDeviceDetail {
  id: string;
  tenantId: string;
  siteId?: string;
  deviceCode: string;
  deviceName: string;
  deviceModel: string;
  serialNumber?: string;
  description?: string;
  lifecycleState: string;
  mqttClientId?: string;
  agentVersion?: string;
  lastSeenAt?: string;
  isOnline: boolean;
  ipAddress?: string;
  firmwareVersion?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  storageUsage?: number;
  temperatureCelsius?: number;
  uptimeSeconds?: number;
  connectionQuality?: number;
  config?: Record<string, unknown>;
  capabilities?: Record<string, boolean>;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  sensorCount?: number;
  programCount?: number;
  activeAlarmCount?: number;
  ioConfig?: Array<{
    id: string;
    tagName: string;
    ioType: string;
    dataType: string;
    unit?: string;
    isActive: boolean;
  }>;
}

export async function getEdgeDevice(
  id: string,
): Promise<EdgeDeviceDetail | null> {
  const data = await apiClient.graphql<{
    edgeDevice: EdgeDeviceDetail | null;
  }>(EDGE_DEVICE_QUERY, { id });
  return data.edgeDevice ?? null;
}

export async function getDeviceEvents(
  deviceId: string,
  page = 1,
  limit = 50,
): Promise<{ items: DeviceEvent[]; total: number }> {
  const data = await apiClient.graphql<{
    deviceEvents: { items: DeviceEvent[]; total: number; page: number; limit: number };
  }>(DEVICE_EVENTS_QUERY, { deviceId, page, limit });
  return data.deviceEvents;
}

export async function approveDevice(
  id: string,
): Promise<{ id: string; lifecycleState: string }> {
  const data = await apiClient.graphql<{
    approveEdgeDevice: { id: string; lifecycleState: string };
  }>(APPROVE_DEVICE_MUTATION, { id });
  return data.approveEdgeDevice;
}

export async function pingDevice(
  id: string,
): Promise<{ success: boolean; latencyMs: number }> {
  const data = await apiClient.graphql<{
    pingEdgeDevice: { success: boolean; latencyMs: number };
  }>(PING_DEVICE_MUTATION, { id });
  return data.pingEdgeDevice;
}

export async function rebootDevice(
  id: string,
  reason?: string,
): Promise<boolean> {
  const data = await apiClient.graphql<{ rebootEdgeDevice: boolean }>(
    REBOOT_DEVICE_MUTATION,
    { id, reason },
  );
  return data.rebootEdgeDevice;
}

export async function setDeviceMaintenanceMode(
  id: string,
  enabled: boolean,
): Promise<{ id: string; lifecycleState: string }> {
  const data = await apiClient.graphql<{
    setDeviceMaintenanceMode: { id: string; lifecycleState: string };
  }>(MAINTENANCE_DEVICE_MUTATION, { id, enabled });
  return data.setDeviceMaintenanceMode;
}

export async function decommissionDevice(
  id: string,
  reason: string,
): Promise<{ id: string; lifecycleState: string }> {
  const data = await apiClient.graphql<{
    decommissionEdgeDevice: { id: string; lifecycleState: string };
  }>(DECOMMISSION_DEVICE_MUTATION, { id, reason });
  return data.decommissionEdgeDevice;
}

// ============================================================================
// Provisioning Keys
// ============================================================================

export async function createProvisioningKey(input: {
  name?: string;
  maxDevices?: number;
  autoApprove?: boolean;
  expiresInDays?: number;
}): Promise<TenantKeyResponse> {
  const data = await apiClient.graphql<{
    createTenantProvisioningKey: TenantKeyResponse;
  }>(CREATE_PROVISIONING_KEY_MUTATION, { input });
  return data.createTenantProvisioningKey;
}

export async function listProvisioningKeys(): Promise<
  TenantProvisioningKey[]
> {
  const data = await apiClient.graphql<{
    tenantProvisioningKeys: TenantProvisioningKey[];
  }>(LIST_PROVISIONING_KEYS_QUERY);
  return data.tenantProvisioningKeys;
}

export async function revokeProvisioningKey(keyId: string): Promise<boolean> {
  const data = await apiClient.graphql<{
    revokeTenantProvisioningKey: boolean;
  }>(REVOKE_PROVISIONING_KEY_MUTATION, { keyId });
  return data.revokeTenantProvisioningKey;
}

// ============================================================================
// Messaging
// ============================================================================

export async function getMyThreads(variables?: {
  status?: string;
  search?: string;
}): Promise<MessageThread[]> {
  const data = await apiClient.graphql<{ mySupportThreads: MessageThread[] }>(
    MY_THREADS_QUERY,
    variables,
  );
  return (data.mySupportThreads || []).map((t) => ({
    ...t,
    isClosed: t.status === 'closed',
  }));
}

export async function getThreadMessages(
  threadId: string,
): Promise<Message[]> {
  const data = await apiClient.graphql<{ supportThreadMessages: Message[] }>(
    THREAD_MESSAGES_QUERY,
    { threadId },
  );
  return data.supportThreadMessages || [];
}

// SupportSendMessageInput fields (auth-service messaging.dto.ts): threadId, content,
// isInternal. senderName/senderId are derived server-side from the authenticated
// user, so they are NOT part of the input. Tenant-admin replies are always public
// (isInternal=false; internal notes are an admin-only capability).
export async function sendMessage(input: {
  threadId: string;
  content: string;
}): Promise<Message> {
  const data = await apiClient.graphql<{ sendSupportMessage: Message }>(
    SEND_MESSAGE_MUTATION,
    { input: { threadId: input.threadId, content: input.content, isInternal: false } },
  );
  return data.sendSupportMessage;
}

// SupportCreateThreadInput fields (auth-service messaging.dto.ts): subject,
// initialMessage, tenantId? (auto-filled for TenantAdmin from the JWT, so omitted
// here). The page passes the first message body as `content`; it maps to the real
// `initialMessage` field.
export async function createThread(input: {
  subject: string;
  content: string;
}): Promise<MessageThread> {
  const data = await apiClient.graphql<{ createSupportThread: MessageThread }>(
    CREATE_THREAD_MUTATION,
    { input: { subject: input.subject, initialMessage: input.content } },
  );
  return data.createSupportThread;
}

export async function closeThread(
  threadId: string,
): Promise<{ id: string; status: string }> {
  const data = await apiClient.graphql<{
    closeSupportThread: { id: string; status: string; updatedAt: string };
  }>(CLOSE_THREAD_MUTATION, { threadId });
  return data.closeSupportThread;
}

export async function reopenThread(
  threadId: string,
): Promise<{ id: string; status: string }> {
  const data = await apiClient.graphql<{
    reopenSupportThread: { id: string; status: string; updatedAt: string };
  }>(REOPEN_THREAD_MUTATION, { threadId });
  return data.reopenSupportThread;
}

// ============================================================================
// Support Tickets
// ============================================================================

export async function getMyTickets(variables?: {
  status?: string;
  priority?: string;
  search?: string;
}): Promise<ApiSupportTicket[]> {
  const data = await apiClient.graphql<{ myTickets: ApiSupportTicket[] }>(
    MY_TICKETS_QUERY,
    variables,
  );
  return data.myTickets || [];
}

export async function getTicketComments(
  ticketId: string,
): Promise<ApiTicketComment[]> {
  const data = await apiClient.graphql<{
    ticketComments: ApiTicketComment[];
  }>(TICKET_COMMENTS_QUERY, { ticketId });
  return data.ticketComments || [];
}

export async function createTicket(input: {
  subject: string;
  description: string;
  category?: ApiTicketCategory;
  priority?: string;
  createdByName?: string;
  createdByEmail?: string;
}): Promise<ApiSupportTicket> {
  const data = await apiClient.graphql<{
    createTicket: ApiSupportTicket;
  }>(CREATE_TICKET_MUTATION, { input });
  return data.createTicket;
}

export async function addTicketComment(input: {
  ticketId: string;
  content: string;
  authorName?: string;
}): Promise<ApiTicketComment> {
  const data = await apiClient.graphql<{
    addTicketComment: ApiTicketComment;
  }>(ADD_TICKET_COMMENT_MUTATION, { input });
  return data.addTicketComment;
}

export async function rateTicket(input: {
  ticketId: string;
  rating: number;
  comment?: string;
}): Promise<{ id: string; satisfactionRating: number }> {
  const data = await apiClient.graphql<{
    rateTicket: { id: string; satisfactionRating: number; satisfactionComment: string; updatedAt: string };
  }>(RATE_TICKET_MUTATION, { input });
  return data.rateTicket;
}

// ============================================================================
// Announcements
// ============================================================================

export async function getMyAnnouncements(variables?: {
  status?: string;
  type?: string;
}): Promise<Announcement[]> {
  const data = await apiClient.graphql<{
    myAnnouncements: Announcement[];
  }>(MY_ANNOUNCEMENTS_QUERY, variables);
  return data.myAnnouncements || [];
}

export async function viewAnnouncement(
  id: string,
): Promise<{ id: string; announcementId: string; viewedAt: string }> {
  const data = await apiClient.graphql<{
    viewAnnouncement: { id: string; announcementId: string; userId: string; viewedAt: string; acknowledgedAt: string };
  }>(VIEW_ANNOUNCEMENT_MUTATION, { id });
  return data.viewAnnouncement;
}

export async function acknowledgeAnnouncement(
  id: string,
): Promise<{ id: string; announcementId: string; acknowledgedAt: string }> {
  const data = await apiClient.graphql<{
    acknowledgeAnnouncement: { id: string; announcementId: string; userId: string; viewedAt: string; acknowledgedAt: string };
  }>(ACKNOWLEDGE_ANNOUNCEMENT_MUTATION, { id });
  return data.acknowledgeAnnouncement;
}
