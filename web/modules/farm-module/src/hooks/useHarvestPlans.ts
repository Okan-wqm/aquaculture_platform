/**
 * Harvest Plan hooks for farm-module
 * Handles queries and mutations for harvest plan management via GraphQL API.
 *
 * Follows the same patterns as useBatches.ts and useEquipment.ts:
 * - useAuth() for token/tenantId
 * - graphqlClient.request() for GraphQL calls
 * - React Query for caching and invalidation
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import {
  HARVEST_PLANS_QUERY,
  HARVEST_PLAN_QUERY,
  HARVEST_PLAN_BY_CODE_QUERY,
  HARVEST_PLANS_BY_BATCH_QUERY,
  UPCOMING_HARVEST_PLANS_QUERY,
  OVERDUE_HARVEST_PLANS_QUERY,
  HARVEST_PLAN_STATS_QUERY,
  CREATE_HARVEST_PLAN_MUTATION,
  UPDATE_HARVEST_PLAN_MUTATION,
  DELETE_HARVEST_PLAN_MUTATION,
  APPROVE_HARVEST_PLAN_MUTATION,
  SCHEDULE_HARVEST_PLAN_MUTATION,
  START_HARVEST_PLAN_MUTATION,
  COMPLETE_HARVEST_PLAN_MUTATION,
  CANCEL_HARVEST_PLAN_MUTATION,
  POSTPONE_HARVEST_PLAN_MUTATION,
} from '../graphql/harvestPlan.operations';

// ============================================================================
// TYPES
// ============================================================================

export interface HarvestPlan {
  id: string;
  tenantId: string;
  planCode: string;
  name: string;
  description?: string;
  batchId: string;
  batchNumber?: string;
  status: HarvestPlanStatus;
  harvestType: HarvestType;
  plannedDate: string;
  confirmedDate?: string;
  windowStartDate?: string;
  windowEndDate?: string;
  criteria: HarvestCriteria;
  harvestMethod?: HarvestMethod;
  productForm: ProductForm;
  estimates: HarvestEstimates;
  financialProjection?: FinancialProjection;
  logistics?: LogisticsPlan;
  customerOrder?: CustomerOrder;
  qualityRequirements?: QualityRequirements;
  actualQuantityHarvested?: number;
  actualBiomassHarvested?: number;
  actualAvgWeight?: number;
  approvedBy?: string;
  approvedAt?: string;
  createdBy: string;
  notes?: string;
  attachments?: string[];
  createdAt: string;
  updatedAt: string;
  // Computed fields from resolver
  daysUntilHarvest?: number;
  isWithinWindow?: boolean;
  isHarvestAllowed?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canApprove?: boolean;
  canSchedule?: boolean;
  canStartHarvest?: boolean;
  canComplete?: boolean;
  isOverdue?: boolean;
  estimatedRevenue?: number;
  estimatedProfit?: number;
  customerName?: string;
}

export type HarvestPlanStatus =
  | 'draft'
  | 'planned'
  | 'approved'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'postponed';

export type HarvestType = 'full' | 'partial' | 'selective' | 'emergency' | 'thinning';

export type HarvestMethod = 'net' | 'pump' | 'drain' | 'manual' | 'crowder';

export type ProductForm =
  | 'live'
  | 'fresh_whole'
  | 'fresh_gutted'
  | 'frozen_whole'
  | 'frozen_gutted'
  | 'fillet'
  | 'processed';

export interface HarvestCriteria {
  targetWeight: {
    min: number;
    max: number;
    target: number;
  };
  targetQuantity?: {
    value: number;
    unit: 'pieces' | 'kg' | 'percent';
  };
  qualityGrade?: string;
  minimumConditionFactor?: number;
}

export interface HarvestEstimates {
  estimatedQuantity: number;
  estimatedBiomass: number;
  estimatedAvgWeight: number;
  estimatedYield: number;
  confidenceLevel: 'low' | 'medium' | 'high';
  basedOnMeasurementDate?: string;
}

export interface FinancialProjection {
  estimatedRevenue: number;
  estimatedPrice: number;
  priceUnit: 'per_kg' | 'per_piece';
  estimatedCost: number;
  estimatedProfit: number;
  margin: number;
  currency: string;
}

export interface LogisticsPlan {
  harvestStartTime?: string;
  expectedDuration?: number;
  requiredEquipment?: string[];
  requiredPersonnel?: number;
  transportType?: 'truck' | 'boat' | 'container';
  transportCapacity?: number;
  destinationType?: 'processing' | 'market' | 'direct_sale' | 'export';
  destinationAddress?: string;
  coldChainRequired?: boolean;
}

export interface CustomerOrder {
  customerId?: string;
  customerName?: string;
  orderId?: string;
  orderQuantity?: number;
  orderUnit?: string;
  deliveryDate?: string;
  contractPrice?: number;
}

export interface QualityRequirements {
  certifications?: string[];
  sizeGrading?: boolean;
  qualityInspection?: boolean;
  traceabilityRequired?: boolean;
  specificRequirements?: string[];
}

export interface HarvestPlanStats {
  total: number;
  draft: number;
  planned: number;
  approved: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  postponed: number;
  totalEstimatedBiomass: number;
  totalActualBiomass: number;
  upcomingCount: number;
  overdueCount: number;
}

interface PaginatedHarvestPlans {
  items: HarvestPlan[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// ============================================================================
// INPUT TYPES
// ============================================================================

export interface CreateHarvestPlanInput {
  name: string;
  description?: string;
  batchId: string;
  status?: HarvestPlanStatus;
  harvestType?: HarvestType;
  plannedDate: string;
  confirmedDate?: string;
  windowStartDate?: string;
  windowEndDate?: string;
  criteria: {
    targetWeightMin: number;
    targetWeightMax: number;
    targetWeightTarget: number;
    targetQuantityValue?: number;
    targetQuantityUnit?: 'pieces' | 'kg' | 'percent';
    qualityGrade?: string;
    minimumConditionFactor?: number;
  };
  harvestMethod?: HarvestMethod;
  productForm?: ProductForm;
  estimates: {
    estimatedQuantity: number;
    estimatedBiomass: number;
    estimatedAvgWeight: number;
    estimatedYield: number;
    confidenceLevel: 'low' | 'medium' | 'high';
    basedOnMeasurementDate?: string;
  };
  financialProjection?: {
    estimatedRevenue: number;
    estimatedPrice: number;
    priceUnit: 'per_kg' | 'per_piece';
    estimatedCost: number;
    estimatedProfit: number;
    margin: number;
    currency: string;
  };
  logistics?: {
    harvestStartTime?: string;
    expectedDuration?: number;
    requiredEquipment?: string[];
    requiredPersonnel?: number;
    transportType?: 'truck' | 'boat' | 'container';
    transportCapacity?: number;
    destinationType?: 'processing' | 'market' | 'direct_sale' | 'export';
    destinationAddress?: string;
    coldChainRequired?: boolean;
  };
  customerOrder?: {
    customerId?: string;
    customerName?: string;
    orderId?: string;
    orderQuantity?: number;
    orderUnit?: string;
    deliveryDate?: string;
    contractPrice?: number;
  };
  qualityRequirements?: {
    certifications?: string[];
    sizeGrading?: boolean;
    qualityInspection?: boolean;
    traceabilityRequired?: boolean;
    specificRequirements?: string[];
  };
  notes?: string;
  attachments?: string[];
}

export interface UpdateHarvestPlanInput {
  id: string;
  name?: string;
  description?: string;
  status?: HarvestPlanStatus;
  harvestType?: HarvestType;
  plannedDate?: string;
  confirmedDate?: string;
  windowStartDate?: string;
  windowEndDate?: string;
  criteria?: {
    targetWeightMin: number;
    targetWeightMax: number;
    targetWeightTarget: number;
    targetQuantityValue?: number;
    targetQuantityUnit?: 'pieces' | 'kg' | 'percent';
    qualityGrade?: string;
    minimumConditionFactor?: number;
  };
  harvestMethod?: HarvestMethod;
  productForm?: ProductForm;
  estimates?: {
    estimatedQuantity: number;
    estimatedBiomass: number;
    estimatedAvgWeight: number;
    estimatedYield: number;
    confidenceLevel: 'low' | 'medium' | 'high';
    basedOnMeasurementDate?: string;
  };
  financialProjection?: {
    estimatedRevenue: number;
    estimatedPrice: number;
    priceUnit: 'per_kg' | 'per_piece';
    estimatedCost: number;
    estimatedProfit: number;
    margin: number;
    currency: string;
  };
  logistics?: {
    harvestStartTime?: string;
    expectedDuration?: number;
    requiredEquipment?: string[];
    requiredPersonnel?: number;
    transportType?: 'truck' | 'boat' | 'container';
    transportCapacity?: number;
    destinationType?: 'processing' | 'market' | 'direct_sale' | 'export';
    destinationAddress?: string;
    coldChainRequired?: boolean;
  };
  customerOrder?: {
    customerId?: string;
    customerName?: string;
    orderId?: string;
    orderQuantity?: number;
    orderUnit?: string;
    deliveryDate?: string;
    contractPrice?: number;
  };
  qualityRequirements?: {
    certifications?: string[];
    sizeGrading?: boolean;
    qualityInspection?: boolean;
    traceabilityRequired?: boolean;
    specificRequirements?: string[];
  };
  actualQuantityHarvested?: number;
  actualBiomassHarvested?: number;
  actualAvgWeight?: number;
  notes?: string;
  attachments?: string[];
}

export interface HarvestPlanFilterInput {
  batchId?: string;
  batchIds?: string[];
  status?: HarvestPlanStatus;
  statuses?: HarvestPlanStatus[];
  harvestType?: HarvestType;
  harvestTypes?: HarvestType[];
  harvestMethod?: HarvestMethod;
  productForm?: ProductForm;
  plannedDateFrom?: string;
  plannedDateTo?: string;
  confirmedDateFrom?: string;
  confirmedDateTo?: string;
  createdFrom?: string;
  createdTo?: string;
  createdBy?: string;
  approvedBy?: string;
  customerId?: string;
  orderId?: string;
  searchText?: string;
  hasConfirmedDate?: boolean;
  approvedOnly?: boolean;
  activeOnly?: boolean;
  overdueOnly?: boolean;
  upcomingDays?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDirection?: 'ASC' | 'DESC';
}

// ============================================================================
// QUERY KEY FACTORY
// ============================================================================

const HARVEST_PLANS_KEY = 'harvestPlans';

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Hook to fetch harvest plans list with filtering and pagination
 */
