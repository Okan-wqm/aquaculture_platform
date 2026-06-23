// ============================================================================
// useTenantUsers — Tenant user list for user picker / member selection
// ============================================================================

/**
 * WHY: Provides the list of users within the current tenant for the NewChatPage
 * user picker. Uses the UserPresence query (which returns user details including
 * online status) so one round-trip covers both identity + presence — the
 * messaging-service resolves tenant users through the auth-service federation
 * on this path, avoiding a second query for online state.
 *
 * Falls back to a lightweight tenant-scoped user query if available. The hook
 * filters out the current user and provides search-friendly user data.
 *
 * @returns users — array of tenant users with online status
 * @returns isLoading — true during initial fetch
 * @returns error — query error, if any
 */

import { useQuery } from '@tanstack/react-query';
import { gql } from 'graphql-tag';


import { useAuth } from './useAuth';

import { graphqlRequest } from '@/services/authenticated-fetch';
import type { MessageUser } from '@/types/messaging';
import { getUserDisplayName } from '@/utils/messaging-helpers';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/**
 * GraphQL query for the New Chat user picker (MSG-HIGH-051).
 * WHY: `channelEligibleUsers` (messaging-service) is open to ANY messaging user
 * and is tenant-scoped, unlike auth's admin-gated `tenantUsers` which 403'd
 * field workers. firstName/lastName/profileImageUrl are stitched from the
 * federated auth `User`; isOnline comes from messaging presence. `email` is
 * deliberately NOT requested (display-only — not exposed to channel members).
 */
const CHANNEL_ELIGIBLE_USERS_QUERY = gql`
  query ChannelEligibleUsers {
    channelEligibleUsers {
      id
      firstName
      lastName
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
    channelEligibleUsers: MessageUser[];
  }>(CHANNEL_ELIGIBLE_USERS_QUERY);

  if (!result.channelEligibleUsers) {
    throw new Error('Failed to fetch eligible users');
  }

  return result.channelEligibleUsers.map((u) => ({
    id: u.id,
    name: getUserDisplayName(u),
    // email is display-only (never exposed to channel members) — not requested;
    // the picker renders name + avatar + presence.
    email: '',
    avatarUrl: u.profileImageUrl ?? u.avatarUrl ?? null,
    isOnline: u.isOnline ?? false,
  }));
}

/** Return shape of {@link useTenantUsers}. */
export interface UseTenantUsersReturn {
  /** Tenant users normalized for the picker (empty until loaded). */
  users: TenantUserItem[];
  /** True during the initial fetch. */
  isLoading: boolean;
  /** Query error, or null. */
  error: Error | null;
}

/**
 * Tenant user list hook for the user picker.
 * Returns all users in the current tenant excluding the current user.
 */
export function useTenantUsers(): UseTenantUsersReturn {
  const { isAuthenticated, tenantId } = useAuth();

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'channelEligibleUsers'),
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
