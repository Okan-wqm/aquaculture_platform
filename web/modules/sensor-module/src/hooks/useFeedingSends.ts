/**
 * Feeding program sends — the feeding parameter sets that left the draft
 * state, newest send first, one page at a time (the command log's feeding
 * section).
 *
 * WHY its own read and not useFeedingParameters: the PLC page lists every set
 * (drafts included) as a plain array; the command log needs a send log. The
 * server filters (`sentOnly`) and orders it (`lastSendAttemptAt`: sentAt once
 * the PLC write succeeded, else the failed or pending attempt), so a page is
 * never emptied by recently edited drafts, activating an older send does not
 * lift it above a newer one, and the page envelope (`total`, `totalPages`)
 * reaches the table's pager.
 *
 * WHAT: FEEDING_PARAMETERS_QUERY — the document the PLC page uses. The key
 * shares its 'feedingParameters' prefix, so the PLC page's post-mutation
 * invalidation refreshes this read as well.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { useTenantQuery } from '@aquaculture/shared-ui';

import { graphqlFetch } from '../config/api';
import { FEEDING_PARAMETERS_QUERY } from '../graphql/plc.operations';

import type { FeedingParameter, FeedingParameterFilter, PlcPagination } from './usePlcControl';

export interface FeedingSendsPage {
  items: FeedingParameter[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface FeedingSendsParams {
  page: number;
  limit: number;
}

const SENT_ONLY: FeedingParameterFilter = { sentOnly: true };

export function useFeedingSends({
  page,
  limit,
}: FeedingSendsParams): UseQueryResult<FeedingSendsPage> {
  const pagination: PlcPagination = { page, limit, sortBy: 'lastSendAttemptAt', sortOrder: 'DESC' };
  // useTenantQuery is the SSoT for the tenant-scoped key + authenticated-tenant gate.
  return useTenantQuery(
    ['feedingParameters', 'sends', page, limit],
    async () => {
      const data = await graphqlFetch<{ feedingParameters: FeedingSendsPage }>(
        FEEDING_PARAMETERS_QUERY,
        { filter: SENT_ONLY, pagination },
      );
      return data.feedingParameters;
    },
    { staleTime: 15_000 },
  );
}
