/**
 * The tenant's users, for whoever may list them (users:view — a tenant admin
 * passes): the inbox reads their roles and two-factor state, Recent activity
 * their names. One query under one key, so the two panels share one request.
 * For anyone else nothing is requested and the source is null.
 */
import { graphqlClient, useAuth, useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import type { UserRecord } from '../model/inbox';

import { TENANT_USERS_QUERY, type DashboardOperationResults } from './dashboard.operations';

const USERS_REFRESH_MS = 5 * 60_000;

export function useTenantUsers(): UseQueryResult<readonly UserRecord[]> | null {
  const { hasPermission } = useAuth();
  const canViewUsers = hasPermission('users:view');
  const users = useTenantQuery(
    ['dashboard', 'tenantUsers'],
    async ({ signal }): Promise<readonly UserRecord[]> =>
      (
        await graphqlClient.request<DashboardOperationResults['DashboardUsers']>(
          TENANT_USERS_QUERY,
          undefined,
          { signal },
        )
      ).tenantUsers,
    { enabled: canViewUsers, staleTime: USERS_REFRESH_MS, refetchInterval: USERS_REFRESH_MS },
  );
  return canViewUsers ? users : null;
}
