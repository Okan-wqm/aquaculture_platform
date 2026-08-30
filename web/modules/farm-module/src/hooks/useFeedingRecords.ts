/**
 * Feeding Records & Inventory hooks for farm-module
 *
 * Handles CRUD operations for feeding records and feed inventory
 * management via GraphQL API.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import {
  FEEDING_RECORD_QUERY,
  FEEDING_RECORDS_QUERY,
  DAILY_FEEDING_PLAN_QUERY,
  FEEDING_SUMMARY_QUERY,
  CREATE_FEEDING_RECORD_MUTATION,
  UPDATE_FEEDING_RECORD_MUTATION,
} from '../graphql/feeding.operations';

// ============================================================================
// TYPES
// ============================================================================

/**
 * GraphQL enum values — must match the registered enum KEYS (uppercase),
 * not the DB string values (lowercase). GraphQL enums are always referenced
 * by their key in queries and variables.
 */
export type FeedingMethod = 'MANUAL' | 'AUTOMATIC' | 'DEMAND' | 'BROADCAST' | 'SPOT';

export type FishAppetite = 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'POOR' | 'NONE';

export type InventoryStatus = 'AVAILABLE' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'EXPIRED' | 'QUARANTINE';

export type ConsumptionReason = 'FEEDING' | 'WASTE' | 'ADJUSTMENT' | 'EXPIRED' | 'TRANSFER';

export type AdjustmentType = 'INCREASE' | 'DECREASE' | 'SET_QUANTITY';

export interface FeedingEnvironment {
  waterTemp?: number;
  dissolvedOxygen?: number;
  weather?: string;
  windLevel?: string;
  visibility?: string;
}

export interface FishBehavior {
  appetite: FishAppetite;
  feedingIntensity: number;
  surfaceActivity?: string;
  schoolingBehavior?: string;
  abnormalBehavior?: string;
}

export interface FeedingRecord {
  id: string;
  tenantId: string;
  batchId: string;
  tankId?: string;
  feedingDate: string;
  feedingTime: string;
  feedingSequence: number;
  totalMealsToday: number;
  feedId: string;
  feedBatchNumber?: string;
  plannedAmount: number;
  actualAmount: number;
  variance: number;
  variancePercent: number;
  wasteAmount?: number;
  environment?: FeedingEnvironment;
  fishBehavior?: FishBehavior;
  feedingMethod: FeedingMethod;
  equipmentId?: string;
  feedingDurationMinutes?: number;
  /** @deprecated Float — use `feedCostDecimal` (exact decimal string, ADR-0004). */
  feedCost?: number;
  feedCostDecimal?: string | null;
  currency?: string;
  fedBy: string;
  verifiedBy?: string;
  verifiedAt?: string;
  notes?: string;
  skipReason?: string;
  createdAt: string;
  updatedAt: string;
  isBelowPlan: boolean;
  isVarianceAcceptable: boolean;
}


export interface PlannedFeeding {
  batchId: string;
  batchCode: string;
  tankId?: string;
  tankCode?: string;
  feedId: string;
  feedName: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  mealsPlanned: number;
  mealsCompleted: number;
  isComplete: boolean;
}

export interface DailyFeedingPlanResponse {
  date: string;
  siteId: string;
  plannedFeedings: PlannedFeeding[];
  totalPlannedKg: number;
  totalActualKg: number;
  completionPercent: number;
}

export interface FeedTypeSummary {
  feedId: string;
  feedName: string;
  totalKg: number;
  percentage: number;
  cost: number;
}

export interface FeedingSummaryResponse {
  batchId?: string;
  siteId?: string;
  startDate: string;
  endDate: string;
  totalFeedGivenKg: number;
  totalPlannedKg: number;
  varianceKg: number;
  variancePercent: number;
  totalFeedings: number;
  avgFeedingKg: number;
  /** @deprecated Float — use `totalCostDecimal` (exact decimal string, ADR-0004). */
  totalCost: number;
  totalCostDecimal: string;
  currency?: string;
  byFeedType: FeedTypeSummary[];
}

export interface FeedingRecordConnection {
  items: FeedingRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}


// Input types
export interface FeedingRecordFilterInput {
  batchId?: string;
  tankId?: string;
  feedId?: string;
  startDate?: string;
  endDate?: string;
  feedingMethod?: FeedingMethod;
}



