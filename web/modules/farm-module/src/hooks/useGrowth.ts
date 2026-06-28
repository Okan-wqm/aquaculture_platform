/**
 * Growth hooks for farm-module
 *
 * Buyume olcumleri ve analiz icin React Query hook'lari.
 * Backend growth.resolver.ts ile uyumlu CRUD operasyonlari.
 *
 * @module FarmModule/Hooks
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import {
  GROWTH_MEASUREMENT_QUERY,
  GROWTH_MEASUREMENTS_QUERY,
  GROWTH_ANALYSIS_QUERY,
  LATEST_GROWTH_MEASUREMENT_QUERY,
  BATCH_GROWTH_HISTORY_QUERY,
  RECORD_GROWTH_SAMPLE_MUTATION,
  UPDATE_BATCH_WEIGHT_FROM_SAMPLE_MUTATION,
  VERIFY_MEASUREMENT_MUTATION,
} from '../graphql/growth.operations';

// ============================================================================
// TYPES
// ============================================================================

export type MeasurementType =
  | 'routine'
  | 'transfer'
  | 'grading'
  | 'harvest'
  | 'health_check'
  | 'spot_check';

export type MeasurementMethod =
  | 'manual_scale'
  | 'automated_scale'
  | 'image_analysis'
  | 'sonar'
  | 'estimated';

export type GrowthPerformance =
  | 'excellent'
  | 'good'
  | 'average'
  | 'below_average'
  | 'poor';

export interface IndividualMeasurement {
  sampleNumber: number;
  weight: number;
  length?: number;
  width?: number;
  notes?: string;
}

export interface MeasurementConditions {
  waterTemp?: number;
  dissolvedOxygen?: number;
  feedingStatus: string;
  timeOfDay: string;
  weatherConditions?: string;
}

export interface GrowthMeasurement {
  id: string;
  tenantId: string;
  batchId: string;
  tankId?: string;
  pondId?: string;
  measurementDate: string;
  measurementType: MeasurementType;
  measurementMethod: MeasurementMethod;
  sampleSize: number;
  populationSize: number;
  samplePercent: number;
  individualMeasurements: IndividualMeasurement[];
  statistics: any;
  averageWeight: number;
  averageLength?: number;
  weightCV: number;
  conditionFactor?: number;
  growthComparison?: any;
  performance?: GrowthPerformance;
  fcrAnalysis?: any;
  estimatedBiomass: number;
  previousBiomass?: number;
  biomassGain?: number;
  suggestedActions?: any;
  conditions?: MeasurementConditions;
  isVerified: boolean;
  verifiedBy?: string;
  verifiedAt?: string;
  measuredBy: string;
  notes?: string;
  updateBatchWeight: boolean;
  isProcessed: boolean;
  createdAt: string;
  updatedAt: string;
  // Computed fields from resolver
  isUniformGrowth: boolean;
  needsGrading: boolean;
  isOnTarget: boolean;
  isFCROnTarget: boolean;
  minWeight: number;
  maxWeight: number;
  medianWeight: number;
  weightStdDev: number;
  weightRange: number;
  dailyGrowthRate?: number;
  specificGrowthRate?: number;
  periodFCR?: number;
  cumulativeFCR?: number;
  fcrTrend?: string;
  hasHighPriorityActions: boolean;
  actionCount: number;
}

export interface GrowthMeasurementConnection {
  items: GrowthMeasurement[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface GrowthMeasurementFilter {
  batchId?: string;
  tankId?: string;
  measurementType?: MeasurementType;
  startDate?: string;
  endDate?: string;
  verifiedOnly?: boolean;
}

export interface GrowthPagination {
  page?: number;
  limit?: number;
}

export interface GrowthMetrics {
  currentAvgWeightG: number;
  theoreticalWeightG: number;
  weightVariancePercent: number;
  currentBiomassKg: number;
  currentQuantity: number;
  survivalRate: number;
  mortalityRate: number;
  currentFCR: number;
  targetFCR: number;
  fcrVariancePercent: number;
  dailyGrowthRateG: number;
  specificGrowthRate: number;
  weightCV: number;
  performanceRating: GrowthPerformance;
}

export interface GrowthTrend {
  direction: string;
  avgDailyGrowthLast7Days: number;
  avgDailyGrowthLast30Days: number;
  growthAcceleration: number;
  fcrTrend: string;
  fcrChangeLast7Days: number;
}

export interface GrowthProjection {
  projectedWeightIn30Days: number;
  projectedBiomassIn30Days: number;
  estimatedHarvestDate: string;
  harvestTargetWeightG: number;
  daysToHarvest: number;
  projectedTotalFeedKg: number;
  projectedFinalFCR: number;
}

export interface GrowthRecommendation {
  priority: string;
  type: string;
  description: string;
  reason: string;
  actionRequired?: string;
}

export interface GrowthMeasurementSummary {
  id: string;
  measurementDate: string;
  averageWeight: number;
  weightCV: number;
  sampleSize: number;
  estimatedBiomass: number;
  dailyGrowthRate?: number;
  periodFCR?: number;
  performance?: GrowthPerformance;
}

export interface GrowthAnalysis {
  batchId: string;
  batchCode: string;
  speciesName: string;
  analysisDate: string;
  daysInProduction: number;
  currentMetrics: GrowthMetrics;
  trend: GrowthTrend;
  projection: GrowthProjection;
  recommendations: GrowthRecommendation[];
  measurementHistory: GrowthMeasurementSummary[];
}

export interface RecordGrowthSampleInput {
  batchId: string;
  tankId?: string;
  measurementDate: string;
  measurementType?: MeasurementType;
  measurementMethod?: MeasurementMethod;
  sampleSize: number;
  populationSize: number;
  individualMeasurements: IndividualMeasurement[];
  conditions?: MeasurementConditions;
  measuredBy: string;
  notes?: string;
  updateBatchWeight?: boolean;
}

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Tek bir buyume olcumunu getir
 */
