/**
 * Species hooks for farm-module
 * Handles CRUD operations for species via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Enums - Values must be UPPERCASE to match GraphQL enum keys
export enum SpeciesCategory {
  FISH = 'FISH',
  SHRIMP = 'SHRIMP',
  PRAWN = 'PRAWN',
  CRAB = 'CRAB',
  LOBSTER = 'LOBSTER',
  MOLLUSK = 'MOLLUSK',
  SEAWEED = 'SEAWEED',
  OTHER = 'OTHER',
}

export enum SpeciesWaterType {
  FRESHWATER = 'FRESHWATER',
  SALTWATER = 'SALTWATER',
  BRACKISH = 'BRACKISH',
}

export enum SpeciesStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  EXPERIMENTAL = 'EXPERIMENTAL',
  DISCONTINUED = 'DISCONTINUED',
}

// Optimal Conditions Types
export interface TemperatureRange {
  min: number;
  max: number;
  optimal?: number;
  unit: 'celsius' | 'fahrenheit';
  criticalMin?: number;
  criticalMax?: number;
}

export interface PHRange {
  min: number;
  max: number;
  optimal?: number;
}

export interface DissolvedOxygenRange {
  min: number;
  optimal: number;
  critical?: number;
  unit: 'mg/L' | 'ppm';
}

export interface SalinityRange {
  min: number;
  max: number;
  optimal?: number;
  unit: 'ppt' | 'psu';
}

export interface WaterParameterLimit {
  max: number;
  warning?: number;
}

export interface CO2Range {
  min: number;
  max: number;
  warning?: number;
}

export interface LightRegime {
  lightHours: number;
  darkHours: number;
  notes?: string;
}

export interface OptimalConditions {
  temperature?: TemperatureRange;
  ph?: PHRange;
  dissolvedOxygen?: DissolvedOxygenRange;
  salinity?: SalinityRange;
  ammonia?: WaterParameterLimit;
  nitrite?: WaterParameterLimit;
  nitrate?: WaterParameterLimit;
  co2?: CO2Range;
  lightRegime?: LightRegime;
}

export interface GrowthParameters {
  maxDensity: number;
  optimalDensity?: number;
  densityUnit: 'kg/m3' | 'pcs/m3';
  avgDailyGrowth: number;
  avgHarvestWeight: number;
  harvestWeightUnit: 'gram' | 'kg';
  avgTimeToHarvestDays: number;
  targetFCR: number;
  expectedSurvivalRate: number;
}

export interface SpeciesSupplierBasic {
  id: string;
  name: string;
  code?: string;
}

export interface FeedBasic {
  id: string;
  name: string;
  code: string;
  type?: string;
}

// Main Species type
export interface Species {
  id: string;
  tenantId: string;
  scientificName: string;
  commonName: string;
  localName?: string;
  code: string;
  description?: string;
  category: SpeciesCategory;
  waterType: SpeciesWaterType;
  family?: string;
  genus?: string;
  optimalConditions?: OptimalConditions;
  growthParameters?: GrowthParameters;
  status: SpeciesStatus;
  supplierId?: string;
  supplier?: SpeciesSupplierBasic;
  tags?: string[];
  imageUrl?: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSpeciesInput {
  scientificName: string;
  commonName: string;
  localName?: string;
  code: string;
  description?: string;
  category: SpeciesCategory;
  waterType: SpeciesWaterType;
  family?: string;
  genus?: string;
  optimalConditions?: OptimalConditions;
  growthParameters?: GrowthParameters;
  status?: SpeciesStatus;
  supplierId?: string;
  feedIds?: string[];
  tags?: string[];
  imageUrl?: string;
  notes?: string;
}

export interface UpdateSpeciesInput extends Partial<CreateSpeciesInput> {
  id: string;
}

interface PaginatedResponse {
  items: Species[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// GraphQL queries
const SPECIES_LIST_QUERY = `
  query SpeciesList($filter: SpeciesFilterInput) {
    speciesList(filter: $filter) {
      items {
        id
        tenantId
        scientificName
        commonName
        localName
        code
        description
        category
        waterType
        family
        genus
        optimalConditions
        growthParameters
        status
        supplierId
        tags
        imageUrl
        notes
        isActive
        createdAt
        updatedAt
      }
      total
      offset
      limit
      hasMore
    }
  }
`;

const SPECIES_QUERY = `
  query Species($id: ID!) {
    species(id: $id) {
      id
      tenantId
      scientificName
      commonName
      localName
      code
      description
      category
      waterType
      family
      genus
      optimalConditions
      growthParameters
      status
      supplierId
      tags
      imageUrl
      notes
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_SPECIES_MUTATION = `
  mutation CreateSpecies($input: CreateSpeciesInput!) {
    createSpecies(input: $input) {
      id
      scientificName
      commonName
      code
      category
      waterType
      status
      tags
      isActive
    }
  }
`;

const UPDATE_SPECIES_MUTATION = `
  mutation UpdateSpecies($input: UpdateSpeciesInput!) {
    updateSpecies(input: $input) {
      id
      scientificName
      commonName
      code
      category
      waterType
      status
      tags
      isActive
    }
  }
`;

const DELETE_SPECIES_MUTATION = `
  mutation DeleteSpecies($id: ID!) {
    deleteSpecies(id: $id) {
      success
      message
    }
  }
`;

const ACTIVE_SPECIES_QUERY = `
  query ActiveSpecies {
    activeSpecies {
      id
      scientificName
      commonName
      localName
      code
      category
      waterType
      status
      isActive
    }
  }
`;

/**
 * Hook to fetch species list
 */