export interface CreateFeedingRecordInput {
  batchId: string;
  tankId?: string;
  feedingDate: string;
  feedingTime: string;
  feedingSequence?: number;
  totalMealsToday?: number;
  feedId: string;
  feedBatchNumber?: string;
  plannedAmount: number;
  actualAmount: number;
  wasteAmount?: number;
  environment?: FeedingEnvironment;
  fishBehavior?: FishBehavior;
  feedingMethod?: FeedingMethod;
  equipmentId?: string;
  feedingDurationMinutes?: number;
  feedCost?: number;
  currency?: string;
  fedBy: string;
  notes?: string;
  skipReason?: string;
}

export interface UpdateFeedingRecordInput {
  actualAmount?: number;
  wasteAmount?: number;
  environment?: FeedingEnvironment;
  fishBehavior?: FishBehavior;
  notes?: string;
  verifiedBy?: string;
}




// ============================================================================
// FEEDING RECORD HOOKS
// ============================================================================

/**
 * Hook to fetch a single feeding record by ID
 */
export function useFeedingRecord(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingRecords', 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ feedingRecord: FeedingRecord }>(
        FEEDING_RECORD_QUERY,
        { id }
      );
      return data.feedingRecord;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to fetch feeding records list with filters
 */
export function useFeedingRecordsList(
  filter?: FeedingRecordFilterInput,
  pagination?: { page?: number; limit?: number },
) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingRecords', 'list', tenantId, filter, pagination),
    queryFn: async () => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      const data = await graphqlClient.request<{ feedingRecords: FeedingRecordConnection }>(
        FEEDING_RECORDS_QUERY,
        {
          filter,
          pagination: {
            page: pagination?.page ?? 1,
            limit: pagination?.limit ?? 20,
          },
        }
      );
      return data.feedingRecords;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId,
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
 * Normalize a date string to a full ISO-8601 datetime so it satisfies the
 * GraphQL `DateTime` scalar.  Date-only strings such as "2026-04-01" are
 * converted to "2026-04-01T00:00:00.000Z"; values that already contain a
 * time component are returned unchanged.
 */
function toISODateTime(value?: string): string | undefined {
  if (!value) return undefined;
  // Already contains a time portion — return as-is
  if (value.includes('T')) return value;
  return `${value}T00:00:00.000Z`;
}

/**
 * Hook to fetch daily feeding plan for a site.
 *
 * The `date` parameter is a date string (e.g. "2026-04-01") which is
 * normalised to a full ISO-8601 datetime before being sent as the
 * GraphQL `DateTime` variable.
 */
export function useDailyFeedingPlan(
  siteId: string,
  date?: string,
  options?: { enabled?: boolean },
) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingRecords', 'dailyPlan', tenantId, siteId, date),
    queryFn: async () => {
      const data = await graphqlClient.request<{ dailyFeedingPlan: DailyFeedingPlanResponse }>(
        DAILY_FEEDING_PLAN_QUERY,
        { siteId, date: toISODateTime(date) }
      );
      return data.dailyFeedingPlan;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!siteId && (options?.enabled !== false),
  });
}

/**
 * Hook to fetch feeding summary/statistics
 */
export function useFeedingSummary(
  entityType: 'batch' | 'tank',
  entityId: string,
  startDate?: string,
  endDate?: string,
  options?: { enabled?: boolean },
) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feedingRecords', 'summary', tenantId, entityType, entityId, startDate, endDate),
    queryFn: async () => {
      const data = await graphqlClient.request<{ feedingSummary: FeedingSummaryResponse }>(
        FEEDING_SUMMARY_QUERY,
        { entityType, entityId, startDate, endDate }
      );
      return data.feedingSummary;
    },
    staleTime: 60000,
    enabled: !!token && !!tenantId && !!entityId && (options?.enabled !== false),
  });
}

/**
 * Hook to create a new feeding record
 */
export function useCreateFeedingRecord() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateFeedingRecordInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createFeedingRecord: FeedingRecord }>(
        CREATE_FEEDING_RECORD_MUTATION,
        { input }
      );
      return data.createFeedingRecord;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feedingRecords') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding') });
    },
  });
}

/**
 * Hook to update a feeding record
 */
export function useUpdateFeedingRecord() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateFeedingRecordInput }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateFeedingRecord: FeedingRecord }>(
        UPDATE_FEEDING_RECORD_MUTATION,
        { id, input }
      );
      return data.updateFeedingRecord;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feedingRecords') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding') });
    },
  });
}

// ============================================================================
// FEED INVENTORY HOOKS
// ============================================================================

