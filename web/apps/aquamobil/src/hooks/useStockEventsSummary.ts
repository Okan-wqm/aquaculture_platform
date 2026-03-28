import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { useTanks } from './useTanks';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { GET_STOCK_EVENTS_SUMMARY } from '@/graphql/operations';
import type { StockEventsSummary, StockEvent } from '@/types';

// WHY inline response type: keeps the GraphQL response shape co-located
// with the query that produces it, avoiding a global type for an internal detail.
interface StockEventsSummaryResponse {
  thisWeekEventsCount: number;
  pendingTransferCount: number;
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
} {
  const { tenantId, isAuthenticated } = useAuth();

  // --- Source 1: Active batch count from cached tank data ---
  const { data: tanks, isLoading: tanksLoading } = useTanks();

  // --- Source 2: Stock events aggregate (new backend query) ---
  // WHY graceful fallback: the backend resolver may not be deployed yet.
  const {
    data: eventsSummary,
    isLoading: eventsLoading,
  } = useQuery<StockEventsSummaryResponse>({
    queryKey: ['stockEventsSummary', tenantId],
    queryFn: async () => {
      try {
        const result = await graphqlRequest<{
          stockEventsSummary: StockEventsSummaryResponse;
        }>(GET_STOCK_EVENTS_SUMMARY, { daysBack: 7 });
        return result.stockEventsSummary;
      } catch {
        // WHY swallow: resolver may not exist yet. Return safe defaults so
        // the hub page renders with zeros instead of an error screen.
        return { thisWeekEventsCount: 0, pendingTransferCount: 0, recentEvents: [] };
      }
    },
    enabled: isAuthenticated && !!tenantId,
    // WHY 5min staleTime: stock events are recorded a few times per day at
    // most. 5 minutes avoids unnecessary refetches on page navigation.
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: false,
  });

  const summary = useMemo<StockEventsSummary>(() => {
    // WHY batchMetrics != null: a tank with batchMetrics means it has an
    // active batch stocked. Tanks in MAINTENANCE or empty have null batchMetrics.
    const activeBatchCount = tanks?.filter((t) => t.batchMetrics !== null).length ?? 0;

    return {
      activeBatchCount,
      thisWeekEventsCount: eventsSummary?.thisWeekEventsCount ?? 0,
      pendingTransferCount: eventsSummary?.pendingTransferCount ?? 0,
      recentEvents: eventsSummary?.recentEvents ?? [],
    };
  }, [tanks, eventsSummary]);

  const isLoading = tanksLoading || eventsLoading;

  return { summary, isLoading };
}
