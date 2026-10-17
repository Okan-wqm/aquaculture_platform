/**
 * The tenant's latest audit entries for the Recent activity panel — the
 * tenant admin's, as tenantAuditLogs is (the design's isAdmin gate); nothing
 * is requested for anyone else.
 */
import { graphqlClient, useAuth, useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import type { AuditEntry } from '../model/activity';

import { RECENT_AUDIT_QUERY, type DashboardOperationResults } from './dashboard.operations';

export const ACTIVITY_LIMIT = 5;
const ACTIVITY_REFRESH_MS = 60_000;

export function useRecentAudit(): UseQueryResult<readonly AuditEntry[]> | null {
  const { isTenantAdmin } = useAuth();
  const query = useTenantQuery(
    ['dashboard', 'recentAudit'],
    async ({ signal }): Promise<readonly AuditEntry[]> =>
      (
        await graphqlClient.request<DashboardOperationResults['DashboardRecentAudit']>(
          RECENT_AUDIT_QUERY,
          { limit: ACTIVITY_LIMIT },
          { signal },
        )
      ).tenantAuditLogs.data,
    {
      enabled: isTenantAdmin,
      staleTime: ACTIVITY_REFRESH_MS,
      refetchInterval: ACTIVITY_REFRESH_MS,
    },
  );
  return isTenantAdmin ? query : null;
}
