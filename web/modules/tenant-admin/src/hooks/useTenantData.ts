/**
 * Custom Hooks for Tenant Admin Data
 *
 * Uses TanStack Query for data fetching and caching.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey } from '@aquaculture/shared-ui';
import {
  getMyTenant,
  getTenantStats,
  getMyTenantModules,
  getTenantUsers,
  getTenantDatabase,
  getTableSchema,
  getTableData,
  assignModuleManager,
  removeModuleManager,
  updateTenantSettings,
} from '../lib/api';
import type {
  Tenant,
  TenantStats,
  TenantModule,
  User,
  TenantDatabaseInfo,
} from '../lib/types';

// ============================================================================
// Query Keys
// ============================================================================

export const tenantKeys = {
  all: ['tenant'] as const,
  tenant: () => [...tenantKeys.all, 'info'] as const,
  stats: () => [...tenantKeys.all, 'stats'] as const,
  modules: () => [...tenantKeys.all, 'modules'] as const,
  moduleIds: () => [...tenantKeys.all, 'moduleIds'] as const,
  moduleUsageStats: () => [...tenantKeys.all, 'moduleUsageStats'] as const,
  users: (filters?: Record<string, unknown>) =>
    [...tenantKeys.all, 'users', filters] as const,
  database: () => [...tenantKeys.all, 'database'] as const,
  tableSchema: (schemaName: string, tableName: string) =>
    [...tenantKeys.all, 'tableSchema', schemaName, tableName] as const,
  tableData: (schemaName: string, tableName: string, offset: number, limit: number) =>
    [...tenantKeys.all, 'tableData', schemaName, tableName, offset, limit] as const,
  // Devices
  devices: (filters?: Record<string, unknown>) =>
    [...tenantKeys.all, 'devices', filters] as const,
  deviceEvents: (deviceId: string) =>
    [...tenantKeys.all, 'deviceEvents', deviceId] as const,
  // Messaging
  threads: () => [...tenantKeys.all, 'threads'] as const,
  threadMessages: (threadId: string) =>
    [...tenantKeys.all, 'threadMessages', threadId] as const,
  // Support
  tickets: () => [...tenantKeys.all, 'tickets'] as const,
  ticketComments: (ticketId: string) =>
    [...tenantKeys.all, 'ticketComments', ticketId] as const,
  // Announcements
  announcements: () => [...tenantKeys.all, 'announcements'] as const,
  // Settings
  notificationPreferences: () => [...tenantKeys.all, 'notifPrefs'] as const,
  mobileUsersSettings: () => [...tenantKeys.all, 'mobileUsersSettings'] as const,
  mobileUsers: () => [...tenantKeys.all, 'mobileUsers'] as const,
};

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to get current tenant information
 */
export function useMyTenant() {
  return useQuery({
    queryKey: tenantKeys.tenant(),
    queryFn: getMyTenant,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get tenant statistics
 */
export function useTenantStats() {
  return useQuery({
    queryKey: tenantKeys.stats(),
    queryFn: getTenantStats,
    // MED-24: Replaced constant 60s polling with on-focus refetch to avoid
    // unnecessary network traffic when the user is on other pages/tabs.
    staleTime: 2 * 60 * 1000, // 2 minutes
    refetchOnWindowFocus: true,
  });
}

/**
 * Hook to get tenant modules
 */
export function useTenantModules() {
  return useQuery({
    queryKey: tenantKeys.modules(),
    queryFn: getMyTenantModules,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get tenant users
 */
export function useTenantUsers(options?: {
  status?: string;
  role?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: tenantKeys.users(options),
    queryFn: () => getTenantUsers(options),
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
}

/**
 * Hook to get tenant database information
 */
export function useTenantDatabase() {
  return useQuery({
    queryKey: tenantKeys.database(),
    queryFn: getTenantDatabase,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to assign module manager
 */
export function useAssignModuleManager() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ moduleId, userId }: { moduleId: string; userId: string }) =>
      assignModuleManager(moduleId, userId),
    onSuccess: () => {
      // Invalidate modules query to refetch
      queryClient.invalidateQueries({ queryKey: tenantKeys.modules() });
    },
  });
}

/**
 * Hook to remove module manager
 */
export function useRemoveModuleManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (moduleId: string) => removeModuleManager(moduleId),
    onSuccess: () => {
      // Invalidate modules query to refetch
      queryClient.invalidateQueries({ queryKey: tenantKeys.modules() });
    },
  });
}

/**
 * Hook to update tenant settings
 */
export function useUpdateTenantSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      { id, input }: {
        id: string;
        input: Partial<
          Pick<
            Tenant,
            'name' | 'description' | 'logoUrl' | 'contactEmail' | 'contactPhone' | 'address' | 'settings'
          >
        >;
      },
    ) => updateTenant(id, input),
    onSuccess: (data) => {
      // Update tenant cache
      queryClient.setQueryData(tenantKeys.tenant(), data);
    },
  });
}

