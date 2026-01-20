/**
 * Tank hooks for farm-module
 * Fetches equipment (tanks, ponds, cages) with their batch metrics from Equipment GraphQL endpoint
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// Types
export interface CleanerFishDetail {
  batchId: string;
  batchNumber: string;
  speciesId: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  sourceType: 'farmed' | 'wild_caught';
  deployedAt: string;
  // Mortality tracking fields
  initialQuantity?: number;      // İlk yerleştirilen miktar
  totalMortality?: number;       // Toplam mortality
  mortalityRate?: number;        // Mortality oranı (%)
  lastMortalityAt?: string;      // Son mortality tarihi
}

export interface TankBatchMetrics {
  batchNumber?: string;
  batchId?: string;
  pieces?: number;
  avgWeight?: number;
  biomass?: number;
  density?: number;
  capacityUsedPercent?: number;
  isOverCapacity?: boolean;
  isMixedBatch?: boolean;
  lastFeedingAt?: string;
  lastSamplingAt?: string;
  lastMortalityAt?: string;
  daysSinceStocking?: number;
  // Mortality & Performance metrics
  initialQuantity?: number;
  totalMortality?: number;
  mortalityRate?: number;
  survivalRate?: number;
  totalCull?: number;
  fcr?: number;
  sgr?: number;
  // Cleaner Fish metrics
  cleanerFishQuantity?: number;
  cleanerFishBiomassKg?: number;
  cleanerFishDetails?: CleanerFishDetail[];
}

export interface EquipmentType {
  id: string;
  name: string;
  code: string;
  category: string;
  icon?: string;
}

export interface Tank {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  description?: string;
  departmentId?: string;
  department?: {
    id: string;
    name: string;
    siteId?: string;
    site?: {
      id: string;
      name: string;
    };
  };
  equipmentTypeId: string;
  equipmentType?: EquipmentType;
  // Tank specifications (from specifications JSON)
  volume?: number;
  specifications?: {
    tankType?: string;
    material?: string;
    waterType?: string;
    waterVolume?: number;
    effectiveVolume?: number;
    maxBiomass?: number;
    maxDensity?: number;
    [key: string]: unknown;
  };
  // Denormalized fields
  isTank?: boolean;
  currentBiomass?: number;
  currentCount?: number;
  status: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // Batch metrics from TankBatch entity
  batchMetrics?: TankBatchMetrics;
}

export interface TankFilterInput {
  departmentId?: string;
  siteId?: string;
  equipmentTypeId?: string;
  categories?: string[];
  status?: string;
  isActive?: boolean;
  isTank?: boolean;
  search?: string;
}

export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

interface TanksResponse {
  items: Tank[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// GraphQL query for equipment (tanks, ponds, cages) with batch metrics
const EQUIPMENT_WITH_BATCHES_QUERY = `
  query EquipmentWithBatches($filter: EquipmentFilterInput, $pagination: PaginationInput) {
    equipmentList(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        name
        code
        description
        departmentId
        department {
          id
          name
          siteId
          site {
            id
            name
          }
        }
        equipmentTypeId
        equipmentType {
          id
          name
          code
          category
          icon
        }
        specifications
        volume
        isTank
        currentBiomass
        currentCount
        status
        isActive
        createdAt
        updatedAt
        batchMetrics {
          batchNumber
          batchId
          pieces
          avgWeight
          biomass
          density
          capacityUsedPercent
          isOverCapacity
          isMixedBatch
          lastFeedingAt
          lastSamplingAt
          lastMortalityAt
          daysSinceStocking
          initialQuantity
          totalMortality
          mortalityRate
          survivalRate
          totalCull
          fcr
          sgr
          cleanerFishQuantity
          cleanerFishBiomassKg
          cleanerFishDetails
        }
      }
      total
      page
      limit
      totalPages
    }
  }
`;

/**
 * Hook to fetch tanks/ponds/cages with batch metrics
 * Uses Equipment entity with categories filter
 */
export function useTanksList(filter?: TankFilterInput, pagination?: PaginationInput) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: ['tanks', 'list', filter, pagination],
    queryFn: async () => {
      const data = await graphqlClient.request<{ equipmentList: TanksResponse }>(
        EQUIPMENT_WITH_BATCHES_QUERY,
        {
          filter: {
            ...filter,
            // Default to TANK, POND, CAGE categories if not specified (uppercase enum values)
            categories: filter?.categories || ['TANK', 'POND', 'CAGE'],
            isActive: filter?.isActive ?? true,
          },
          // Note: PaginationInput only supports 'page' in merged gateway schema
          // Backend defaults to 20 items, but we skip pagination to get all items
          pagination: pagination?.page ? { page: pagination.page } : undefined,
        }
      );
      return data.equipmentList;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

// Status colors for display
export const tankStatusColors: Record<string, string> = {
  OPERATIONAL: 'bg-green-100 text-green-800',
  ACTIVE: 'bg-green-100 text-green-800',
  active: 'bg-green-100 text-green-800',
  PREPARING: 'bg-blue-100 text-blue-800',
  preparing: 'bg-blue-100 text-blue-800',
  MAINTENANCE: 'bg-yellow-100 text-yellow-800',
  maintenance: 'bg-yellow-100 text-yellow-800',
  CLEANING: 'bg-cyan-100 text-cyan-800',
  cleaning: 'bg-cyan-100 text-cyan-800',
  HARVESTING: 'bg-purple-100 text-purple-800',
  harvesting: 'bg-purple-100 text-purple-800',
  FALLOW: 'bg-gray-100 text-gray-800',
  fallow: 'bg-gray-100 text-gray-800',
  QUARANTINE: 'bg-red-100 text-red-800',
  quarantine: 'bg-red-100 text-red-800',
  OUT_OF_SERVICE: 'bg-gray-200 text-gray-600',
  DECOMMISSIONED: 'bg-gray-200 text-gray-600',
  inactive: 'bg-gray-200 text-gray-600',
  INACTIVE: 'bg-gray-200 text-gray-600',
};

// Tank type labels
export const tankTypeLabels: Record<string, string> = {
  circular: 'Circular',
  rectangular: 'Rectangular',
  raceway: 'Raceway',
  d_end: 'D-End',
  oval: 'Oval',
  square: 'Square',
  other: 'Other',
};

// Material labels
export const tankMaterialLabels: Record<string, string> = {
  fiberglass: 'Fiberglass',
  concrete: 'Concrete',
  hdpe: 'HDPE',
  steel: 'Steel',
  stainless_steel: 'Stainless Steel',
  pvc: 'PVC',
  liner: 'Liner',
  other: 'Other',
};

// Water type labels
export const waterTypeLabels: Record<string, string> = {
  freshwater: 'Freshwater',
  saltwater: 'Saltwater',
  brackish: 'Brackish',
  FRESHWATER: 'Freshwater',
  SALTWATER: 'Saltwater',
  BRACKISH: 'Brackish',
};
