/**
 * Custom Hooks for Tenant Admin Data
 *
 * Uses TanStack Query for data fetching and caching.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createTenantQueryKey, getTenantId } from '@aquaculture/shared-ui';
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
  updateTenant,
  getMyModuleIds,
  getModuleUsageStats,
  getEdgeDevices,
  getDeviceEvents,
  createTenantUser,
  updateTenantUser as updateTenantUserApi,
  deleteTenantUser as deleteTenantUserApi,
  deactivateTenantUser as deactivateTenantUserApi,
  getNotificationPreferences,
  updateNotificationPreferences as updateNotificationPrefsApi,
  getMobileUsersSettings,
  updateMobileUserSettings as updateMobileUserSettingsApi,
  // Communication
  getMyThreads,
  getThreadMessages,
  sendMessage,
  createThread,
  getMyTickets,
  getTicketComments,
  createTicket,
  addTicketComment,
  rateTicket,
  getMyAnnouncements,
  viewAnnouncement,
  acknowledgeAnnouncement as acknowledgeAnnouncementApi,
} from '../lib/api';
import type {
  Tenant,
  TenantStats,
  TenantModule,
  User,
  TenantDatabaseInfo,
  TableSchemaInfo,
  TableDataResult,
  GetTableDataInput,
  MessageThread,
  Message,
  Announcement,
  ApiSupportTicket,
  ApiTicketComment,
  ApiTicketCategory,
} from '../lib/types';
import { apiClient } from '../services/api-client';
import {
  APPROVE_DEVICE_MUTATION,
  PING_DEVICE_MUTATION,
  REBOOT_DEVICE_MUTATION,
  MAINTENANCE_DEVICE_MUTATION,
  DECOMMISSION_DEVICE_MUTATION,
} from '../graphql';

/**
 * Execute GraphQL query/mutation (used by device action hook).
 * @deprecated Use typed functions from lib/api.ts instead.
 */
async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  return apiClient.graphql<T>(query, variables);
}

// ============================================================================
// Query Keys
// ============================================================================

// Every key is tenant-scoped through the createTenantQueryKey SSoT
// (['tenant', tenantId, …]) so cache never leaks across a tenant switch /
// SUPER_ADMIN impersonation (web/CLAUDE.md FE-CRITICAL-014/015/016). `all` stays
// the bare ['tenant'] prefix purely for BROAD invalidation — react-query matches
// by prefix, so it still covers every tenant-scoped key below.
export const tenantKeys = {
  all: ['tenant'] as const,
  tenant: () => createTenantQueryKey(getTenantId(), 'info'),
  stats: () => createTenantQueryKey(getTenantId(), 'stats'),
  modules: () => createTenantQueryKey(getTenantId(), 'modules'),
  moduleIds: () => createTenantQueryKey(getTenantId(), 'moduleIds'),
  moduleUsageStats: () => createTenantQueryKey(getTenantId(), 'moduleUsageStats'),
  users: (filters?: Record<string, unknown>) =>
    createTenantQueryKey(getTenantId(), 'users', filters),
  database: () => createTenantQueryKey(getTenantId(), 'database'),
  tableSchema: (schemaName: string, tableName: string) =>
    createTenantQueryKey(getTenantId(), 'tableSchema', schemaName, tableName),
  tableData: (schemaName: string, tableName: string, offset: number, limit: number) =>
    createTenantQueryKey(getTenantId(), 'tableData', schemaName, tableName, offset, limit),
  // Devices
  devices: (filters?: Record<string, unknown>) =>
    createTenantQueryKey(getTenantId(), 'devices', filters),
  deviceEvents: (deviceId: string) =>
    createTenantQueryKey(getTenantId(), 'deviceEvents', deviceId),
  // Messaging
  threads: () => createTenantQueryKey(getTenantId(), 'threads'),
  threadMessages: (threadId: string) =>
    createTenantQueryKey(getTenantId(), 'threadMessages', threadId),
  // Support
  tickets: () => createTenantQueryKey(getTenantId(), 'tickets'),
  ticketComments: (ticketId: string) =>
    createTenantQueryKey(getTenantId(), 'ticketComments', ticketId),
  // Announcements
  announcements: () => createTenantQueryKey(getTenantId(), 'announcements'),
  // Settings
  notificationPreferences: () => createTenantQueryKey(getTenantId(), 'notifPrefs'),
  mobileUsersSettings: () => createTenantQueryKey(getTenantId(), 'mobileUsersSettings'),
  mobileUsers: () => createTenantQueryKey(getTenantId(), 'mobileUsers'),
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
    queryFn: () => getEdgeDevices({
      page: filters.page,
      limit: filters.limit,
      search: filters.search,
      lifecycleState: filters.lifecycleState,
      isOnline: filters.isOnline,
    }),
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
      const data = await getDeviceEvents(deviceId, 1, 50);
      return data.items;
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
      queryClient.invalidateQueries({ queryKey: createTenantQueryKey(getTenantId(), 'edgeDevice') });
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
    queryFn: () => getMyThreads(),
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
      const msgs = await getThreadMessages(threadId);
      // Refresh threads to update unread count
      queryClient.invalidateQueries({ queryKey: tenantKeys.threads() });
      return msgs;
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
    // senderName is derived server-side from the authenticated user
    // (SupportSendMessageInput has no senderName field).
    mutationFn: ({ threadId, content }: { threadId: string; content: string }) =>
      sendMessage({ threadId, content }),
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
    // senderName is derived server-side; SupportCreateThreadInput only takes
    // subject + initialMessage (mapped from `content`).
    mutationFn: ({ subject, content }: { subject: string; content: string }) =>
      createThread({ subject, content }),
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
    queryFn: () => getMyTickets(),
    staleTime: 60 * 1000,
  });
}