// ============================================================================
// Edge Devices Hooks
// ============================================================================

interface EdgeDeviceListItem {
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

interface DeviceStats {
  total: number;
  online: number;
  offline: number;
  byState: Array<{ state: string; count: number }>;
}

interface EdgeDevicesResponse {
  edgeDevices: { items: EdgeDeviceListItem[]; total: number };
  edgeDeviceStats: DeviceStats;
}

interface EdgeDevicesFilters {
  page: number;
  limit: number;
  search?: string;
  lifecycleState?: string;
  isOnline?: boolean;
}

/**
 * Hook to fetch edge devices with filters and pagination
 */
export function useEdgeDevices(filters: EdgeDevicesFilters) {
  return useQuery({
    queryKey: tenantKeys.devices(filters as unknown as Record<string, unknown>),
    queryFn: async () => {
      const variables: Record<string, unknown> = {
        page: filters.page,
        limit: filters.limit,
      };
      if (filters.search) variables.search = filters.search;
      if (filters.lifecycleState) variables.lifecycleState = filters.lifecycleState;
      if (filters.isOnline !== undefined) variables.isOnline = filters.isOnline;
      return graphqlRequest<EdgeDevicesResponse>(EDGE_DEVICES_QUERY, variables);
    },
    staleTime: 30 * 1000,
  });
}

interface DeviceEvent {
  id: string;
  eventType: string;
  severity: string;
  message: string;
  createdAt: string;
}

/**
 * Hook to fetch device events
 */
export function useDeviceEvents(deviceId: string, enabled = true) {
  return useQuery({
    queryKey: tenantKeys.deviceEvents(deviceId),
    queryFn: async () => {
      const data = await graphqlRequest<{
        deviceEvents: { items: DeviceEvent[] };
      }>(DEVICE_EVENTS_QUERY, { deviceId, page: 1, limit: 50 });
      return data.deviceEvents.items;
    },
    enabled: !!deviceId && enabled,
    staleTime: 30 * 1000,
  });
}

/**
 * Hook for device action mutations (approve, ping, reboot, maintenance, decommission)
 */
export function useDeviceAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ mutation, variables }: { mutation: string; variables: Record<string, unknown> }) =>
      graphqlRequest(mutation, variables),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['edgeDevice'] });
      queryClient.invalidateQueries({ queryKey: tenantKeys.devices() });
    },
  });
}

// ============================================================================
// Messaging Hooks
// ============================================================================

/**
 * Hook to fetch message threads
 */
export function useMessageThreads() {
  return useQuery({
    queryKey: tenantKeys.threads(),
    queryFn: async () => {
      const result = await messagingApi.getThreads();
      return result.data || [];
    },
    staleTime: 30 * 1000,
  });
}

/**
 * Hook to fetch messages for a thread
 */
export function useThreadMessages(threadId: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: tenantKeys.threadMessages(threadId || ''),
    queryFn: async () => {
      if (!threadId) return [];
      const [msgs] = await Promise.all([
        messagingApi.getThreadMessages(threadId),
        messagingApi.markAsRead(threadId).catch(() => null),
      ]);
      // Refresh threads to update unread count
      queryClient.invalidateQueries({ queryKey: tenantKeys.threads() });
      return msgs || [];
    },
    enabled: !!threadId,
    staleTime: 15 * 1000,
  });
}

/**
 * Hook to send a message in a thread
 */
export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, content, senderName }: { threadId: string; content: string; senderName: string }) =>
      messagingApi.sendMessage(threadId, content, senderName),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.threadMessages(variables.threadId) });
      queryClient.invalidateQueries({ queryKey: tenantKeys.threads() });
    },
  });
}

/**
 * Hook to create a new message thread
 */
export function useCreateThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ subject, content, senderName }: { subject: string; content: string; senderName: string }) =>
      messagingApi.createThread(subject, content, senderName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.threads() });
    },
  });
}

// ============================================================================
// Support Tickets Hooks
// ============================================================================

/**
 * Hook to fetch support tickets
 */