export function useHarvestPlanList(filter?: HarvestPlanFilterInput) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HARVEST_PLANS_KEY, 'list', tenantId, filter),
    queryFn: async () => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }

      const data = await graphqlClient.request<{ harvestPlans: PaginatedHarvestPlans }>(
        HARVEST_PLANS_QUERY,
        { filter }
      );
      return data.harvestPlans;
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
 * Hook to fetch a single harvest plan by ID
 */
export function useHarvestPlan(id: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HARVEST_PLANS_KEY, 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ harvestPlan: HarvestPlan }>(
        HARVEST_PLAN_QUERY,
        { id }
      );
      return data.harvestPlan;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to fetch a harvest plan by plan code
 */
export function useHarvestPlanByCode(planCode: string | null) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HARVEST_PLANS_KEY, 'byCode', planCode),
    queryFn: async () => {
      const data = await graphqlClient.request<{ harvestPlanByCode: HarvestPlan }>(
        HARVEST_PLAN_BY_CODE_QUERY,
        { planCode }
      );
      return data.harvestPlanByCode;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!planCode,
  });
}

/**
 * Hook to fetch harvest plans for a specific batch
 */
export function useHarvestPlansByBatch(batchId: string | null, activeOnly = false) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HARVEST_PLANS_KEY, 'byBatch', batchId, activeOnly),
    queryFn: async () => {
      const data = await graphqlClient.request<{ harvestPlansByBatch: HarvestPlan[] }>(
        HARVEST_PLANS_BY_BATCH_QUERY,
        { batchId, activeOnly }
      );
      return data.harvestPlansByBatch;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!batchId,
  });
}

