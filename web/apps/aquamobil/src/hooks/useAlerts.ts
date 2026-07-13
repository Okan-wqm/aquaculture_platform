// ============================================================================
// useAlerts — mobile alarm surface over the alert-engine (MOB-HIGH-006)
// ============================================================================
//
// Field workers previously had NO alarm view on the device that is actually
// with them at the tank (the full alarm stack lived only in the desktop
// sensor-module). This hook binds `alertHistory` + `acknowledgeAlert` to
// mobile with the platform's offline discipline:
//   - reads poll while the app is open and fall back to the encrypted
//     tenant-scoped IndexedDB cache when the network is down;
//   - acknowledgements ride the offline queue (queue-first like every mobile
//     write; AcknowledgeAlertInput extends MobileCommandEnvelopeInput so the
//     replay envelope is accepted, and the ack converges idempotently), with
//     an optimistic cache flip so the badge/banner clears immediately.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useAuth } from './useAuth';
import { useOfflineQueue } from './useOfflineQueue';

import type { AlertSeverity, MobileAlertFieldsFragment } from '@/generated/graphql';
import { MOBILE_ALERT_HISTORY } from '@/graphql/alert-operations';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

export type MobileAlert = MobileAlertFieldsFragment;

export interface UseAlertsOptions {
  severity?: AlertSeverity;
  limit?: number;
}

export interface UseAlertsResult {
  /** Unacknowledged first, newest first within each group. */
  alerts: MobileAlert[];
  unacknowledgedCount: number;
  /** The alerts the CriticalAlertBanner must keep on screen until acked. */
  criticalUnacknowledged: MobileAlert[];
  isLoading: boolean;
  error: string | null;
  /** Queue-first acknowledge with an optimistic local flip. */
  acknowledge: (alertId: string, note?: string) => Promise<void>;
  refetch: () => Promise<void>;
}

const DEFAULT_LIMIT = 50;
/** Poll cadence while the surface is mounted — alarms must not wait for focus. */
const ALERTS_REFETCH_INTERVAL_MS = 30_000;
/** Offline cache TTL: alarms older than a shift are stale enough to hide. */
const ALERTS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function sortAlerts(rows: readonly MobileAlert[]): MobileAlert[] {
  return [...rows].sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
    return new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime();
  });
}

export function useAlerts(options?: UseAlertsOptions): UseAlertsResult {
  const { tenantId } = useAuth();
  const { addToQueue } = useOfflineQueue();
  const queryClient = useQueryClient();

  const severity = options?.severity;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const offlineCacheKey = `alerts_${severity ?? 'all'}_${limit}`;

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'alerts', 'history', severity ?? 'all', limit),
    enabled: Boolean(tenantId),
    refetchInterval: ALERTS_REFETCH_INTERVAL_MS,
    queryFn: async (): Promise<MobileAlert[]> => {
      if (!tenantId) return [];
      try {
        const data = await graphqlRequest(MOBILE_ALERT_HISTORY, {
          page: 1,
          limit,
          severity: severity ?? null,
          acknowledged: null,
        });
        const rows = sortAlerts(data.alertHistory);
        // Encrypted tenant-scoped offline copy — the alarm list must survive a
        // cold offline open (React Query's cache is memory-only).
        await cacheData(tenantId, offlineCacheKey, rows, ALERTS_CACHE_TTL_MS);
        return rows;
      } catch (error) {
        // Offline / network failure: serve the last known alarm state rather
        // than an empty list that reads as "all clear".
        const cached = await getCachedData<MobileAlert[]>(tenantId, offlineCacheKey);
        if (cached) return cached;
        throw error;
      }
    },
  });

  const alerts = useMemo(() => query.data ?? [], [query.data]);

  const acknowledge = useCallback(
    async (alertId: string, note?: string): Promise<void> => {
      // Queue-first (the platform's single offline write path): the auto-sync
      // drains it within ~1s when online, and it survives an offline shift.
      await addToQueue('acknowledgeAlert', { alertId, note });
      // Optimistic flip so the banner/badge clears immediately; the post-sync
      // invalidation (['alerts']) reconciles with server truth.
      queryClient.setQueriesData<MobileAlert[]>(
        { queryKey: createTenantQueryKey(tenantId, 'alerts') },
        (existing) =>
          existing?.map((alert) =>
            alert.id === alertId
              ? {
                  ...alert,
                  acknowledged: true,
                  acknowledgedAt: new Date().toISOString(),
                  acknowledgementNote: note ?? alert.acknowledgementNote,
                }
              : alert,
          ),
      );
    },
    [addToQueue, queryClient, tenantId],
  );

  const { unacknowledgedCount, criticalUnacknowledged } = useMemo(() => {
    const unacked = alerts.filter((alert) => !alert.acknowledged);
    return {
      unacknowledgedCount: unacked.length,
      criticalUnacknowledged: unacked.filter((alert) => alert.severity === 'CRITICAL'),
    };
  }, [alerts]);

  return {
    alerts,
    unacknowledgedCount,
    criticalUnacknowledged,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    acknowledge,
    refetch: async (): Promise<void> => {
      await query.refetch();
    },
  };
}
