/**
 * The viewer's active sites — the rows of every site table and the names the
 * alarm panel prints. farm-service scopes them to a module user's sites.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import { ACTIVE_SITES_QUERY } from './dashboard.operations';

export interface DashboardSite {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly timezone: string | null;
}

export const SITE_REFRESH_MS = 60_000;

export function useActiveSites(): UseQueryResult<readonly DashboardSite[]> {
  return useTenantQuery(
    ['dashboard', 'activeSites'],
    async ({ signal }): Promise<readonly DashboardSite[]> => {
      const data = await graphqlClient.request<{ activeSites: DashboardSite[] }>(
        ACTIVE_SITES_QUERY,
        undefined,
        { signal },
      );
      return data.activeSites;
    },
    { staleTime: SITE_REFRESH_MS, refetchInterval: SITE_REFRESH_MS },
  );
}
