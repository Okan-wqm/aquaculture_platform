/**
 * Tenant Admin Types - Single Source of Truth
 *
 * CRIT-04: All type definitions used across the tenant-admin module are
 * consolidated here. No other file should define User, Tenant, Module,
 * or related domain types.
 */

import type { TenantRolePermissions } from '../types/permissions';

// ============================================================================
// Enums & Literal Types
// ============================================================================

/** Tenant plan tier. Backend returns UPPER_CASE; some contexts use lowercase. */
export type TenantPlan = 'TRIAL' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';

export type TenantStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';

export type UserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER';

export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'PENDING';

// ============================================================================
// Core Domain Types
// ============================================================================

/**
 * Unified User interface.
 *
 * Consolidates the 4 independent User/ApiUser/TenantUser definitions that
 * previously existed across tenant-api.service.ts, TenantDashboard.tsx,
 * TenantSettings.tsx, and TenantUsers.tsx.
 */
export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: UserRole | string;
  status?: UserStatus;
  isActive?: boolean;
  isEmailVerified?: boolean;
  // Profile fields
  profileImageUrl?: string | null;
  phoneNumber?: string | null;
  preferredLanguage?: string | null;
  // Security fields
  mfaEnabled?: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Tenant entity from backend.
 */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  logoUrl?: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  status: TenantStatus;
  plan: TenantPlan;
  maxUsers: number;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Tenant statistics summary.
 */
export interface TenantStats {
  totalUsers: number;
  activeUsers: number;
  pendingUsers: number;
  inactiveUsers: number;
  totalModules: number;
  activeModules: number;
  activeSessions: number;
  monthlyGrowthPercent?: number;
  lastActivityAt: string;
}

// ============================================================================
// Module Types
// ============================================================================

/**
 * A module assigned to a tenant (many-to-many pivot).
 *
 * Scalar pivot columns only — the backend TenantModule type carries no nested
 * `module` object (catalog details come from the separate `myModules` query).
 */
export interface TenantModule {
  id: string;
  moduleId: string;
  isEnabled: boolean;
  configuration?: Record<string, unknown>;
  activatedAt: string;
  expiresAt?: string;
  managerId?: string;
}

/**
 * Module returned by the myModules query (flattened view).
 */
export interface MyModule {
  id: string;
  moduleId: string;
  code: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  isEnabled: boolean;
  defaultRoute?: string;
}

/**
 * Module usage statistics.
 */
export interface ModuleUsageStat {
  moduleCode: string;
  userCount: number;
  lastAccessAt: string | null;
  actionsThisMonth: number;
  actionsLastMonth: number;
}

// ============================================================================
// Database Types
// ============================================================================

export interface TableInfo {
  name: string;
  rowCount: number;
  size: string;
  indexCount: number;
  lastModified: string;
}

export interface ColumnInfo {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyTable?: string;
  foreignKeyColumn?: string;
}

export interface IndexInfo {
  indexName: string;
  columnName: string;
  isUnique: boolean;
  isPrimary: boolean;
}

export interface TableSchemaInfo {
  tableName: string;
  schemaName: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

export interface TenantDatabaseInfo {
  databaseName: string;
  schemaName: string;
  totalSize: string;
  tableCount: number;
  status: string;
  lastBackup: string;
  activeConnections: number;
  maxConnections: number;
  databaseType: string;
  region: string;
  isolationLevel: string;
  encryption: string;
  tables: TableInfo[];
}

export interface GetTableDataInput {
  schemaName: string;
  tableName: string;
  limit?: number;
  offset?: number;
}

export interface TableDataResult {
  tableName: string;
  totalRows: number;
  columns: string[];
  rows: string;
  offset: number;
  limit: number;
}

// ============================================================================
// Role Types
// ============================================================================

export interface TenantRole {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon: string;
  level: number;
  isSystem: boolean;
  isDefault: boolean;
  userCount: number;
  permissions?: TenantRolePermissions | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantRoleInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
}

export interface UpdateTenantRoleInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions?: Record<string, Record<string, Record<string, boolean>>>;
}

// ============================================================================
// Billing / Subscription Types
// ============================================================================

export interface SubscriptionInfo {
  id: string;
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'suspended' | 'expired';
  planTier: string;
  planName: string;
  billingCycle: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndDate?: string;
  pricing: {
    basePrice: number;
    currency: string;
  };
  moduleItems?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    monthlyPrice: number;
  }>;
}

// ============================================================================
// Device Types
// ============================================================================

export interface EdgeDeviceListItem {
  id: string;
  deviceCode: string;
  deviceName: string;
  deviceModel: string;
  lifecycleState: string;
  isOnline: boolean;
  lastSeenAt?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  agentVersion?: string;
  ipAddress?: string;
  sensorCount?: number;
  programCount?: number;
}

export interface DeviceStats {
  total: number;
  online: number;
  offline: number;
  byState: Array<{ state: string; count: number }>;
}

export interface DeviceEvent {
  id: string;
  eventType: string;
  severity: string;
  message: string;
  createdAt: string;
}

// ============================================================================
// Notification / Mobile Settings Types
// ============================================================================

