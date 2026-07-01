import { useState, useEffect, useCallback, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';
import {
  GET_SCADA_PACKAGE,
  GET_SCADA_PACKAGES,
  CREATE_SCADA_PACKAGE,
  UPDATE_SCADA_PACKAGE,
  DELETE_SCADA_PACKAGE,
  DEPLOY_SCADA_PACKAGE,
} from '../graphql/scada-package.queries';
import type {
  ScadaPackage,
  ScadaPackageFilter,
  ScadaPackageListResult,
  ScadaPackageStatus,
} from '../types/scada-package.types';
import type { ScadaPackageJSON } from '../store/scada';

// Re-export types for backwards compatibility
export type {
  ScadaPackageStatus,
  WidgetPosition,
  ScreenWidget,
  Screen,
  AlarmRule,
  ControlPermissions,
  TrendConfig,
  PackageMeta,
  ScadaPackageData,
  ScadaPackage,
  ScadaPackageFilter,
  ScadaPackageListResult,
} from '../types/scada-package.types';
export type { ScadaPackageJSON } from '../store/scada';

// Hook for fetching SCADA packages list
export function useScadaPackages(filter?: ScadaPackageFilter) {
  const { token, tenantId } = useAuth();
  const [packages, setPackages] = useState<ScadaPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<(ReturnType<typeof setTimeout>) | undefined>(undefined);

  // Stabilize filter by individual fields instead of object reference
  const filterStatus = filter?.status;
  const filterProcessId = filter?.processId;
  const filterSearchTerm = filter?.searchTerm;

  const fetchPackages = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ scadaPackages: ScadaPackageListResult }>(
        GET_SCADA_PACKAGES,
        { filter: { status: filterStatus, processId: filterProcessId, searchTerm: filterSearchTerm } },
      );
      setPackages(result.scadaPackages.items);
    } catch (err) {
      console.error('Failed to fetch SCADA packages:', err);
      setError((err as Error).message);
      setPackages([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterProcessId, filterSearchTerm]);

  // Debounce searchTerm changes (300ms), immediate for other filter changes
  useEffect(() => {
    // AUTH-READINESS GATE: do not query before tenant context (token + tenantId)
    // is ready, otherwise the mount fetch races the auth lifecycle and queries
    // with a null tenant (401/empty). Re-runs when the tenant becomes ready/changes.
    if (!token || !tenantId) {
      setPackages([]);
      setLoading(false);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(fetchPackages, filterSearchTerm ? 300 : 0);
    return () => clearTimeout(debounceRef.current);
  }, [fetchPackages, filterSearchTerm, token, tenantId]);

  const refetch = useCallback(() => {
    fetchPackages();
  }, [fetchPackages]);

  return { packages, loading, error, refetch };
}

// Hook for fetching a single SCADA package by ID
export function useScadaPackageById(id: string | undefined) {
  const { token, tenantId } = useAuth();
  const [scadaPackage, setScadaPackage] = useState<ScadaPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPackage = useCallback(async () => {
    if (!id) {
      setScadaPackage(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ scadaPackage: ScadaPackage | null }>(
        GET_SCADA_PACKAGE,
        { id },
      );
      setScadaPackage(result.scadaPackage);
    } catch (err) {
      setError((err as Error).message);
      setScadaPackage(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // AUTH-READINESS GATE: do not query before tenant context (token + tenantId)
    // is ready, otherwise the mount fetch races the auth lifecycle and queries
    // with a null tenant (401/empty). Re-runs when the tenant becomes ready/changes.
    if (!token || !tenantId) {
      setScadaPackage(null);
      setLoading(false);
      return;
    }
    fetchPackage();
  }, [fetchPackage, token, tenantId]);

  const refetch = useCallback(() => {
    fetchPackage();
  }, [fetchPackage]);

  return { scadaPackage, loading, error, refetch };
}

// Mutation hook for creating a SCADA package
export function useCreateScadaPackage() {
  return useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string;
      processId?: string;
      packageData: ScadaPackageJSON;
    }) => {
      const data = await graphqlFetch<{ createScadaPackage: ScadaPackage }>(
        CREATE_SCADA_PACKAGE,
        { input },
      );
      return data.createScadaPackage;
    },
  });
}

// Mutation hook for updating a SCADA package
export function useUpdateScadaPackage() {
  return useMutation({
    mutationFn: async ({ id, input }: {
      id: string;
      input: {
        name?: string;
        description?: string;
        processId?: string;
        packageData?: ScadaPackageJSON;
        status?: ScadaPackageStatus;
      };
    }) => {
      const data = await graphqlFetch<{ updateScadaPackage: ScadaPackage }>(
        UPDATE_SCADA_PACKAGE,
        { id, input },
      );
      return data.updateScadaPackage;
    },
  });
}

// Mutation hook for deleting a SCADA package
export function useDeleteScadaPackage() {
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlFetch<{
        deleteScadaPackage: { success: boolean; message?: string; deletedId: string };
      }>(DELETE_SCADA_PACKAGE, { id });
      return data.deleteScadaPackage;
    },
  });
}

// Mutation hook for deploying a SCADA package to an edge device
export function useDeployScadaPackage() {
  return useMutation({
    mutationFn: async ({ packageId, deviceId }: { packageId: string; deviceId: string }) => {
      const data = await graphqlFetch<{
        deployScadaPackageToEdge: {
          success: boolean;
          message?: string;
          packageId: string;
          deviceId: string;
        };
      }>(DEPLOY_SCADA_PACKAGE, { packageId, deviceId });
      return data.deployScadaPackageToEdge;
    },
  });
}
