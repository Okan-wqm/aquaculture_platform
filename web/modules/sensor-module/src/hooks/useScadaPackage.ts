import { useState, useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { graphqlFetch } from '../config/api';
import {
  GET_SCADA_PACKAGE,
  GET_SCADA_PACKAGES,
  CREATE_SCADA_PACKAGE,
  UPDATE_SCADA_PACKAGE,
  DELETE_SCADA_PACKAGE,
  DEPLOY_SCADA_PACKAGE,
} from '../graphql/scada-package.queries';

// Types

export type ScadaPackageStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface WidgetPosition {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface ScreenWidget {
  id: string;
  widgetType: string;
  position: WidgetPosition;
  config: Record<string, any>;
}

export interface Screen {
  id: string;
  name: string;
  screenType: string;
  isDefault: boolean;
  icon: string;
  layout: { type: string; cols: number; rows: number };
  widgets: ScreenWidget[];
}

export interface AlarmRule {
  id: string;
  tag: string;
  condition: string;
  value: number;
  severity: 'critical' | 'high' | 'warning' | 'info';
  message: string;
  deadband?: number;
  delay?: number;
}

export interface ControlPermissions {
  securityLevels: { none: string[]; confirm: string[]; pin: string[] };
  pinHash: string | null;
  emergencyStop: {
    holdDuration: number;
    affectedTags: string[];
    resetRequiresPin: boolean;
  } | null;
}

export interface TrendConfig {
  retentionDays: number;
  sampleIntervalSec: number;
  tags: string[];
}

export interface PackageMeta {
  author?: string;
  description?: string;
  [key: string]: any;
}

export interface ScadaPackageData {
  meta?: PackageMeta;
  screens: Screen[];
  alarmRules: AlarmRule[];
  controlPermissions: ControlPermissions;
  trendConfig: TrendConfig;
}

export interface ScadaPackage {
  id: string;
  name: string;
  description?: string;
  version: number;
  processId?: string;
  processName?: string;
  packageData: ScadaPackageData;
  status: ScadaPackageStatus;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScadaPackageFilter {
  status?: ScadaPackageStatus;
  processId?: string;
  searchTerm?: string;
}

export interface ScadaPackageListResult {
  items: ScadaPackage[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// Hook for fetching SCADA packages list
export function useScadaPackages(filter?: ScadaPackageFilter) {
  const [packages, setPackages] = useState<ScadaPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPackages = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ scadaPackages: ScadaPackageListResult }>(
        GET_SCADA_PACKAGES,
        { filter },
      );
      setPackages(result.scadaPackages.items);
    } catch (err) {
      console.error('Failed to fetch SCADA packages:', err);
      setError((err as Error).message);
      setPackages([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchPackages();
  }, [fetchPackages]);

  const refetch = useCallback(() => {
    fetchPackages();
  }, [fetchPackages]);

  return { packages, loading, error, refetch };
}

// Hook for fetching a single SCADA package by ID
export function useScadaPackageById(id: string | undefined) {
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
    fetchPackage();
  }, [fetchPackage]);

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
      packageData: ScadaPackageData;
      status?: ScadaPackageStatus;
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
        packageData?: ScadaPackageData;
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
