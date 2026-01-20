/**
 * Cleaner Fish hooks for farm-module
 * Handles CRUD operations for cleaner fish batches via GraphQL API
 *
 * Supports multiple cleaner fish species (Lumpfish, Wrasse, etc.) per tank
 * with individual tracking per batch/species.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

export type CleanerFishSourceType = 'farmed' | 'wild_caught';

export type CleanerFishRemovalReason = 'end_of_cycle' | 'harvest' | 'relocation' | 'other';

export type CleanerMortalityReason =
  | 'disease'
  | 'water_quality'
  | 'stress'
  | 'handling'
  | 'temperature'
  | 'oxygen'
  | 'unknown'
  | 'other';

export interface CleanerFishSpecies {
  id: string;
  scientificName: string;
  commonName: string;
  localName?: string;
  code: string;
  cleanerFishType?: string;
}

export interface CleanerFishBatch {
  id: string;
  batchNumber: string;
  name?: string;
  speciesId: string;
  initialQuantity: number;
  currentQuantity: number;
  totalMortality?: number;
  sourceType?: string;
  sourceLocation?: string;
  stockedAt: string;
  status: string;
  isActive: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Computed
  availableQuantity?: number;
  deployedQuantity?: number;
  weight?: {
    initial?: { avgWeight: number };
    actual?: { avgWeight: number };
  };
}

export interface CleanerFishDetail {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  sourceType: string;
  deployedAt: string;
}

export interface TankCleanerFishInfo {
  tankId: string;
  tankName: string;
  cleanerFishQuantity: number;
  cleanerFishBiomassKg: number;
  cleanerFishRatio: number;
  details: CleanerFishDetail[];
}

// Input Types
export interface CreateCleanerBatchInput {
  speciesId: string;
  initialQuantity: number;
  initialAvgWeightG: number;
  sourceType: CleanerFishSourceType;
  sourceLocation?: string;
  supplierId?: string;
  stockedAt: string;
  purchaseCost?: number;
  currency?: string;
  notes?: string;
}

export interface DeployCleanerFishInput {
  cleanerBatchId: string;
  targetTankId: string;
  quantity: number;
  avgWeightG?: number;
  deployedAt: string;
  notes?: string;
}

export interface TransferCleanerFishInput {
  cleanerBatchId: string;
  sourceTankId: string;
  destinationTankId: string;
  quantity: number;
  transferredAt: string;
  reason?: string;
  notes?: string;
}

export interface RecordCleanerMortalityInput {
  cleanerBatchId: string;
  tankId: string;
  quantity: number;
  reason: CleanerMortalityReason;
  detail?: string;
  observedAt: string;
  notes?: string;
}

export interface RemoveCleanerFishInput {
  cleanerBatchId: string;
  tankId: string;
  quantity: number;
  reason: CleanerFishRemovalReason;
  removedAt: string;
  avgWeightG?: number;
  notes?: string;
}

// ============================================================================
// GRAPHQL QUERIES
// ============================================================================

const CLEANER_FISH_SPECIES_QUERY = `
  query CleanerFishSpecies($tenantId: String!) {
    cleanerFishSpecies(tenantId: $tenantId) {
      id
      scientificName
      commonName
      localName
      code
      cleanerFishType
    }
  }
`;

const CLEANER_FISH_BATCHES_QUERY = `
  query CleanerFishBatches($tenantId: String!, $status: BatchStatus) {
    cleanerFishBatches(tenantId: $tenantId, status: $status) {
      id
      batchNumber
      name
      speciesId
      initialQuantity
      currentQuantity
      totalMortality
      stockedAt
      status
      isActive
      notes
      createdAt
      updatedAt
      weight
    }
  }
`;

const TANK_CLEANER_FISH_QUERY = `
  query TankCleanerFish($tenantId: String!, $tankId: ID!) {
    tankCleanerFish(tenantId: $tenantId, tankId: $tankId) {
      tankId
      tankName
      cleanerFishQuantity
      cleanerFishBiomassKg
      cleanerFishRatio
      details {
        batchId
        batchNumber
        speciesName
        quantity
        avgWeightG
        biomassKg
        sourceType
        deployedAt
      }
    }
  }
`;

// ============================================================================
// GRAPHQL MUTATIONS
// ============================================================================

const CREATE_CLEANER_BATCH_MUTATION = `
  mutation CreateCleanerFishBatch($tenantId: String!, $userId: String!, $input: CreateCleanerBatchInput!) {
    createCleanerFishBatch(tenantId: $tenantId, userId: $userId, input: $input) {
      id
      batchNumber
      speciesId
      initialQuantity
      currentQuantity
      status
      stockedAt
      createdAt
    }
  }
`;

const DEPLOY_CLEANER_FISH_MUTATION = `
  mutation DeployCleanerFish($tenantId: String!, $userId: String!, $input: DeployCleanerFishInput!) {
    deployCleanerFish(tenantId: $tenantId, userId: $userId, input: $input) {
      id
      batchNumber
      currentQuantity
    }
  }
`;

const TRANSFER_CLEANER_FISH_MUTATION = `
  mutation TransferCleanerFish($tenantId: String!, $userId: String!, $input: TransferCleanerFishInput!) {
    transferCleanerFish(tenantId: $tenantId, userId: $userId, input: $input) {
      id
      batchNumber
      currentQuantity
    }
  }
`;

const RECORD_CLEANER_MORTALITY_MUTATION = `
  mutation RecordCleanerMortality($tenantId: String!, $userId: String!, $input: RecordCleanerMortalityInput!) {
    recordCleanerMortality(tenantId: $tenantId, userId: $userId, input: $input) {
      id
      batchNumber
      currentQuantity
      totalMortality
    }
  }
`;

const REMOVE_CLEANER_FISH_MUTATION = `
  mutation RemoveCleanerFish($tenantId: String!, $userId: String!, $input: RemoveCleanerFishInput!) {
    removeCleanerFish(tenantId: $tenantId, userId: $userId, input: $input) {
      id
      batchNumber
      currentQuantity
    }
  }
`;

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Hook to fetch cleaner fish species (Lumpfish, Wrasse, etc.)
 */