export function useSpeciesList(filter?: {
  category?: SpeciesCategory;
  waterType?: SpeciesWaterType;
  status?: SpeciesStatus;
  isActive?: boolean;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['species', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ speciesList: PaginatedResponse }>(
        SPECIES_LIST_QUERY,
        { filter }
      );
      return data.speciesList;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to fetch single species
 */
export function useSpecies(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['species', 'detail', id],
    queryFn: async () => {
      const data = await graphqlClient.request<{ species: Species }>(
        SPECIES_QUERY,
        { id }
      );
      return data.species;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Hook to fetch active species (for dropdowns)
 */
export function useActiveSpecies() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['species', 'active'],
    queryFn: async () => {
      const data = await graphqlClient.request<{ activeSpecies: Species[] }>(
        ACTIVE_SPECIES_QUERY,
        {}
      );
      return data.activeSpecies;
    },
    staleTime: 60000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Hook to create species
 */
export function useCreateSpecies() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSpeciesInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createSpecies: Species }>(
        CREATE_SPECIES_MUTATION,
        { input }
      );
      return data.createSpecies;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['species', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['species', 'active'] });
    },
  });
}

/**
 * Hook to update species
 */
export function useUpdateSpecies() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateSpeciesInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateSpecies: Species }>(
        UPDATE_SPECIES_MUTATION,
        { input }
      );
      return data.updateSpecies;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['species', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['species', 'active'] });
      queryClient.invalidateQueries({ queryKey: ['species', 'detail', variables.id] });
    },
  });
}

/**
 * Hook to delete species
 */
export function useDeleteSpecies() {
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
      const data = await graphqlClient.request<{ deleteSpecies: { success: boolean; message?: string } }>(
        DELETE_SPECIES_MUTATION,
        { id }
      );
      return data.deleteSpecies;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['species', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['species', 'active'] });
    },
  });
}

// Helper functions for display
export const speciesCategoryLabels: Record<SpeciesCategory, string> = {
  [SpeciesCategory.FISH]: 'Fish',
  [SpeciesCategory.SHRIMP]: 'Shrimp',
  [SpeciesCategory.PRAWN]: 'Prawn',
  [SpeciesCategory.CRAB]: 'Crab',
  [SpeciesCategory.LOBSTER]: 'Lobster',
  [SpeciesCategory.MOLLUSK]: 'Mollusk',
  [SpeciesCategory.SEAWEED]: 'Seaweed',
  [SpeciesCategory.OTHER]: 'Other',
};

export const speciesWaterTypeLabels: Record<SpeciesWaterType, string> = {
  [SpeciesWaterType.FRESHWATER]: 'Freshwater',
  [SpeciesWaterType.SALTWATER]: 'Saltwater',
  [SpeciesWaterType.BRACKISH]: 'Brackish',
};

export const speciesStatusLabels: Record<SpeciesStatus, string> = {
  [SpeciesStatus.ACTIVE]: 'Active',
  [SpeciesStatus.INACTIVE]: 'Inactive',
  [SpeciesStatus.EXPERIMENTAL]: 'Experimental',
  [SpeciesStatus.DISCONTINUED]: 'Discontinued',
};

export const speciesStatusColors: Record<SpeciesStatus, string> = {
  [SpeciesStatus.ACTIVE]: 'bg-green-100 text-green-800',
  [SpeciesStatus.INACTIVE]: 'bg-gray-100 text-gray-800',
  [SpeciesStatus.EXPERIMENTAL]: 'bg-yellow-100 text-yellow-800',
  [SpeciesStatus.DISCONTINUED]: 'bg-red-100 text-red-800',
};

export const speciesCategoryColors: Record<SpeciesCategory, string> = {
  [SpeciesCategory.FISH]: 'bg-blue-100 text-blue-800',
  [SpeciesCategory.SHRIMP]: 'bg-orange-100 text-orange-800',
  [SpeciesCategory.PRAWN]: 'bg-pink-100 text-pink-800',
  [SpeciesCategory.CRAB]: 'bg-red-100 text-red-800',
  [SpeciesCategory.LOBSTER]: 'bg-purple-100 text-purple-800',
  [SpeciesCategory.MOLLUSK]: 'bg-teal-100 text-teal-800',
  [SpeciesCategory.SEAWEED]: 'bg-green-100 text-green-800',
  [SpeciesCategory.OTHER]: 'bg-gray-100 text-gray-800',
};

export const waterTypeColors: Record<SpeciesWaterType, string> = {
  [SpeciesWaterType.FRESHWATER]: 'bg-cyan-100 text-cyan-800',
  [SpeciesWaterType.SALTWATER]: 'bg-indigo-100 text-indigo-800',
  [SpeciesWaterType.BRACKISH]: 'bg-amber-100 text-amber-800',
};
