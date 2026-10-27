/**
 * Module access for the tenant administrator (PKG-06; ADR-051 §2 "Change"): a member's module
 * roles, read and replaced as a whole, and each owner module's designated managers.
 *
 * Every key is tenant-scoped through tenantKeys (createTenantQueryKey), so no cached grant
 * survives a tenant switch or an impersonation (web/CLAUDE.md, FE-CRITICAL-014). Saving a member's
 * roles refetches the member's roles and the manager listing: lowering a primary manager ends
 * the designation.
 */
import { useFeedbackMutation } from '@aquaculture/shared-ui';
import {
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  getModulePrimaryManagers,
  getUserModuleAccess,
  setUserModuleAccess,
  type ModuleAccessGrants,
  type ModulePrimaryManager,
} from '../lib/module-access-api';

import { tenantKeys } from './useTenantData';

export function useModulePrimaryManagers(): UseQueryResult<ModulePrimaryManager[], Error> {
  return useQuery({
    queryKey: tenantKeys.modulePrimaryManagers(),
    queryFn: getModulePrimaryManagers,
    staleTime: 60 * 1000,
  });
}

export function useUserModuleAccess(
  userId: string,
  enabled: boolean,
): UseQueryResult<ModuleAccessGrants, Error> {
  return useQuery({
    queryKey: tenantKeys.userModuleAccess(userId),
    queryFn: () => getUserModuleAccess(userId),
    enabled: enabled && userId.length > 0,
    staleTime: 30 * 1000,
  });
}

export interface SetUserModuleAccessVariables {
  readonly userId: string;
  readonly moduleAccess: ModuleAccessGrants;
}

export function useSetUserModuleAccess(): UseMutationResult<
  ModuleAccessGrants,
  Error,
  SetUserModuleAccessVariables
> {
  const queryClient = useQueryClient();
  return useFeedbackMutation({
    feedback: { success: 'Module access saved' },
    mutationFn: ({ userId, moduleAccess }: SetUserModuleAccessVariables) =>
      setUserModuleAccess(userId, moduleAccess),
    onSuccess: async (_saved, variables) => {
      await queryClient.invalidateQueries({
        queryKey: tenantKeys.userModuleAccess(variables.userId),
      });
      await queryClient.invalidateQueries({ queryKey: tenantKeys.modulePrimaryManagers() });
    },
  });
}
