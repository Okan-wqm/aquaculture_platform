import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from './useAuth';
import { useTanks } from './useTanks';

import { GET_STOCK_EVENTS_SUMMARY } from '@/graphql/operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { StockEventsSummary, StockEvent } from '@/types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// WHY inline response type: keeps the GraphQL response shape co-located
// with the query that produces it, avoiding a global type for an internal detail.
interface StockEventsSummaryResponse {
  thisWeekEventsCount: number;
  recentEvents: StockEvent[];
}

/**
 * Aggregates batch count from useTanks and stock event data from a dedicated
 * aggregate query into a single StockEventsSummary for the Stock Events hub.
 *
 * WHY two data sources: active batch count is derived from tank data that is
 * already cached by useTanks (React Query deduplicates the fetch). Stock event
 * counts require a separate backend aggregate query to avoid pulling the full
 * event list just for a count.
 */
export function useStockEventsSummary(): {
  summary: StockEventsSummary;
  isLoading: boolean;
  /** ORPHAN-HIGH-595: either source failing makes the zeroes unknown, not real. */
  isError: boolean;
} {
  const { tenantId, isAuthenticated } = useAuth();

  // --- Source 1: Active batch count from cached tank data ---
  const { data: tanks, isLoading: tanksLoading, isError: tanksError } = useTanks();

  // --- Source 2: Stock events aggregate ---
  const {
    data: eventsSummary,
    isLoading: eventsLoading,
    isError: eventsError,
  } = useQuery<StockEventsSummaryResponse>({
    queryKey: createTenantQueryKey(tenantId, 'stockEventsSummary', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{
        stockEventsSummary: StockEventsSummaryResponse;
      }>(GET_STOCK_EVENTS_SUMMARY, { daysBack: 7 });
      return result.stockEventsSummary;
    },
    enabled: isAuthenticated && !!tenantId,
    // WHY 5min staleTime: stock events are recorded a few times per day at
    // most. 5 minutes avoids unnecessary refetches on page navigation.
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  });

  const summary = useMemo<StockEventsSummary>(() => {
    // WHY batchMetrics != null: a tank with batchMetrics means it has an
    // active batch stocked. Tanks in MAINTENANCE or empty have null batchMetrics.
    const activeBatchCount = tanks?.filter((t) => t.batchMetrics !== null).length ?? 0;

    const recentEvents = eventsSummary?.recentEvents ?? [];
    // FARM-HIGH-055: derive the transfer KPI from the real recent events instead
    // of the removed always-zero backend pendingTransferCount field.
    const recentTransferCount = recentEvents.filter((e) => e.type === 'TRANSFER').length;

    return {
      activeBatchCount,
      thisWeekEventsCount: eventsSummary?.thisWeekEventsCount ?? 0,
      recentTransferCount,
      recentEvents,
    };
  }, [tanks, eventsSummary]);

  const isLoading = tanksLoading || eventsLoading;
  // ORPHAN-HIGH-595: either source failing means the summary's zeroes are
  // unknown rather than real — the hub must be able to say so.
  const isError = tanksError || eventsError;

  return { summary, isLoading, isError };
}
