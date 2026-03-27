import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { VfdParameterDefinition } from '../types/vfd.types';
import { graphqlFetch } from '../config/api';
import { VFD_PARAMETER_DEFINITIONS_QUERY } from '../graphql/vfd-programming.operations';

const REFRESH_INTERVAL_MS = 30_000;

interface UseVfdParameterDefinitionsReturn {
  definitions: VfdParameterDefinition[];
  loading: boolean;
  error: string | null;
  fetchDefinitions: (vfdDeviceId: string, group?: string) => Promise<void>;
  getDefinitionsByGroup: () => Map<string, VfdParameterDefinition[]>;
  getDefinitionsByCategory: () => Map<string, VfdParameterDefinition[]>;
  getReadOnlyDefinitions: () => VfdParameterDefinition[];
  getWritableDefinitions: () => VfdParameterDefinition[];
}

/**
 * Hook for VFD parameter definitions.
 * Fetches on mount with vfdDeviceId, auto-refreshes every 30s for currentValue updates.
 */
export function useVfdParameterDefinitions(
  vfdDeviceId: string | undefined,
  group?: string,
): UseVfdParameterDefinitionsReturn {
  const [definitions, setDefinitions] = useState<VfdParameterDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDefinitions = useCallback(
    async (deviceId: string, filterGroup?: string) => {
      setLoading(true);
      setError(null);

      try {
        const variables: Record<string, unknown> = { vfdDeviceId: deviceId };
        if (filterGroup) {
          variables.group = filterGroup;
        }

        const data = await graphqlFetch<{
          vfdParameterDefinitions: VfdParameterDefinition[];
        }>(VFD_PARAMETER_DEFINITIONS_QUERY, variables);

        setDefinitions(data.vfdParameterDefinitions);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch parameter definitions';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Auto-fetch on mount and when vfdDeviceId/group changes
  useEffect(() => {
    if (!vfdDeviceId) return;

    fetchDefinitions(vfdDeviceId, group);

    intervalRef.current = setInterval(() => {
      fetchDefinitions(vfdDeviceId, group);
    }, REFRESH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [vfdDeviceId, group, fetchDefinitions]);

  const getDefinitionsByGroup = useMemo(() => {
    return () => {
      const grouped = new Map<string, VfdParameterDefinition[]>();
      for (const def of definitions) {
        const key = def.group;
        const existing = grouped.get(key) ?? [];
        existing.push(def);
        grouped.set(key, existing);
      }
      return grouped;
    };
  }, [definitions]);

  const getDefinitionsByCategory = useMemo(() => {
    return () => {
      const grouped = new Map<string, VfdParameterDefinition[]>();
      for (const def of definitions) {
        const key = def.category;
        const existing = grouped.get(key) ?? [];
        existing.push(def);
        grouped.set(key, existing);
      }
      return grouped;
    };
  }, [definitions]);

  const getReadOnlyDefinitions = useMemo(() => {
    return () => definitions.filter((d) => d.isReadable && !d.isWritable);
  }, [definitions]);

  const getWritableDefinitions = useMemo(() => {
    return () => definitions.filter((d) => d.isWritable);
  }, [definitions]);

  return {
    definitions,
    loading,
    error,
    fetchDefinitions,
    getDefinitionsByGroup,
    getDefinitionsByCategory,
    getReadOnlyDefinitions,
    getWritableDefinitions,
  };
}
