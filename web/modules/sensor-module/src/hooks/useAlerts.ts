/**
 * Hook for fetching and managing alert history
 *
 * Uses the alert-engine's GraphQL API:
 * - alertHistory query (paginated, filterable by a severity set, acknowledged
 *   and resolved — every status tab is a server filter)
 * - acknowledgeAlert mutation
 * - resolveAlert mutation
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AlertSeverity } from '@platform/shared-ui/generated/graphql-types';
import { graphqlFetch } from '../config/api';

// ============================================================================
// Types
// ============================================================================

// The supergraph's enum (CRITICAL, HIGH, …): GraphQL sends and accepts the
// enum NAMES, so a lower-case copy here was rejected as a filter variable and
// never matched a returned row.
export type { AlertSeverity };

export interface AlertHistoryItem {
  id: string;
  ruleId: string;
  ruleName: string;
  sensorId?: string;
  farmId?: string;
  pondId?: string;
  severity: AlertSeverity;
  message: string;
  triggeringData: Record<string, unknown>;
  triggeredAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  acknowledgementNote?: string;
  resolved: boolean;
  resolvedAt?: string;
  createdAt: string;
}

/**
 * The status tabs. Each shows the rows whose status badge it names: 'active'
 * = open and unacknowledged, 'acknowledged' = open and acknowledged,
 * 'resolved' = cleared; 'open' = both open states, what a priority tile of the
 * console annunciator counts (shared-ui annunciatorScope).
 */
export type AlertStatusFilter = 'all' | 'open' | 'active' | 'acknowledged' | 'resolved';

export interface AlertFilters {
  status: AlertStatusFilter;
  /** Only alarms of these severities; empty for every severity. */
  severities: readonly AlertSeverity[];
  page: number;
  limit: number;
}

export interface AlertStats {
  total: number;
  active: number;
  acknowledged: number;
  resolved: number;
  critical: number;
  high: number;
}

/**
 * The variables of ALERT_HISTORY_QUERY; a filter left out does not narrow.
 * A type alias, not an interface: it is passed as graphqlFetch's
 * Record<string, unknown> variables, which an interface is not assignable to.
 */
export type AlertHistoryVariables = {
  page: number;
  limit: number;
  severities?: readonly AlertSeverity[];
  acknowledged?: boolean;
  resolved?: boolean;
};

/**
 * What each status tab asks alert-engine for. Both flags are server filters,
 * so a page of a tab is a page of exactly its alarms — narrowing a page
 * client-side after the server cut it would show short or empty pages while
 * matching rows wait on later ones.
 */
const STATUS_VARIABLES: Readonly<
  Record<AlertStatusFilter, Pick<AlertHistoryVariables, 'acknowledged' | 'resolved'>>
> = {
  all: {},
  open: { resolved: false },
  active: { acknowledged: false, resolved: false },
  acknowledged: { acknowledged: true, resolved: false },
  resolved: { resolved: true },
};

export function alertHistoryVariables(filters: AlertFilters): AlertHistoryVariables {
  return {
    page: filters.page,
    limit: filters.limit,
    ...(filters.severities.length > 0 ? { severities: filters.severities } : {}),
    ...STATUS_VARIABLES[filters.status],
  };
}

// ============================================================================
// GraphQL Queries and Mutations
// ============================================================================

const ALERT_HISTORY_QUERY = `
  query AlertHistory(
    $page: Int
    $limit: Int
    $severities: [AlertSeverity!]
    $acknowledged: Boolean
    $resolved: Boolean
  ) {
    alertHistory(
      page: $page
      limit: $limit
      severities: $severities
      acknowledged: $acknowledged
      resolved: $resolved
    ) {
      id
      ruleId
      ruleName
      sensorId
      farmId
      pondId
      severity
      message
      triggeringData
      triggeredAt
      acknowledged
      acknowledgedAt
      acknowledgedBy
      acknowledgementNote
      resolved
      resolvedAt
      createdAt
    }
  }
`;

