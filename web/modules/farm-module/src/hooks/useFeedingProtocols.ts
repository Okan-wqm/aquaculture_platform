/**
 * Feeding Protocol hooks for farm-module
 *
 * Handles CRUD operations for feeding protocols via GraphQL API.
 * Protocols define species-specific feeding schedules based on
 * temperature ranges, weight ranges, and growth stages.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import {
  FEEDING_PROTOCOL_QUERY,
  FEEDING_PROTOCOLS_QUERY,
  FEEDING_PROTOCOLS_BY_SPECIES_QUERY,
  DEFAULT_FEEDING_PROTOCOL_QUERY,
  CREATE_FEEDING_PROTOCOL_MUTATION,
  UPDATE_FEEDING_PROTOCOL_MUTATION,
  DELETE_FEEDING_PROTOCOL_MUTATION,
  SET_DEFAULT_FEEDING_PROTOCOL_MUTATION,
} from '../graphql/feedingProtocol.operations';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Backend FeedType enum values (lowercase to match backend entity)
 */
export type FeedStage =
  | 'starter'
  | 'grower'
  | 'finisher'
  | 'broodstock'
  | 'medicated'
  | 'larval'
  | 'fry'
  | 'other';

export const FEED_STAGE_OPTIONS: { value: FeedStage; label: string }[] = [
  { value: 'starter', label: 'Starter' },
  { value: 'grower', label: 'Grower' },
  { value: 'finisher', label: 'Finisher' },
  { value: 'broodstock', label: 'Broodstock' },
  { value: 'medicated', label: 'Medicated' },
  { value: 'larval', label: 'Larval' },
  { value: 'fry', label: 'Fry' },
  { value: 'other', label: 'Other' },
];

export interface TemperatureRange {
  min: number;
  max: number;
  unit: string;
  feedingMultiplier: number;
}

export interface FeedingScheduleEntry {
  time: string;
  percentOfDaily: number;
  notes?: string;
}

export interface FeedingScheduleAdjustments {
  lowOxygenReduction?: number;
  postStressReduction?: number;
  preMedicationFasting?: number;
}

export interface FeedingSchedule {
  totalMealsPerDay: number;
  schedule: FeedingScheduleEntry[];
  adjustments?: FeedingScheduleAdjustments;
}

export interface GrowthStageProtocol {
  minWeight: number;
  maxWeight: number;
  weightUnit: string;
  feedPercent: number;
  schedule: FeedingSchedule;
  notes?: string;
}

export interface OptimalTemperature {
  min: number;
  max: number;
  unit: string;
}

export interface SpecialConditions {
  spawningPeriod?: string;
  winterFeeding?: string;
  diseaseOutbreak?: string;
  waterQualityIssues?: string;
}

export interface FeedingProtocol {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  feedId?: string;
  species: string;
  stage: FeedStage;
  temperatureRanges?: TemperatureRange[];
  growthStageProtocols?: GrowthStageProtocol[];
  defaultSchedule?: FeedingSchedule;
  targetFcr?: number;
  minDissolvedOxygen?: number;
  optimalTemperature?: OptimalTemperature;
  specialConditions?: SpecialConditions;
  notes?: string;
  isActive: boolean;
  isDefault: boolean;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreateFeedingProtocolInput {
  name: string;
  description?: string;
  feedId?: string;
  species: string;
  stage?: FeedStage;
  temperatureRanges?: Omit<TemperatureRange, 'unit'>[];
  growthStageProtocols?: GrowthStageProtocol[];
  defaultSchedule?: FeedingSchedule;
  targetFcr?: number;
  minDissolvedOxygen?: number;
  optimalTemperature?: OptimalTemperature;
  specialConditions?: SpecialConditions;
  notes?: string;
  isActive?: boolean;
  isDefault?: boolean;
}

export interface UpdateFeedingProtocolInput extends Partial<CreateFeedingProtocolInput> {
  id: string;
}

export interface FeedingProtocolFilter {
  species?: string;
  stage?: FeedStage;
  feedId?: string;
  isActive?: boolean;
  isDefault?: boolean;
  search?: string;
}

interface PaginatedProtocolsResponse {
  items: FeedingProtocol[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook to fetch paginated feeding protocols with filtering
 */
export function useFeedingProtocols(filter?: FeedingProtocolFilter) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feeding-protocols', 'list', filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{
        feedingProtocols: PaginatedProtocolsResponse;
      }>(FEEDING_PROTOCOLS_QUERY, { filter, pagination: { limit: 100 } });
      return data.feedingProtocols;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch a single feeding protocol by ID
 */
export function useFeedingProtocol(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feeding-protocols', 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{
        feedingProtocol: FeedingProtocol;
      }>(FEEDING_PROTOCOL_QUERY, { id });
      return data.feedingProtocol;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to fetch feeding protocols for a specific species
 */
export function useFeedingProtocolsBySpecies(species: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feeding-protocols', 'by-species', species),
    queryFn: async () => {
      const data = await graphqlClient.request<{
        feedingProtocolsBySpecies: FeedingProtocol[];
      }>(FEEDING_PROTOCOLS_BY_SPECIES_QUERY, { species });
      return data.feedingProtocolsBySpecies;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!species,
  });
}

/**
 * Hook to fetch the default feeding protocol for a species
 */
export function useDefaultFeedingProtocol(species: string, stage?: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feeding-protocols', 'default', species, stage),
    queryFn: async () => {
      const data = await graphqlClient.request<{
        defaultFeedingProtocol: FeedingProtocol | null;
      }>(DEFAULT_FEEDING_PROTOCOL_QUERY, { species, stage });
      return data.defaultFeedingProtocol;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!species,
  });
}

