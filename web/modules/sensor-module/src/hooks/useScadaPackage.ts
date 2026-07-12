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
  DEPLOY_SCADA_WITH_AUTOMATION,
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
export function useScadaPackages(
  filter?: ScadaPackageFilter,
  options?: { enabled?: boolean },
) {
  const { token, tenantId } = useAuth();
  const [packages, setPackages] = useState<ScadaPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<(ReturnType<typeof setTimeout>) | undefined>(undefined);

  // Callers that only want a SCOPED list (e.g. the unified editor resolving
  // the package linked to one process) must be able to skip the fetch
  // entirely while their scope key is absent — an unfiltered fetch returns
  // the whole tenant list, which a hydration path could wrongly adopt.
  const enabled = options?.enabled ?? true;

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
    // Disabled: report an empty, non-loading list and fetch nothing.
    if (!enabled) {
      setPackages([]);
      setLoading(false);
      return;
    }
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
  }, [fetchPackages, filterSearchTerm, token, tenantId, enabled]);

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
        // `status` is intentionally not here — package lifecycle (PUBLISHED /
        // ARCHIVED) is server-owned via deploy/delete, never a client update.
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

/** One automation step's outcome inside a bundle deploy. */
export interface AutomationDeployStepResult {
  programId: string;
  success: boolean;
  message?: string;
  commandId?: string;
}

/** Result of the atomic SCADA+automation bundle deploy. */
export interface UnifiedDeployResult {
  success: boolean;
  message?: string;
  automationResults: AutomationDeployStepResult[];
  scadaResult?: { packageId: string; success: boolean; message?: string };
}

/**
 * Atomic bundle deploy (GAP-3A): SCADA package + bound automation programs as
 * ONE signed release bundle — PUBLISHED only on the edge's two-phase
 * confirmation, so a half-deploy (SCADA without its programs, or vice versa)
 * is structurally impossible. Programs default to the package's
 * automationBindings; pass programIds to override.
 */
export function useDeployScadaBundle() {
  return useMutation({
    mutationFn: async ({
      packageId,
      deviceId,
      programIds,
    }: {
      packageId: string;
      deviceId: string;
      programIds?: string[];
    }) => {
      const data = await graphqlFetch<{ deployScadaWithAutomation: UnifiedDeployResult }>(
        DEPLOY_SCADA_WITH_AUTOMATION,
        { input: { packageId, deviceId, programIds } },
      );
      return data.deployScadaWithAutomation;
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