/**
 * Hook to fetch upcoming harvest plans
 */
export function useUpcomingHarvestPlans(days = 30) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HARVEST_PLANS_KEY, 'upcoming', days),
    queryFn: async () => {
      const data = await graphqlClient.request<{ upcomingHarvestPlans: HarvestPlan[] }>(
        UPCOMING_HARVEST_PLANS_QUERY,
        { days }
      );
      return data.upcomingHarvestPlans;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch overdue harvest plans
 */
export function useOverdueHarvestPlans() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HARVEST_PLANS_KEY, 'overdue'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ overdueHarvestPlans: HarvestPlan[] }>(
        OVERDUE_HARVEST_PLANS_QUERY
      );
      return data.overdueHarvestPlans;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch harvest plan statistics
 */
export function useHarvestPlanStats() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, HARVEST_PLANS_KEY, 'stats'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ harvestPlanStats: HarvestPlanStats }>(
        HARVEST_PLAN_STATS_QUERY
      );
      return data.harvestPlanStats;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

// ============================================================================
// HELPER: Invalidate all harvest plan queries
// ============================================================================

function invalidateAllHarvestPlanQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  tenantId: string | null,
) {
  queryClient.invalidateQueries({
    predicate: (query) =>
      Array.isArray(query.queryKey) && query.queryKey[0] === HARVEST_PLANS_KEY,
  });
  // Also invalidate batches since harvest operations can affect batch state
  queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'batches') });
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Hook to create a new harvest plan
 */