export function useSupportTickets() {
  return useQuery({
    queryKey: tenantKeys.tickets(),
    queryFn: async () => {
      const result = await ticketsApi.getTickets();
      return result.data || [];
    },
    staleTime: 60 * 1000,
  });
}

/**
 * Hook to fetch ticket comments
 */
export function useTicketComments(ticketId: string | null) {
  return useQuery({
    queryKey: tenantKeys.ticketComments(ticketId || ''),
    queryFn: () => ticketsApi.getComments(ticketId!),
    enabled: !!ticketId,
    staleTime: 30 * 1000,
  });
}

/**
 * Hook to create a support ticket
 */
export function useCreateTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      subject: string;
      description: string;
      category?: ApiTicketCategory;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      createdByName: string;
      createdByEmail?: string;
    }) => ticketsApi.createTicket(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.tickets() });
    },
  });
}

/**
 * Hook to add a comment to a ticket
 */
export function useAddTicketComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, content, authorName }: { ticketId: string; content: string; authorName: string }) =>
      ticketsApi.addComment(ticketId, content, authorName),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.ticketComments(variables.ticketId) });
      queryClient.invalidateQueries({ queryKey: tenantKeys.tickets() });
    },
  });
}

/**
 * Hook to submit satisfaction rating for a ticket
 */
export function useSubmitTicketRating() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, rating }: { ticketId: string; rating: number }) =>
      ticketsApi.submitRating(ticketId, rating),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.tickets() });
    },
  });
}

// ============================================================================
// Announcements Hooks
// ============================================================================

/**
 * Hook to fetch announcements
 */
export function useAnnouncements() {
  return useQuery({
    queryKey: tenantKeys.announcements(),
    queryFn: () => announcementsApi.getAnnouncements(),
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Hook to acknowledge an announcement
 */
export function useAcknowledgeAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (announcementId: string) => announcementsApi.acknowledgeAnnouncement(announcementId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.announcements() });
    },
  });
}

/**
 * Hook to mark announcement as viewed
 */
export function useMarkAnnouncementViewed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (announcementId: string) => announcementsApi.markAsViewed(announcementId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.announcements() });
    },
  });
}

// ============================================================================
// User Mutation Hooks
// ============================================================================

interface ApiUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  isActive: boolean;
  isEmailVerified?: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

/**
 * Hook to fetch tenant users with pagination and filters (returns raw API users)
 */
export function useTenantUsersRaw(options: {
  limit: number;
  offset: number;
  status?: string;
  role?: string;
}) {
  return useQuery({
    queryKey: tenantKeys.users(options),
    queryFn: async () => {
      const variables: Record<string, unknown> = {
        limit: options.limit,
        offset: options.offset,
      };
      if (options.status && options.status !== 'all') variables.status = options.status;
      if (options.role && options.role !== 'all') variables.role = options.role;
      const data = await graphqlRequest<{ tenantUsers: ApiUser[] }>(TENANT_USERS_GQL, variables);
      return data.tenantUsers || [];
    },
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Hook to create a tenant user
 */
export function useCreateTenantUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      firstName: string;
      lastName: string;
      email: string;
      roleId: string;
      sendInvitation?: boolean;
    }) => graphqlRequest(CREATE_TENANT_USER_MUTATION, { input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.users() });
    },
  });
}

/**
 * Hook to update a tenant user
 */
export function useUpdateTenantUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: { firstName?: string; lastName?: string; roleId?: string } }) =>
      graphqlRequest(UPDATE_USER_MUTATION, { userId, input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.users() });
    },
  });
}

/**
 * Hook to delete a tenant user
 */
export function useDeleteTenantUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => graphqlRequest(DELETE_USER_MUTATION, { userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.users() });
    },
  });
}

/**
 * Hook to deactivate tenant users (bulk)
 */
export function useDeactivateTenantUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => graphqlRequest(DEACTIVATE_TENANT_USER_MUTATION, { userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.users() });
    },
  });
}

// ============================================================================
// Module Hooks (additional)
// ============================================================================

/**
 * Hook to fetch real module UUIDs (BUG-019)
 */
