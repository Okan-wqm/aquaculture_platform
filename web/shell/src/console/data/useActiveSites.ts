/**
 * useActiveSites — the viewer's active sites, one read for every console cell.
 *
 * WHY one query: the title block counts the active sites (useSiteStatus) and
 * the palette names a device's site (usePaletteSources). Both read
 * farm-service activeSites — site-scoped server-side, failing closed rather
 * than truncating — under one key, so the two make one request, share one
 * cache entry, and cannot disagree about which sites exist. Sites change
 * rarely, so a five-minute-old list serves.
 *
 * WHAT: the TanStack result of the sites' ids and names, in server order;
 * `enabled` is the caller's gate (the farm module, plus its own).
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import type { SiteResponse } from '@platform/shared-ui/generated/graphql-types';
import type { UseQueryResult } from '@tanstack/react-query';

import { ACTIVE_SITES_QUERY } from './console.operations';

export type ActiveSite = Pick<SiteResponse, 'id' | 'name'>;

const SITES_STALE_MS = 5 * 60_000;

export function useActiveSites(enabled: boolean): UseQueryResult<ActiveSite[]> {
  return useTenantQuery(
    ['console', 'activeSites'],
    async ({ signal }): Promise<ActiveSite[]> => {
      const data = await graphqlClient.request<{ activeSites: ActiveSite[] }>(
        ACTIVE_SITES_QUERY,
        undefined,
        { signal },
      );
      return data.activeSites;
    },
    { enabled, staleTime: SITES_STALE_MS },
  );
}