/**
 * Hook to create a feeding protocol
 */
export function useCreateFeedingProtocol() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateFeedingProtocolInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{
        createFeedingProtocol: FeedingProtocol;
      }>(CREATE_FEEDING_PROTOCOL_MUTATION, { input });
      return data.createFeedingProtocol;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols') });
    },
  });
}

/**
 * Hook to update a feeding protocol
 */
export function useUpdateFeedingProtocol() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateFeedingProtocolInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{
        updateFeedingProtocol: FeedingProtocol;
      }>(UPDATE_FEEDING_PROTOCOL_MUTATION, { input });
      return data.updateFeedingProtocol;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols', 'detail', variables.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols', 'by-species') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols', 'default') });
    },
  });
}

/**
 * Hook to delete (deactivate) a feeding protocol
 */
export function useDeleteFeedingProtocol() {
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
      const data = await graphqlClient.request<{
        deleteFeedingProtocol: boolean;
      }>(DELETE_FEEDING_PROTOCOL_MUTATION, { id });
      return data.deleteFeedingProtocol;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols') });
    },
  });
}

/**
 * Hook to set a protocol as default for its species/stage
 */
export function useSetDefaultFeedingProtocol() {
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
      const data = await graphqlClient.request<{
        setDefaultFeedingProtocol: FeedingProtocol;
      }>(SET_DEFAULT_FEEDING_PROTOCOL_MUTATION, { id });
      return data.setDefaultFeedingProtocol;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding-protocols') });
    },
  });
}

// ============================================================================
// HELPERS
// ============================================================================

export const feedStageLabels: Record<string, string> = {
  starter: 'Starter',
  grower: 'Grower',
  finisher: 'Finisher',
  broodstock: 'Broodstock',
  medicated: 'Medicated',
  larval: 'Larval',
  fry: 'Fry',
  other: 'Other',
  // Also handle uppercase from frontend FeedType enum
  STARTER: 'Starter',
  GROWER: 'Grower',
  FINISHER: 'Finisher',
  BROODSTOCK: 'Broodstock',
  MEDICATED: 'Medicated',
  LARVAL: 'Larval',
  FRY: 'Fry',
  OTHER: 'Other',
};

export const feedStageColors: Record<string, string> = {
  starter: 'bg-cyan-100 text-cyan-800',
  grower: 'bg-green-100 text-green-800',
  finisher: 'bg-blue-100 text-blue-800',
  broodstock: 'bg-purple-100 text-purple-800',
  medicated: 'bg-red-100 text-red-800',
  larval: 'bg-yellow-100 text-yellow-800',
  fry: 'bg-orange-100 text-orange-800',
  other: 'bg-gray-100 text-gray-800',
  STARTER: 'bg-cyan-100 text-cyan-800',
  GROWER: 'bg-green-100 text-green-800',
  FINISHER: 'bg-blue-100 text-blue-800',
  BROODSTOCK: 'bg-purple-100 text-purple-800',
  MEDICATED: 'bg-red-100 text-red-800',
  LARVAL: 'bg-yellow-100 text-yellow-800',
  FRY: 'bg-orange-100 text-orange-800',
  OTHER: 'bg-gray-100 text-gray-800',
};
