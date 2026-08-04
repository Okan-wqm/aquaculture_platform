import {
  createTenantQueryKey,
  getSessionSnapshot,
  hasSameTenantSessionBoundary,
  useAuth,
} from '@aquaculture/shared-ui';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  assignUserToSite,
  getActiveTenantSites,
  getUserAssignedSiteIds,
  unassignUserFromSite,
  type SiteAssignmentResult,
  type TenantSiteAccessOption,
} from '../lib/api';

export const userSiteAccessKeys = {
  activeSites: (tenantId: string | null) =>
    createTenantQueryKey(tenantId, 'userSiteAccess', 'activeSites'),
  assignments: (tenantId: string | null, userId: string) =>
    createTenantQueryKey(tenantId, 'userSiteAccess', 'assignments', userId),
};

export function canManageUserSiteAccess(role: string | null | undefined): boolean {
  return role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';
}

export function useActiveTenantSites(
  enabled: boolean,
): UseQueryResult<TenantSiteAccessOption[], Error> {
  const { tenantId, token, user } = useAuth();
  const authorized = canManageUserSiteAccess(user?.role);

  return useQuery({
    queryKey: userSiteAccessKeys.activeSites(tenantId),
    queryFn: getActiveTenantSites,
    enabled: enabled && !!token && !!tenantId && authorized,
    staleTime: 2 * 60 * 1000,
  });
}

export function useUserAssignedSiteIds(
  userId: string,
  enabled: boolean,
): UseQueryResult<string[], Error> {
  const { tenantId, token, user } = useAuth();
  const authorized = canManageUserSiteAccess(user?.role);

  return useQuery({
    queryKey: userSiteAccessKeys.assignments(tenantId, userId),
    queryFn: () => getUserAssignedSiteIds(userId),
    enabled: enabled && !!token && !!tenantId && authorized && userId.length > 0,
    staleTime: 30 * 1000,
  });
}

export interface UserSiteMutationVariables {
  userId: string;
  siteId: string;
}

interface UserSiteMutationContext {
  assignmentQueryKey: readonly unknown[];
}

export class SiteAccessSessionChangedError extends Error {
  constructor() {
    super(
      'The site-access change completed for the previous session. Re-open the user in the current tenant.',
    );
    this.name = 'SiteAccessSessionChangedError';
  }
}

function useUserSiteMutation(
  kind: 'assign' | 'unassign',
): UseMutationResult<SiteAssignmentResult, Error, UserSiteMutationVariables> {
  const queryClient = useQueryClient();
  const { tenantId, user } = useAuth();
  // Capture the session epoch at render time. Query-key construction inside a
  // later click would otherwise append the *new* epoch to the old tenantId if
  // React has not rerendered yet during an account/tenant switch.
  const ownerSessionQueryKey = userSiteAccessKeys.activeSites(tenantId);

  const assertCurrentOwnerSession = (): void => {
    const currentSession = getSessionSnapshot();
    const currentSessionQueryKey = userSiteAccessKeys.activeSites(currentSession.effectiveTenantId);
    if (
      !currentSession.ready ||
      !hasSameTenantSessionBoundary(ownerSessionQueryKey, currentSessionQueryKey)
    ) {
      throw new SiteAccessSessionChangedError();
    }
  };

  return useMutation({
    onMutate: (variables): UserSiteMutationContext => {
      assertCurrentOwnerSession();
      return {
        assignmentQueryKey: userSiteAccessKeys.assignments(tenantId, variables.userId),
      };
    },
    mutationFn: async ({ userId, siteId }: UserSiteMutationVariables) => {
      if (!tenantId || !canManageUserSiteAccess(user?.role)) {
        throw new Error('Tenant-admin site access is not authorized');
      }
      assertCurrentOwnerSession();

      const result =
        kind === 'assign'
          ? await assignUserToSite(userId, siteId)
          : await unassignUserFromSite(userId, siteId);

      if (!result.success || result.userId !== userId || result.siteId !== siteId) {
        throw new Error('Site assignment response did not match the requested user and site');
      }
      return result;
    },
    onSuccess: async (_result, variables, context) => {
      const currentSession = getSessionSnapshot();
      const currentQueryKey = userSiteAccessKeys.assignments(
        currentSession.effectiveTenantId,
        variables.userId,
      );

      if (!hasSameTenantSessionBoundary(context.assignmentQueryKey, currentQueryKey)) {
        throw new SiteAccessSessionChangedError();
      }

      await queryClient.invalidateQueries({
        queryKey: context.assignmentQueryKey,
        exact: true,
        refetchType: 'none',
      });
    },
  });
}

export function useAssignUserToSite(): UseMutationResult<
  SiteAssignmentResult,
  Error,
  UserSiteMutationVariables
> {
  return useUserSiteMutation('assign');
}

export function useUnassignUserFromSite(): UseMutationResult<
  SiteAssignmentResult,
  Error,
  UserSiteMutationVariables
> {
  return useUserSiteMutation('unassign');
}