/**
 * Hook to fetch ticket comments
 */
export function useTicketComments(ticketId: string | null) {
  return useQuery({
    queryKey: tenantKeys.ticketComments(ticketId || ''),
    queryFn: () => getTicketComments(ticketId!),
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
    }) => createTicket(data),
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
      addTicketComment({ ticketId, content, authorName }),
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
      rateTicket({ ticketId, rating }),
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
    queryFn: () => getMyAnnouncements(),
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Hook to acknowledge an announcement
 */
export function useAcknowledgeAnnouncement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (announcementId: string) => acknowledgeAnnouncementApi(announcementId),
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
    mutationFn: (announcementId: string) => viewAnnouncement(announcementId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKeys.announcements() });
    },
  });
}

// ============================================================================
// User Mutation Hooks
// ============================================================================

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
      const variables: { limit: number; offset: number; status?: string; role?: string } = {
        limit: options.limit,
        offset: options.offset,
      };
      if (options.status && options.status !== 'all') variables.status = options.status;
      if (options.role && options.role !== 'all') variables.role = options.role;
      return getTenantUsers(variables);
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
      roleId?: string;
      sendInvitation?: boolean;
    }) => createTenantUser(input),
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
      updateTenantUserApi(userId, input),
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
    mutationFn: (userId: string) => deleteTenantUserApi(userId),
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
    mutationFn: (userId: string) => deactivateTenantUserApi(userId),
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
      const modules = await getMyModuleIds();
      const map: Record<string, string> = {};
      (modules || []).forEach((m: { id: string; code: string }) => {
        if (m.code) map[m.code] = m.id;
      });
      return map;
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface LocalModuleUsageStat {
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
      const stats = await getModuleUsageStats();
      const map: Record<string, LocalModuleUsageStat> = {};
      (stats || []).forEach((s: LocalModuleUsageStat) => {
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

/**
 * Hook to fetch notification preferences
 */
export function useNotificationPreferences(enabled = false) {
  return useQuery({
    queryKey: tenantKeys.notificationPreferences(),
    queryFn: () => getNotificationPreferences(),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Hook to update notification preferences
 *
 * FIX HIGH-08: Uses optimistic updates to prevent notification overwrite bug.
 * The mutation optimistically writes the new prefs into the cache so that a
 * concurrent read never returns stale data that would overwrite a save in
 * progress. On error the previous value is rolled back.
 */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<import('../lib/types').NotificationPreferences>) =>
      updateNotificationPrefsApi(input),
    onMutate: async (newPrefs) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: tenantKeys.notificationPreferences() });

      // Snapshot the previous value
      const previousPrefs = queryClient.getQueryData(tenantKeys.notificationPreferences());

      // Optimistically update the cache
      queryClient.setQueryData(
        tenantKeys.notificationPreferences(),
        (old: import('../lib/types').NotificationPreferences | undefined) =>
          old ? { ...old, ...newPrefs } : newPrefs,
      );

      return { previousPrefs };
    },
    onError: (_err, _newPrefs, context) => {
      // Rollback to the previous value on error
      if (context?.previousPrefs !== undefined) {
        queryClient.setQueryData(tenantKeys.notificationPreferences(), context.previousPrefs);
      }
    },
    onSettled: () => {
      // Always refetch after error or success to ensure server state
      queryClient.invalidateQueries({ queryKey: tenantKeys.notificationPreferences() });
    },
  });
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
      const [users, settings] = await Promise.all([
        getTenantUsers(),
        getMobileUsersSettings(),
      ]);
      const settingsMap = new Map<string, import('../lib/types').MobileUserSettingsData>();
      for (const s of settings || []) {
        settingsMap.set(s.userId, s);
      }
      return {
        users: (users || []).map((u): TenantUserBasic => ({
          id: u.id,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role,
          isActive: u.isActive ?? true,
        })),
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
    }) => updateMobileUserSettingsApi(input),
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
export type { TenantUserBasic };
export type {
  NotificationPreferences,
  MobileUserSettingsData,
  ModuleUsageStat,
} from '../lib/types';

// Re-export GraphQL mutation constants for pages that need them directly
export {
  APPROVE_DEVICE_MUTATION,
  PING_DEVICE_MUTATION,
  REBOOT_DEVICE_MUTATION,
  MAINTENANCE_DEVICE_MUTATION,
  DECOMMISSION_DEVICE_MUTATION,
};
