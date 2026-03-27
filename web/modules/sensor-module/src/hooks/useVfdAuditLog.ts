import { useState, useCallback } from 'react';
import { VfdParameterAuditLog } from '../types/vfd.types';
import { graphqlFetch } from '../config/api';
import { VFD_AUDIT_LOG_QUERY } from '../graphql/vfd-programming.operations';

const DEFAULT_LIMIT = 50;

interface Pagination {
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface UseVfdAuditLogReturn {
  logs: VfdParameterAuditLog[];
  loading: boolean;
  error: string | null;
  fetchLogs: (vfdDeviceId: string, parameterName?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  pagination: Pagination;
  getLogsByParameter: () => Map<string, VfdParameterAuditLog[]>;
  getLogsByUser: () => Map<string, VfdParameterAuditLog[]>;
}

/**
 * Hook for VFD parameter audit log with pagination and grouping helpers.
 * IEC 62443 compliant immutable audit trail.
 */
export function useVfdAuditLog(): UseVfdAuditLogReturn {
  const [logs, setLogs] = useState<VfdParameterAuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDeviceId, setLastDeviceId] = useState<string | null>(null);
  const [lastParameterName, setLastParameterName] = useState<string | undefined>(undefined);
  const [pagination, setPagination] = useState<Pagination>({
    offset: 0,
    limit: DEFAULT_LIMIT,
    hasMore: false,
  });

  const fetchLogs = useCallback(
    async (vfdDeviceId: string, parameterName?: string) => {
      setLoading(true);
      setError(null);
      setLastDeviceId(vfdDeviceId);
      setLastParameterName(parameterName);

      try {
        const variables: Record<string, unknown> = {
          vfdDeviceId,
          limit: DEFAULT_LIMIT,
        };
        if (parameterName) {
          variables.parameterName = parameterName;
        }

        const data = await graphqlFetch<{
          vfdParameterAuditLog: VfdParameterAuditLog[];
        }>(VFD_AUDIT_LOG_QUERY, variables);

        setLogs(data.vfdParameterAuditLog);
        setPagination({
          offset: 0,
          limit: DEFAULT_LIMIT,
          hasMore: data.vfdParameterAuditLog.length === DEFAULT_LIMIT,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch audit logs';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadMore = useCallback(async () => {
    if (!lastDeviceId || loading) return;

    setLoading(true);
    setError(null);
    const newOffset = pagination.offset + pagination.limit;

    try {
      const variables: Record<string, unknown> = {
        vfdDeviceId: lastDeviceId,
        limit: DEFAULT_LIMIT + newOffset,
      };
      if (lastParameterName) {
        variables.parameterName = lastParameterName;
      }

      const data = await graphqlFetch<{
        vfdParameterAuditLog: VfdParameterAuditLog[];
      }>(VFD_AUDIT_LOG_QUERY, variables);

      // The backend takes limit from 0, so we get all results and slice
      setLogs(data.vfdParameterAuditLog);
      setPagination({
        offset: newOffset,
        limit: DEFAULT_LIMIT,
        hasMore: data.vfdParameterAuditLog.length === DEFAULT_LIMIT + newOffset,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load more audit logs';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [lastDeviceId, lastParameterName, loading, pagination]);

  const getLogsByParameter = useCallback(() => {
    const grouped = new Map<string, VfdParameterAuditLog[]>();
    for (const log of logs) {
      const key = log.parameterName;
      const existing = grouped.get(key) ?? [];
      existing.push(log);
      grouped.set(key, existing);
    }
    return grouped;
  }, [logs]);

  const getLogsByUser = useCallback(() => {
    const grouped = new Map<string, VfdParameterAuditLog[]>();
    for (const log of logs) {
      const key = log.performedBy;
      const existing = grouped.get(key) ?? [];
      existing.push(log);
      grouped.set(key, existing);
    }
    return grouped;
  }, [logs]);

  return {
    logs,
    loading,
    error,
    fetchLogs,
    loadMore,
    pagination,
    getLogsByParameter,
    getLogsByUser,
  };
}