export function useCreateHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateHarvestPlanInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createHarvestPlan: HarvestPlan }>(
        CREATE_HARVEST_PLAN_MUTATION,
        { input }
      );
      return data.createHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to update an existing harvest plan
 */
export function useUpdateHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateHarvestPlanInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateHarvestPlan: HarvestPlan }>(
        UPDATE_HARVEST_PLAN_MUTATION,
        { input }
      );
      return data.updateHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to delete a harvest plan (only draft plans)
 */
export function useDeleteHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ deleteHarvestPlan: boolean }>(
        DELETE_HARVEST_PLAN_MUTATION,
        { id }
      );
      return data.deleteHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to approve a harvest plan
 */
export function useApproveHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ approveHarvestPlan: HarvestPlan }>(
        APPROVE_HARVEST_PLAN_MUTATION,
        { id }
      );
      return data.approveHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to schedule a harvest plan with a confirmed date
 */
export function useScheduleHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, confirmedDate }: { id: string; confirmedDate: string }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ scheduleHarvestPlan: HarvestPlan }>(
        SCHEDULE_HARVEST_PLAN_MUTATION,
        { id, confirmedDate }
      );
      return data.scheduleHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to start harvest for a plan
 */
export function useStartHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ startHarvestPlan: HarvestPlan }>(
        START_HARVEST_PLAN_MUTATION,
        { id }
      );
      return data.startHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to complete harvest for a plan with actual results
 */
export function useCompleteHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      actualQuantity,
      actualBiomass,
      actualAvgWeight,
    }: {
      id: string;
      actualQuantity: number;
      actualBiomass: number;
      actualAvgWeight: number;
    }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ completeHarvestPlan: HarvestPlan }>(
        COMPLETE_HARVEST_PLAN_MUTATION,
        { id, actualQuantity, actualBiomass, actualAvgWeight }
      );
      return data.completeHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to cancel a harvest plan
 */
export function useCancelHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ cancelHarvestPlan: HarvestPlan }>(
        CANCEL_HARVEST_PLAN_MUTATION,
        { id }
      );
      return data.cancelHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}

/**
 * Hook to postpone a harvest plan to a new date
 */
export function usePostponeHarvestPlan() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, newDate }: { id: string; newDate: string }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ postponeHarvestPlan: HarvestPlan }>(
        POSTPONE_HARVEST_PLAN_MUTATION,
        { id, newDate }
      );
      return data.postponeHarvestPlan;
    },
    onSuccess: () => {
      invalidateAllHarvestPlanQueries(queryClient, tenantId);
    },
  });
}
