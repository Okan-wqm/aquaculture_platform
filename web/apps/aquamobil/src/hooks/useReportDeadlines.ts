// ============================================================================
// useReportDeadlines — the regulatory draft queue, fetched once for both shells
// ============================================================================

/**
 * WHY: the Mattilsynet draft queue is rendered by TWO screens — the phone's
 * Reports destination and the cabin board's Reports view. The query, its tenant
 * key, its three enabling gates and the order the rows come back in are the same
 * on both, so they live here rather than being typed out twice. React Query then
 * serves both from one cache entry: a manager who moves from the handheld to the
 * board does not re-fetch, and the two cannot show a different draft as "next".
 *
 * THREE GATES, all of which must hold before this asks the server anything:
 *   • AUTHENTICATED with a tenant — every other query on this client requires it;
 *   • ONLINE — a regulator submission is never queued on a device, so the queue
 *     itself is meaningless offline. The screens say so in words; the query
 *     simply does not run;
 *   • canReach('reports') — the MODULE_MANAGER floor mirroring
 *     @Roles(TENANT_ADMIN, MODULE_MANAGER) on RegulatoryReportDraftResolver
 *     (SEC-MEDIUM-050, FARM-HIGH-214). Gating the FETCH and not only the render
 *     means a MODULE_USER's device never issues a request the server will 403,
 *     and no screen can forget the floor by rendering the rows it was handed.
 *
 * It returns the RAW query result on purpose: `isError` then travels to the
 * caller by construction, which is what src/__tests__/query-error-surface.
 * invariant.spec.ts requires of every hook in this directory. Both callers pass
 * it through toLoadable()/<DataState/> so a failed fetch can never render as
 * "No reports due" — an all-clear about a regulator deadline is the most
 * expensive version of the defect this app has found seven times.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';

import type { MobileReportDeadlinesQuery } from '@/generated/graphql';
import { MOBILE_REPORT_DEADLINES } from '@/graphql/operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { useFeatureAccess } from '@/utils/feature-access';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/** One scheduled regulatory draft, exactly as the subgraph returns it. */
export type ReportDeadline = MobileReportDeadlinesQuery['reportDeadlines'][number];

/**
 * Overdue first, then soonest due; unscheduled rows sink to the bottom.
 *
 * Sorted HERE rather than in each screen so the handheld and the board agree on
 * which filing is next. `'9999'` is a sort sentinel for a null `dueAt` — it is a
 * comparison key and is never rendered; the row's own label says "Unscheduled".
 */
function byUrgency(rows: readonly ReportDeadline[]): ReportDeadline[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'),
    );
}

export function useReportDeadlines(): UseQueryResult<ReportDeadline[], Error> {
  const { tenantId, isAuthenticated } = useAuth();
  const isOnline = useNetworkStatus();
  const { canReach } = useFeatureAccess();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'reportDeadlines'),
    queryFn: async () => {
      const result = await graphqlRequest<MobileReportDeadlinesQuery>(MOBILE_REPORT_DEADLINES, {});
      return byUrgency(result.reportDeadlines);
    },
    enabled: isAuthenticated && !!tenantId && isOnline && canReach('reports'),
    staleTime: 1000 * 60,
  });
}
