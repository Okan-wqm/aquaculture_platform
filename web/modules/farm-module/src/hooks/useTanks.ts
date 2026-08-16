/**
 * Tank hooks for farm-module
 * Fetches equipment (tanks, ponds, cages) with their batch metrics from Equipment GraphQL endpoint
 */
import { useQuery } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useAuth, graphqlClient, createTenantQueryKey } from '@aquaculture/shared-ui';

// Types
/**
 * One production batch's share of a tank when several are combined (e.g.
 * "B-1 + B-2"). Mirrors the backend TankBatch.batchDetails[] SSoT entry.
 */
export interface BatchDetail {
  batchId: string;
  batchNumber: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  percentageOfTank: number;
}

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
  batchDetails?: BatchDetail[];
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
  // Species information
  speciesCode?: string;
  // Feeding information
  feedCode?: string;
  feedName?: string;
  feedingRatePercent?: number;
  dailyFeedKg?: number;
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

type TankPage = Pick<
  PaginationResultV1<Tank>,
  'items' | 'total' | 'page' | 'limit' | 'totalPages'
>;

type TankListResult = Pick<PaginationResultV1<Tank>, 'items' | 'total'>;

// GraphQL query for equipment (tanks, ponds, cages) with batch metrics
const EQUIPMENT_WITH_BATCHES_QUERY = `
  query EquipmentWithBatches($filter: EquipmentFilterInput, $pagination: FarmPaginationInput) {
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
          batchDetails {
            batchId
            batchNumber
            quantity
            avgWeightG
            biomassKg
            percentageOfTank
          }
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
          speciesCode
          feedCode
          feedName
          feedingRatePercent
          dailyFeedKg
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

/** Backend hard max for FarmPaginationInput.limit (StandardPaginationInput @Max(100)). */
const EQUIPMENT_PAGE_LIMIT = 100;
/** Sanity ceiling for the fetch-all page loop (100 × 50 = 5000 containers). */
const EQUIPMENT_MAX_PAGES = 50;

/**
 * Hook to fetch tanks/ponds/cages with batch metrics.
 *
 * WHY fetch-all: the backend list defaults to 50 rows (max 100/page), and this
 * hook previously sent NO limit — every tank past the 50th was silently
 * invisible on web (mobile pages through everything, hence "batch visible on
 * mobile, missing on web"). The gateway DOES accept FarmPaginationInput.limit;
 * an old comment here claimed otherwise and was the load-bearing bug.
 *
 * WHAT: with explicit pagination the caller's page is fetched as-is; without it
 * the hook pages through the full list (100/page) and returns every container.
 */
export function useTanksList(filter?: TankFilterInput, pagination?: { page?: number; pageSize?: number }) {
  const { token, tenantId } = useAuth();

  return useQuery<TankListResult>({
    queryKey: createTenantQueryKey(tenantId, 'tanks', 'list', filter, pagination),
    queryFn: async () => {
      const gqlFilter = {
        ...filter,
        // Default to TANK, POND, CAGE categories if not specified (uppercase enum values)
        categories: filter?.categories || ['TANK', 'POND', 'CAGE'],
        isActive: filter?.isActive ?? true,
      };
      const fetchPage = async (page: number, limit: number): Promise<TankPage> => {
        const data = await graphqlClient.request<{ equipmentList: TankPage }>(
          EQUIPMENT_WITH_BATCHES_QUERY,
          { filter: gqlFilter, pagination: { page, limit } },
        );
        return data.equipmentList;
      };

      if (pagination?.page) {
        return fetchPage(
          pagination.page,
          Math.min(pagination.pageSize ?? EQUIPMENT_PAGE_LIMIT, EQUIPMENT_PAGE_LIMIT),
        );
      }

      // Fetch-all: page through so every tank/pond/cage is visible on web.
      const first = await fetchPage(1, EQUIPMENT_PAGE_LIMIT);
      const items = [...first.items];
      const totalPages = Math.min(first.totalPages ?? 1, EQUIPMENT_MAX_PAGES);
      for (let page = 2; page <= totalPages; page += 1) {
        const next = await fetchPage(page, EQUIPMENT_PAGE_LIMIT);
        items.push(...next.items);
      }
      return { items, total: first.total };
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