export function useCleanerFishSpecies() {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: ['cleanerFish', 'species', tenantId],
    queryFn: async () => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      const data = await graphqlClient.request<{ cleanerFishSpecies: CleanerFishSpecies[] }>(
        CLEANER_FISH_SPECIES_QUERY,
        { tenantId }
      );
      return data.cleanerFishSpecies;
    },
    staleTime: 60000, // Species don't change often
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
  });
}

/**
 * Hook to fetch cleaner fish batches
 */
export function useCleanerFishBatches(status?: string) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: ['cleanerFish', 'batches', tenantId, status],
    queryFn: async () => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      const data = await graphqlClient.request<{ cleanerFishBatches: CleanerFishBatch[] }>(
        CLEANER_FISH_BATCHES_QUERY,
        { tenantId, status: status || null }
      );
      return data.cleanerFishBatches;
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
  });
}

/**
 * Hook to fetch cleaner fish info for a specific tank
 */
export function useTankCleanerFish(tankId: string) {
  const { token, tenantId, isAuthenticated, isLoading: authLoading } = useAuth();

  return useQuery({
    queryKey: ['cleanerFish', 'tank', tenantId, tankId],
    queryFn: async () => {
      if (!tenantId) {
        throw new Error('Tenant context required');
      }
      const data = await graphqlClient.request<{ tankCleanerFish: TankCleanerFishInfo | null }>(
        TANK_CLEANER_FISH_QUERY,
        { tenantId, tankId }
      );
      return data.tankCleanerFish;
    },
    staleTime: 30000,
    enabled: !authLoading && isAuthenticated && !!token && !!tenantId && !!tankId,
    retry: (failureCount, error) => {
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('unauthenticated') || message.includes('unauthorized') || message.includes('tenant')) {
          return false;
        }
      }
      return failureCount < 2;
    },
  });
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Hook to create a new cleaner fish batch
 */
export function useCreateCleanerBatch() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateCleanerBatchInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createCleanerFishBatch: CleanerFishBatch }>(
        CREATE_CLEANER_BATCH_MUTATION,
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.createCleanerFishBatch;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cleanerFish', 'batches'] });
    },
  });
}

/**
 * Hook to deploy cleaner fish to a tank
 */
export function useDeployCleanerFish() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DeployCleanerFishInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ deployCleanerFish: CleanerFishBatch }>(
        DEPLOY_CLEANER_FISH_MUTATION,
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.deployCleanerFish;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cleanerFish'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
    },
  });
}

/**
 * Hook to transfer cleaner fish between tanks
 */
export function useTransferCleanerFish() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: TransferCleanerFishInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ transferCleanerFish: CleanerFishBatch }>(
        TRANSFER_CLEANER_FISH_MUTATION,
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.transferCleanerFish;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cleanerFish'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
    },
  });
}

/**
 * Hook to record cleaner fish mortality
 */
export function useRecordCleanerMortality() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordCleanerMortalityInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ recordCleanerMortality: CleanerFishBatch }>(
        RECORD_CLEANER_MORTALITY_MUTATION,
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.recordCleanerMortality;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cleanerFish'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
    },
  });
}

/**
 * Hook to remove cleaner fish from a tank
 * (for harvest, end of cycle, relocation, etc. - NOT mortality)
 */
export function useRemoveCleanerFish() {
  const { token, tenantId, user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RemoveCleanerFishInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ removeCleanerFish: CleanerFishBatch }>(
        REMOVE_CLEANER_FISH_MUTATION,
        {
          tenantId,
          userId: user?.id || 'unknown',
          input,
        }
      );
      return data.removeCleanerFish;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cleanerFish'] });
      queryClient.invalidateQueries({ queryKey: ['tankBatches'] });
      queryClient.invalidateQueries({ queryKey: ['tanks'] });
    },
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate cleaner fish to production ratio
 */
export function calculateCleanerRatio(
  cleanerFishCount: number,
  productionFishCount: number
): number {
  if (productionFishCount === 0) return 0;
  return (cleanerFishCount / productionFishCount) * 100;
}

/**
 * Get recommended cleaner fish count based on production fish count
 * Typical recommendation is 2-5% of production fish
 */
export function getRecommendedCleanerCount(
  productionFishCount: number,
  targetPercentage: number = 3
): { min: number; max: number; recommended: number } {
  return {
    min: Math.ceil(productionFishCount * 0.02),
    max: Math.ceil(productionFishCount * 0.05),
    recommended: Math.ceil(productionFishCount * (targetPercentage / 100)),
  };
}

/**
 * Get mortality reason display text
 */
export function getMortalityReasonLabel(reason: CleanerMortalityReason): string {
  const labels: Record<CleanerMortalityReason, string> = {
    disease: 'Disease',
    water_quality: 'Water Quality',
    stress: 'Stress',
    handling: 'Handling',
    temperature: 'Temperature',
    oxygen: 'Oxygen',
    unknown: 'Unknown',
    other: 'Other',
  };
  return labels[reason] || reason;
}

/**
 * Get removal reason display text
 */
export function getRemovalReasonLabel(reason: CleanerFishRemovalReason): string {
  const labels: Record<CleanerFishRemovalReason, string> = {
    end_of_cycle: 'End of Cycle',
    harvest: 'Harvest',
    relocation: 'Relocation',
    other: 'Other',
  };
  return labels[reason] || reason;
}
