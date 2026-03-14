/**
 * Hook for fetching and managing alert history
 *
 * Uses the alert-engine's GraphQL API:
 * - alertHistory query (paginated, filterable by severity/acknowledged)
 * - acknowledgeAlert mutation
 * - resolveAlert mutation
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { graphqlFetch } from '../config/api';

// ============================================================================
// Types
// ============================================================================

export type AlertSeverity = 'info' | 'low' | 'warning' | 'medium' | 'high' | 'critical';

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

export type AlertStatusFilter = 'all' | 'active' | 'acknowledged' | 'resolved';

export interface AlertFilters {
  status: AlertStatusFilter;
  severity?: AlertSeverity;
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

// ============================================================================
// GraphQL Queries and Mutations
// ============================================================================

const ALERT_HISTORY_QUERY = `
  query AlertHistory(
    $page: Int
    $limit: Int
    $severity: AlertSeverity
    $acknowledged: Boolean
  ) {
    alertHistory(
      page: $page
      limit: $limit
      severity: $severity
      acknowledged: $acknowledged
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
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build query variables from filters
  const buildVariables = useCallback((f: AlertFilters) => {
    const vars: Record<string, unknown> = {
      page: f.page,
      limit: f.limit,
    };

    if (f.severity) {
      vars.severity = f.severity;
    }

    // Map status filter to acknowledged boolean
    if (f.status === 'active') {
      vars.acknowledged = false;
    } else if (f.status === 'acknowledged') {
      vars.acknowledged = true;
    }
    // 'resolved' and 'all' are filtered client-side since the backend
    // query only supports acknowledged filter, not resolved

    return vars;
  }, []);

  // Fetch alerts
  const fetchAlerts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      const vars = buildVariables(filters);
      const result = await graphqlFetch<{ alertHistory: AlertHistoryItem[] }>(
        ALERT_HISTORY_QUERY,
        vars,
      );

      let items = result.alertHistory || [];

      // Client-side filter for 'resolved' status (backend doesn't have this filter)
      if (filters.status === 'resolved') {
        items = items.filter((a) => a.resolved);
      }

      setAlerts(items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, buildVariables]);

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
    critical: alerts.filter((a) => a.severity === 'critical' && !a.resolved).length,
    high: alerts.filter((a) => a.severity === 'high' && !a.resolved).length,
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
