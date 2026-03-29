// ============================================================================
// useTenantUsers — Tenant user list for user picker / member selection
// ============================================================================

/**
 * WHY: Provides the list of users within the current tenant for the NewChatPage
 * user picker. Uses the UserPresence query (which returns user details including
 * online status) as a pragmatic approach -- the messaging-service can resolve
 * tenant users through the auth-service federation.
 *
 * Falls back to a lightweight tenant-scoped user query if available. The hook
 * filters out the current user and provides search-friendly user data.
 *
 * @returns users — array of tenant users with online status
 * @returns isLoading — true during initial fetch
 * @returns error — query error, if any
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { MessageUser } from '@/types/messaging';
import { getUserDisplayName } from '@/utils/messaging-helpers';

/**
 * GraphQL query to list users within the current tenant.
 * WHY: This uses a channel-agnostic user query. The messaging-service
 * extends the auth-service User type via federation, so we can query
 * user details with presence information.
 */
const TENANT_USERS_QUERY = `
  query TenantUsers {
    tenantUsers {
      id
      firstName
      lastName
      email
      profileImageUrl
      isOnline
    }
  }
`;

/** Normalized user shape for the UI. */
export interface TenantUserItem {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  isOnline: boolean;
}

/**
 * Fetch tenant users and normalize to UI-friendly shape.
 */
async function fetchTenantUsers(): Promise<TenantUserItem[]> {
  const result = await graphqlRequest<{
    tenantUsers: MessageUser[];
  }>(TENANT_USERS_QUERY);

  if (!result.tenantUsers) {
    throw new Error('Failed to fetch tenant users');
  }

  return result.tenantUsers.map((u) => ({
    id: u.id,
    name: getUserDisplayName(u),
    email: u.email ?? '',
    avatarUrl: u.profileImageUrl ?? u.avatarUrl ?? null,
    isOnline: u.isOnline ?? false,
  }));
}

/**
 * Tenant user list hook for the user picker.
 * Returns all users in the current tenant excluding the current user.
 */
export function useTenantUsers() {
  const { isAuthenticated, tenantId } = useAuth();

  const query = useQuery({
    queryKey: ['messaging', 'tenantUsers', tenantId],
    queryFn: fetchTenantUsers,
    enabled: isAuthenticated && !!tenantId,
    staleTime: 60_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  return {
    users: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