export function useGrowthMeasurement(id: string) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'growth', 'detail', id),
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ growthMeasurement: GrowthMeasurement }>(
        GROWTH_MEASUREMENT_QUERY,
        { id }
      );
      return data.growthMeasurement;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId && !!id,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}

/**
 * Buyume olcumlerini filtreli listele
 */
export function useGrowthMeasurements(
  filter?: GrowthMeasurementFilter,
  pagination?: GrowthPagination,
  options?: { enabled?: boolean }
) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'growth', 'list', tenantId, filter, pagination),
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ growthMeasurements: GrowthMeasurementConnection }>(
        GROWTH_MEASUREMENTS_QUERY,
        { filter, pagination }
      );
      return data.growthMeasurements;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId && (options?.enabled !== false),
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}

/**
 * Batch icin buyume analizi getir
 * Metrikler, trendler, projeksiyonlar ve oneriler dahil
 */
export function useGrowthAnalysis(
  batchId: string,
  options?: { enabled?: boolean }
) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'growth', 'analysis', tenantId, batchId),
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ growthAnalysis: GrowthAnalysis }>(
        GROWTH_ANALYSIS_QUERY,
        { batchId }
      );
      return data.growthAnalysis;
    },
    staleTime: 60000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId && !!batchId && (options?.enabled !== false),
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}

/**
 * Batch icin son olcumu getir
 */
export function useLatestGrowthMeasurement(
  batchId: string,
  options?: { enabled?: boolean }
) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'growth', 'latest', tenantId, batchId),
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ latestGrowthMeasurement: GrowthMeasurement | null }>(
        LATEST_GROWTH_MEASUREMENT_QUERY,
        { batchId }
      );
      return data.latestGrowthMeasurement;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId && !!batchId && (options?.enabled !== false),
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}

/**
 * Batch buyume gecmisini getir
 */
export function useBatchGrowthHistory(
  batchId: string,
  limit?: number,
  options?: { enabled?: boolean }
) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'growth', 'history', tenantId, batchId, limit),
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');
      const data = await graphqlClient.request<{ batchGrowthHistory: GrowthMeasurement[] }>(
        BATCH_GROWTH_HISTORY_QUERY,
        { batchId, limit }
      );
      return data.batchGrowthHistory;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId && !!batchId && (options?.enabled !== false),
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
  });
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Yeni buyume ornekleme kaydi olustur
 */
export function useRecordGrowthSample() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordGrowthSampleInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ recordGrowthSample: GrowthMeasurement }>(
        RECORD_GROWTH_SAMPLE_MUTATION,
        { input }
      );
      return data.recordGrowthSample;
    },
    onSuccess: (_data, variables) => {
      // Invalidate all growth-related queries
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'growth') });
      // Also invalidate batch queries since growth affects batch weight
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
    },
  });
}

/**
 * Batch agirligini olcum sonucuyla guncelle
 */
export function useUpdateBatchWeightFromSample() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ batchId, measurementId }: { batchId: string; measurementId: string }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateBatchWeightFromSample: GrowthMeasurement }>(
        UPDATE_BATCH_WEIGHT_FROM_SAMPLE_MUTATION,
        { batchId, measurementId }
      );
      return data.updateBatchWeightFromSample;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'growth') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
    },
  });
}

/**
 * Olcumu dogrula
 */
export function useVerifyMeasurement() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ measurementId, notes }: { measurementId: string; notes?: string }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ verifyMeasurement: GrowthMeasurement }>(
        VERIFY_MEASUREMENT_MUTATION,
        { measurementId, notes }
      );
      return data.verifyMeasurement;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'growth') });
    },
  });
}