export interface NotificationPreferences {
  emailEnabled: boolean;
  smsEnabled: boolean;
  pushEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursTimezone: string;
  alertNotifications: boolean;
  taskNotifications: boolean;
  systemNotifications: boolean;
}

export interface MobileUserSettingsData {
  id: string;
  userId: string;
  tenantId: string;
  isMobileEnabled: boolean;
  allowedFeatures: {
    mortality: boolean;
    cull: boolean;
    harvest: boolean;
    feeding: boolean;
    waterQuality: boolean;
    tankView: boolean;
  };
}

// ============================================================================
// Provisioning Key Types
// ============================================================================

export interface TenantKeyResponse {
  id: string;
  keyToken: string;
  installerUrl: string;
  installerCommand: string;
  expiresAt?: string;
  maxDevices?: number;
  autoApprove: boolean;
}

export interface TenantProvisioningKey {
  id: string;
  keyToken: string;
  name?: string;
  isActive: boolean;
  maxDevices?: number;
  usedCount: number;
  autoApprove: boolean;
  expiresAt?: string;
  createdAt: string;
}

// ============================================================================
// Communication Types — Messaging, Support, Announcements
// ============================================================================

/**
 * Thread status enum matching backend ThreadStatus.
 */
/**
 * Support thread status — mirrors auth-service `SupportThreadStatus` enum
 * (apps/auth-service/src/modules/messaging/entities/message-thread.entity.ts).
 */
export type ThreadStatus = 'open' | 'closed' | 'archived';

/**
 * Who sent a support message — mirrors auth-service `SupportSenderType` enum
 * (apps/auth-service/src/modules/messaging/entities/message.entity.ts).
 */
export type SupportSenderType = 'super_admin' | 'tenant_admin' | 'system';

/**
 * Support message delivery status — mirrors auth-service `SupportMessageStatus`
 * enum (apps/auth-service/src/modules/messaging/entities/message.entity.ts).
 */
export type SupportMessageStatus = 'sent' | 'delivered' | 'read';

/**
 * A messaging thread between TenantAdmin and SuperAdmin.
 * Fields match the mySupportThreads / supportThread GraphQL queries
 * (SupportThreadListItem / SupportMessageThread types).
 */
export interface MessageThread {
  id: string;
  tenantId: string;
  tenantName?: string;
  subject: string;
  lastMessage?: string;
  lastMessageAt?: string;
  lastMessageBy?: string;
  unreadCount: number;
  messageCount: number;
  status: ThreadStatus;
  // Client-derived convenience flag (status === 'closed'); not a server field.
  isClosed?: boolean;
  createdBy?: string;
  createdByAdmin?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single message within a thread.
 * Fields match the supportThreadMessages GraphQL query (SupportMessageItem type).
 */
export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  senderType: SupportSenderType;
  senderName: string;
  content: string;
  status: SupportMessageStatus;
  isInternal: boolean;
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    size: number;
    mimeType?: string;
  }>;
  readAt?: string;
  createdAt: string;
}

/**
 * An announcement from the platform.
 * Fields match the myAnnouncements GraphQL query.
 */
export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: string;
  status: string;
  scope?: string;
  isGlobal?: boolean;
  publishAt?: string;
  publishedAt?: string;
  expiresAt?: string;
  requiresAcknowledgment: boolean;
  viewCount?: number;
  acknowledgmentCount?: number;
  createdBy?: string;
  createdByName?: string;
  createdAt: string;
  isActive?: boolean;
  hasViewed?: boolean;
  hasAcknowledged?: boolean;
  priority?: string;
}

/**
 * Ticket priority levels.
 */
export type ApiTicketPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Ticket status values.
 */
export type ApiTicketStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_customer'
  | 'pending_customer'
  | 'resolved'
  | 'closed';

/**
 * Ticket category values.
 */
export type ApiTicketCategory =
  | 'technical'
  | 'billing'
  | 'feature_request'
  | 'bug'
  | 'general';

/**
 * A support ticket from the API.
 * Fields match the myTickets / ticket GraphQL queries.
 */
export interface ApiSupportTicket {
  id: string;
  ticketNumber: string;
  tenantId?: string;
  tenantName?: string;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  assignedTo?: string;
  assignedToName?: string;
  reportedBy?: string;
  reportedByName?: string;
  createdBy?: string;
  createdByName?: string;
  commentCount: number;
  slaResponseDeadline?: string;
  slaResolutionDeadline?: string;
  firstResponseAt?: string;
  resolvedAt?: string;
  satisfactionRating?: number;
  satisfactionComment?: string;
  isResponseSLABreached?: boolean;
  isResolutionSLABreached?: boolean;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A comment on a support ticket.
 * Fields match the ticketComments GraphQL query.
 */
export interface ApiTicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string;
  authorType: 'admin' | 'tenant' | 'tenant_admin' | 'system';
  content: string;
  isInternal: boolean;
  attachments?: Array<{
    id: string;
    filename: string;
    fileName?: string;
    url: string;
    size: number;
    fileSize?: number;
  }>;
  createdAt: string;
}

// ============================================================================
// Re-export Permission Types
// ============================================================================

export type {
  PermissionCategory,
  PanelPermissions,
  TenantRolePermissions,
  PermissionAction,
  PermissionResource,
} from '../types/permissions';