export function useModuleIds() {
  return useQuery({
    queryKey: tenantKeys.moduleIds(),
    queryFn: async () => {
      const data = await graphqlRequest<{ myModules: Array<{ id: string; code: string }> }>(MY_MODULES_ID_QUERY);
      const map: Record<string, string> = {};
      (data.myModules || []).forEach((m) => {
        if (m.code) map[m.code] = m.id;
      });
      return map;
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface ModuleUsageStat {
  moduleCode: string;
  userCount: number;
  lastAccessAt: string | null;
  actionsThisMonth: number;
  actionsLastMonth: number;
}

/**
 * Hook to fetch module usage stats
 */
export function useModuleUsageStats() {
  return useQuery({
    queryKey: tenantKeys.moduleUsageStats(),
    queryFn: async () => {
      const data = await graphqlRequest<{ moduleUsageStats: ModuleUsageStat[] }>(MODULE_USAGE_STATS_QUERY);
      const map: Record<string, ModuleUsageStat> = {};
      (data.moduleUsageStats || []).forEach((s) => {
        map[s.moduleCode] = s;
      });
      return map;
    },
    staleTime: 5 * 60 * 1000,
    // Graceful fallback -- usage stats are optional enrichment
    retry: 1,
  });
}

// ============================================================================
// Database Hooks (additional)
// ============================================================================

/**
 * Hook to fetch table schema
 */
export function useTableSchema(schemaName: string, tableName: string, enabled = false) {
  return useQuery({
    queryKey: tenantKeys.tableSchema(schemaName, tableName),
    queryFn: () => getTableSchema(schemaName, tableName),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to fetch table data
 */
export function useTableData(input: GetTableDataInput & { enabled?: boolean }) {
  const { enabled = false, ...rest } = input;
  return useQuery({
    queryKey: tenantKeys.tableData(rest.schemaName, rest.tableName, rest.offset ?? 0, rest.limit ?? 50),
    queryFn: () => getTableData(rest),
    enabled,
    staleTime: 30 * 1000,
  });
}

// ============================================================================
// Settings Hooks (additional)
// ============================================================================

interface NotificationPreferences {
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

/**
 * Hook to fetch notification preferences
 */
export function useNotificationPreferences(enabled = false) {
  return useQuery({
    queryKey: tenantKeys.notificationPreferences(),
    queryFn: async () => {
      const data = await graphqlRequest<{ getMyNotificationPreferences: NotificationPreferences }>(
        GET_NOTIFICATION_PREFERENCES_QUERY,
      );
      return data.getMyNotificationPreferences;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to update notification preferences
 */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<NotificationPreferences>) =>
      graphqlRequest(UPDATE_NOTIFICATION_PREFERENCES_MUTATION, { input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.notificationPreferences() });
    },
  });
}

interface MobileUserSettingsData {
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

interface TenantUserBasic {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  isActive: boolean;
}

/**
 * Hook to fetch mobile users and settings in parallel
 */
export function useMobileUsersData(enabled = false) {
  return useQuery({
    queryKey: tenantKeys.mobileUsersSettings(),
    queryFn: async () => {
      const [usersData, settingsData] = await Promise.all([
        graphqlRequest<{ tenantUsers: TenantUserBasic[] }>(TENANT_USERS_GQL),
        graphqlRequest<{ getMobileUsersSettings: MobileUserSettingsData[] }>(GET_MOBILE_USERS_SETTINGS_QUERY),
      ]);
      const settingsMap = new Map<string, MobileUserSettingsData>();
      for (const s of settingsData.getMobileUsersSettings || []) {
        settingsMap.set(s.userId, s);
      }
      return {
        users: usersData.tenantUsers || [],
        settings: settingsMap,
      };
    },
    enabled,
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Hook to update a mobile user's settings
 */
export function useUpdateMobileUserSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      userId: string;
      isMobileEnabled: boolean;
      mortality: boolean;
      cull: boolean;
      harvest: boolean;
      feeding: boolean;
      waterQuality: boolean;
      tankView: boolean;
    }) => graphqlRequest(UPDATE_MOBILE_USER_SETTINGS_MUTATION, { input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.mobileUsersSettings() });
    },
  });
}

// ============================================================================
// Re-export types
// ============================================================================

export type { Tenant, TenantStats, TenantModule, User, TenantDatabaseInfo, TableSchemaInfo, TableDataResult, GetTableDataInput };
export type { MessageThread, Message, Announcement };
export type { ApiSupportTicket, ApiTicketComment, ApiTicketCategory };
export type { EdgeDeviceListItem, DeviceStats, EdgeDevicesFilters, EdgeDevicesResponse, DeviceEvent };
export type { NotificationPreferences, MobileUserSettingsData, TenantUserBasic };
export type { ModuleUsageStat };

// Re-export GraphQL mutation constants for pages that need them directly
export {
  APPROVE_DEVICE_MUTATION,
  PING_DEVICE_MUTATION,
  REBOOT_DEVICE_MUTATION,
  MAINTENANCE_DEVICE_MUTATION,
  DECOMMISSION_DEVICE_MUTATION,
};
