/**
 * Announcements Hooks
 *
 * React hooks for announcement operations.
 * Communicates with auth-service via the Apollo Federation gateway
 * using the shared-ui graphqlClient and useGraphQL hooks.
 *
 * Replaces the old REST-based hooks that called supportApi.
 */

import { useGraphQLQuery, useGraphQLMutation, graphqlClient } from '@aquaculture/shared-ui';
import {
  ADMIN_GET_ANNOUNCEMENTS,
  ADMIN_GET_ANNOUNCEMENT,
  ADMIN_GET_ANNOUNCEMENT_STATS,
  ADMIN_CREATE_PLATFORM_ANNOUNCEMENT,
  ADMIN_CREATE_TENANT_ANNOUNCEMENT,
  ADMIN_PUBLISH_ANNOUNCEMENT,
  ADMIN_CANCEL_ANNOUNCEMENT,
  ADMIN_DELETE_ANNOUNCEMENT,
  ADMIN_VIEW_ANNOUNCEMENT,
  ADMIN_ACKNOWLEDGE_ANNOUNCEMENT,
} from '../graphql/messaging-operations';
import type {
  AnnouncementType,
  AnnouncementStatus,
  AnnouncementTarget,
} from '../services/types/support';

// ============================================================================
// GraphQL response types
// ============================================================================

/** Announcement list item from myAnnouncements query */
interface GqlAnnouncementListItem {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  scope: string;
  isGlobal: boolean;
  publishAt: string | null;
  expiresAt: string | null;
  requiresAcknowledgment: boolean;
  viewCount: number;
  acknowledgmentCount: number;
  createdByName: string;
  createdAt: string;
  isActive: boolean;
  hasViewed?: boolean;
  hasAcknowledged?: boolean;
}