const ACKNOWLEDGE_ALERT_MUTATION = `
  mutation AcknowledgeAlert($input: AcknowledgeAlertInput!) {
    acknowledgeAlert(input: $input) {
      id
      acknowledged
      acknowledgedAt
      acknowledgedBy
    }
  }
`;

const RESOLVE_ALERT_MUTATION = `
  mutation ResolveAlert($alertId: ID!) {
    resolveAlert(alertId: $alertId) {
      id
      resolved
      resolvedAt
    }
  }
`;

// ============================================================================
// Hook Implementation
// ============================================================================

const POLL_INTERVAL_MS = 30_000; // 30 seconds

export function useAlerts(initialFilters?: Partial<AlertFilters>) {
  const [alerts, setAlerts] = useState<AlertHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState<string | null>(null); // alertId being mutated
  const [filters, setFilters] = useState<AlertFilters>({
    status: 'all',
    severities: [],
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch alerts
  const fetchAlerts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ alertHistory: AlertHistoryItem[] }>(
        ALERT_HISTORY_QUERY,
        alertHistoryVariables(filters),
      );

      setAlerts(result.alertHistory || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // Initial fetch and polling
  useEffect(() => {
    fetchAlerts();

    // Set up polling
    pollRef.current = setInterval(() => {
      fetchAlerts(true);
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [fetchAlerts]);

  // Compute stats from current alert set
  const stats: AlertStats = {
    total: alerts.length,
    active: alerts.filter((a) => !a.acknowledged && !a.resolved).length,
    acknowledged: alerts.filter((a) => a.acknowledged && !a.resolved).length,
    resolved: alerts.filter((a) => a.resolved).length,
    critical: alerts.filter((a) => a.severity === 'CRITICAL' && !a.resolved).length,
    high: alerts.filter((a) => a.severity === 'HIGH' && !a.resolved).length,
  };

  // Acknowledge an alert (optimistic update)
  const acknowledgeAlert = useCallback(async (alertId: string, note?: string) => {
    setMutating(alertId);

    // Optimistic update
    setAlerts((prev) =>
      prev.map((a) =>
        a.id === alertId
          ? { ...a, acknowledged: true, acknowledgedAt: new Date().toISOString() }
          : a,
      ),
    );

    try {
      await graphqlFetch(ACKNOWLEDGE_ALERT_MUTATION, {
        input: { alertId, note },
      });
      // Refresh to get server state
      await fetchAlerts(true);
    } catch (err) {
      // Revert optimistic update
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? { ...a, acknowledged: false, acknowledgedAt: undefined }
            : a,
        ),
      );
      setError((err as Error).message);
    } finally {
      setMutating(null);
    }
  }, [fetchAlerts]);

  // Resolve an alert (optimistic update)
  const resolveAlert = useCallback(async (alertId: string) => {
    setMutating(alertId);

    // Optimistic update
    setAlerts((prev) =>
      prev.map((a) =>
        a.id === alertId
          ? { ...a, resolved: true, resolvedAt: new Date().toISOString() }
          : a,
      ),
    );

    try {
      await graphqlFetch(RESOLVE_ALERT_MUTATION, {
        alertId,
      });
      // Refresh to get server state
      await fetchAlerts(true);
    } catch (err) {
      // Revert optimistic update
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? { ...a, resolved: false, resolvedAt: undefined }
            : a,
        ),
      );
      setError((err as Error).message);
    } finally {
      setMutating(null);
    }
  }, [fetchAlerts]);

  // Update filters (resets page to 1)
  const updateFilters = useCallback((partial: Partial<AlertFilters>) => {
    setFilters((prev) => ({
      ...prev,
      ...partial,
      page: partial.page ?? 1,
    }));
  }, []);

  // Set page without resetting other filters
  const setPage = useCallback((page: number) => {
    setFilters((prev) => ({ ...prev, page }));
  }, []);

  return {
    alerts,
    loading,
    error,
    mutating,
    stats,
    filters,
    updateFilters,
    setPage,
    acknowledgeAlert,
    resolveAlert,
    refetch: () => fetchAlerts(),
  };
}