/** Full announcement from announcement query */
interface GqlAnnouncement {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  scope: string;
  tenantId: string | null;
  isGlobal: boolean;
  targetCriteria: AnnouncementTarget | null;
  publishAt: string | null;
  expiresAt: string | null;
  requiresAcknowledgment: boolean;
  viewCount: number;
  acknowledgmentCount: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/** Announcement statistics */
export interface AnnouncementStats {
  total: number;
  published: number;
  scheduled: number;
  draft: number;
  expired: number;
  totalViews: number;
  totalAcknowledgments: number;
}

/** Acknowledgment record */
interface GqlAcknowledgment {
  id: string;
  announcementId: string;
  userId: string;
  userName: string;
  tenantId: string | null;
  tenantName: string | null;
  viewedAt: string;
  acknowledgedAt: string | null;
}

/** Input for creating a platform-wide announcement */
interface CreatePlatformAnnouncementInput {
  title: string;
  content: string;
  type?: AnnouncementType;
  isGlobal?: boolean;
  targetCriteria?: AnnouncementTarget;
  publishAt?: string;
  expiresAt?: string;
  requiresAcknowledgment?: boolean;
}

/** Input for creating a tenant-level announcement */
interface CreateTenantAnnouncementInput {
  title: string;
  content: string;
  type?: AnnouncementType;
  publishAt?: string;
  expiresAt?: string;
  requiresAcknowledgment?: boolean;
}

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Fetch announcements with optional status and type filters.
 */
export function useAdminAnnouncements(
  status?: AnnouncementStatus,
  type?: AnnouncementType,
) {
  const result = useGraphQLQuery<
    { myAnnouncements: GqlAnnouncementListItem[] },
    { status?: AnnouncementStatus; type?: AnnouncementType }
  >('AdminAnnouncements', ADMIN_GET_ANNOUNCEMENTS, {
    variables: {
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    },
    enabled: true,
  });

  return {
    data: result.data?.myAnnouncements ?? null,
    isLoading: result.isLoading,
    error: result.error ? (result.error.message || 'Failed to load announcements') : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch a single announcement by ID.
 */
export function useAdminAnnouncement(announcementId: string | null) {
  const result = useGraphQLQuery<
    { announcement: GqlAnnouncement },
    { id: string }
  >('AdminAnnouncement', ADMIN_GET_ANNOUNCEMENT, {
    variables: { id: announcementId ?? '' },
    enabled: !!announcementId,
  });

  return {
    data: result.data?.announcement ?? null,
    isLoading: result.isLoading,
    error: result.error ? (result.error.message || 'Failed to load announcement') : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch announcement statistics.
 */
export function useAnnouncementStats() {
  const result = useGraphQLQuery<
    { announcementStats: AnnouncementStats }
  >('AdminAnnouncementStats', ADMIN_GET_ANNOUNCEMENT_STATS, {
    enabled: true,
  });

  return {
    data: result.data?.announcementStats ?? null,
    isLoading: result.isLoading,
    error: result.error ? (result.error.message || 'Failed to load stats') : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch acknowledgments for a specific announcement.
 *
 * NOTE: The auth-service resolver does not expose a dedicated
 * acknowledgments list query. This is kept as a placeholder.
 * The GraphQL schema provides viewAnnouncement and acknowledgeAnnouncement
 * mutations for individual user actions instead.
 */
export function useAnnouncementAcks(announcementId: string | null) {
  // Placeholder: return empty array until a dedicated query is available
  return {
    data: announcementId ? ([] as GqlAcknowledgment[]) : null,
    isLoading: false,
    error: null,
    refetch: async () => { /* noop */ },
  };
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Create a platform-wide announcement (SuperAdmin).
 *
 * This replaces the old generic useCreateAnnouncement for platform scope.
 */
export function useCreateAnnouncement() {
  const { mutate, isLoading, error, data } = useGraphQLMutation<
    { createPlatformAnnouncement: GqlAnnouncement },
    { input: CreatePlatformAnnouncementInput }
  >(ADMIN_CREATE_PLATFORM_ANNOUNCEMENT);

  return {
    mutate: (params: { input: CreatePlatformAnnouncementInput }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to create announcement') : null,
    data: data?.createPlatformAnnouncement ?? null,
  };
}

/**
 * Create a tenant-level announcement (TenantAdmin).
 */
export function useCreateTenantAnnouncement() {
  const { mutate, isLoading, error, data } = useGraphQLMutation<
    { createTenantAnnouncement: GqlAnnouncement },
    { input: CreateTenantAnnouncementInput }
  >(ADMIN_CREATE_TENANT_ANNOUNCEMENT);

  return {
    mutate: (params: { input: CreateTenantAnnouncementInput }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to create tenant announcement') : null,
    data: data?.createTenantAnnouncement ?? null,
  };
}

/**
 * Update an existing announcement.
 *
 * NOTE: The auth-service announcement resolver does not expose an
 * updateAnnouncement mutation. This is kept as a placeholder to
 * preserve the exported API. The backend currently only supports
 * create/publish/cancel/delete flows.
 */
export function useUpdateAnnouncement() {
  return {
    mutate: async (_params: { id: string; input: Partial<GqlAnnouncement> }) => {
      // TODO: Replace with GraphQL mutation when auth-service exposes updateAnnouncement
    },
    isLoading: false,
    error: null,
  };
}

/**
 * Publish an announcement.
 */
export function usePublishAnnouncement() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { publishAnnouncement: Pick<GqlAnnouncement, 'id' | 'status' | 'updatedAt'> },
    { id: string }
  >(ADMIN_PUBLISH_ANNOUNCEMENT);

  return {
    mutate: (params: { id: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to publish announcement') : null,
  };
}

/**
 * Cancel (unpublish) an announcement.
 */
export function useCancelAnnouncement() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { cancelAnnouncement: Pick<GqlAnnouncement, 'id' | 'status' | 'updatedAt'> },
    { id: string }
  >(ADMIN_CANCEL_ANNOUNCEMENT);

  return {
    mutate: (params: { id: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to cancel announcement') : null,
  };
}

/**
 * Delete a draft announcement.
 */
export function useDeleteAnnouncement() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { deleteAnnouncement: boolean },
    { id: string }
  >(ADMIN_DELETE_ANNOUNCEMENT);

  return {
    mutate: (params: { id: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to delete announcement') : null,
  };
}

/**
 * Mark an announcement as viewed.
 */
export function useViewAnnouncement() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { viewAnnouncement: GqlAcknowledgment },
    { id: string }
  >(ADMIN_VIEW_ANNOUNCEMENT);

  return {
    mutate: (params: { id: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to mark as viewed') : null,
  };
}

/**
 * Acknowledge an announcement.
 */
export function useAcknowledgeAnnouncement() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { acknowledgeAnnouncement: GqlAcknowledgment },
    { id: string }
  >(ADMIN_ACKNOWLEDGE_ANNOUNCEMENT);

  return {
    mutate: (params: { id: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to acknowledge') : null,
  };
}

// ============================================================================
// Direct graphqlClient helpers (imperative, non-hook usage)
// ============================================================================

/**
 * Imperative helper for fetching a single announcement outside React components.
 */
export async function fetchAnnouncement(announcementId: string): Promise<GqlAnnouncement | null> {
  const result = await graphqlClient.request<{ announcement: GqlAnnouncement }>(
    ADMIN_GET_ANNOUNCEMENT,
    { id: announcementId },
  );
  return result?.announcement ?? null;
}

/**
 * Imperative helper for fetching announcement stats.
 */
export async function fetchAnnouncementStats(): Promise<AnnouncementStats | null> {
  const result = await graphqlClient.request<{ announcementStats: AnnouncementStats }>(
    ADMIN_GET_ANNOUNCEMENT_STATS,
  );
  return result?.announcementStats ?? null;
}
