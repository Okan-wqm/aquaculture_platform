/**
 * Tank Service
 * GraphQL API calls for tank operations
 *
 * Tanks are stored as Equipment with isTank=true.
 * This service queries the equipmentList endpoint and transforms the data.
 */
import { graphqlClient } from '@aquaculture/shared-ui';
import { TankBatch } from '../pages/production/types/batch.types';

// ============================================================================
// TYPES
// ============================================================================

export interface TankCapacityInfo {
  currentBiomass: number;
  maxBiomass: number;
  availableCapacity: number;
  utilizationPercent: number;
  currentDensity: number;
  maxDensity: number;
  hasCapacity: boolean;
}

/**
 * Tank specifications stored in Equipment.specifications JSONB
 */
export interface TankSpecifications {
  tankType?: 'circular' | 'rectangular' | 'raceway' | 'd_end' | 'oval' | 'square' | 'other';
  material?: 'fiberglass' | 'concrete' | 'hdpe' | 'steel' | 'stainless_steel' | 'pvc' | 'liner' | 'other';
  waterType?: 'freshwater' | 'saltwater' | 'brackish';
  dimensions?: {
    diameter?: number;
    length?: number;
    width?: number;
    depth?: number;
    waterDepth?: number;
  };
  volume?: number;
  waterVolume?: number;
  maxBiomass?: number;
  maxDensity?: number;
  maxCount?: number;
}

/**
 * Equipment data from GraphQL (for tanks)
 */
export interface EquipmentTank {
  id: string;
  name: string;
  code: string;
  description?: string;
  departmentId?: string;
  status: string;
  specifications?: TankSpecifications;
  volume?: number;
  currentBiomass?: number;
  currentCount?: number;
  isActive: boolean;
  isTank?: boolean;
}

export interface Tank {
  id: string;
  name: string;
  code: string;
  description?: string;
  departmentId: string;
  status: string;
  tankType: string;
  material: string;
  waterType: string;
  volume: number;
  waterVolume?: number;
  currentBiomass: number;
  currentCount?: number;
  maxBiomass: number;
  maxDensity: number;
  isActive: boolean;
  capacityInfo?: TankCapacityInfo;
}

export interface TankListResponse {
  items: Tank[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface TankFilterInput {
  search?: string;
  departmentId?: string;
  siteId?: string;
  tankType?: string;
  material?: string;
  waterType?: string;
  status?: string;
  isActive?: boolean;
  hasAvailableCapacity?: boolean;
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

// ============================================================================
// TRANSFORM FUNCTIONS
// ============================================================================

/**
 * Transform Equipment (tank) to Tank format
 */
export function equipmentToTank(equipment: EquipmentTank): Tank {
  const specs = equipment.specifications || {};
  const volume = equipment.volume || specs.volume || 0;
  const waterVolume = specs.waterVolume || specs.dimensions?.waterDepth
    ? calculateWaterVolume(specs)
    : undefined;
  const currentBiomass = equipment.currentBiomass || 0;
  const maxBiomass = specs.maxBiomass || 0;
  const maxDensity = specs.maxDensity || 30;

  // Calculate capacity info
  const effectiveVolume = waterVolume || volume || 1;
  const currentDensity = effectiveVolume > 0 ? currentBiomass / effectiveVolume : 0;
  const utilizationPercent = maxBiomass > 0 ? (currentBiomass / maxBiomass) * 100 : 0;
  const byBiomass = maxBiomass - currentBiomass;
  const byDensity = maxDensity * effectiveVolume - currentBiomass;
  const availableCapacity = Math.min(byBiomass, byDensity);

  return {
    id: equipment.id,
    name: equipment.name,
    code: equipment.code,
    description: equipment.description,
    departmentId: equipment.departmentId || '',
    status: equipment.status,
    tankType: specs.tankType || 'other',
    material: specs.material || 'other',
    waterType: specs.waterType || 'saltwater',
    volume,
    waterVolume,
    currentBiomass,
    currentCount: equipment.currentCount,
    maxBiomass,
    maxDensity,
    isActive: equipment.isActive,
    capacityInfo: {
      currentBiomass,
      maxBiomass,
      availableCapacity,
      utilizationPercent,
      currentDensity,
      maxDensity,
      hasCapacity: availableCapacity > 0,
    },
  };
}

/**
 * Calculate water volume from specifications
 */
function calculateWaterVolume(specs: TankSpecifications): number | undefined {
  if (!specs.dimensions?.waterDepth) return undefined;

  const waterDepth = specs.dimensions.waterDepth;
  const tankType = specs.tankType || 'other';

  switch (tankType) {
    case 'circular':
    case 'oval':
      const diameter = specs.dimensions.diameter || 0;
      return Math.PI * Math.pow(diameter / 2, 2) * waterDepth;
    case 'rectangular':
    case 'square':
    case 'raceway':
    case 'd_end':
      const length = specs.dimensions.length || 0;
      const width = specs.dimensions.width || 0;
      return length * width * waterDepth;
    default:
      return undefined;
  }
}

/**
 * Transform Tank entity to TankBatch format for display
 */
export function tankToTankBatch(tank: Tank): TankBatch {
  const volume = tank.waterVolume || tank.volume || 1;
  const currentBiomass = tank.currentBiomass || 0;
  const currentCount = tank.currentCount || 0;
  const density = volume > 0 ? currentBiomass / volume : 0;
  const avgWeight = currentCount > 0 ? (currentBiomass * 1000) / currentCount : 0; // Convert kg to g
  const utilizationPercent = tank.capacityInfo?.utilizationPercent ??
    (tank.maxBiomass > 0 ? (currentBiomass / tank.maxBiomass) * 100 : 0);

  return {
    id: tank.id,
    tenantId: '', // Will be filled by context
    equipmentId: tank.id,
    tankName: tank.name,
    tankCode: tank.code,
    primaryBatchId: undefined,
    primaryBatchNumber: undefined, // TODO: Fetch from batch allocation
    totalQuantity: currentCount,
    avgWeightG: avgWeight,
    totalBiomassKg: currentBiomass,
    densityKgM3: density,
    isMixedBatch: false,
    capacityUsedPercent: utilizationPercent,
    isOverCapacity: utilizationPercent > 100,
  };
}

/**
 * Transform Equipment directly to TankBatch format
 */
export function equipmentToTankBatch(equipment: EquipmentTank): TankBatch {
  const tank = equipmentToTank(equipment);
  return tankToTankBatch(tank);
}

// ============================================================================
// GRAPHQL QUERIES
// ============================================================================

/**
 * Query equipment list with isTank=true filter
 * This fetches tanks from the Equipment table
 */
const EQUIPMENT_TANKS_QUERY = `
  query EquipmentTanks($filter: EquipmentFilterInput) {
    equipmentList(filter: $filter) {
      items {
        id
        name
        code
        description
        departmentId
        status
        specifications
        volume
        currentBiomass
        currentCount
        isActive
        isTank
      }
      total
      page
      limit
      totalPages
    }
  }
`;

/**
 * Query single equipment by ID
 */
const EQUIPMENT_BY_ID_QUERY = `
  query Equipment($id: ID!) {
    equipment(id: $id, includeRelations: true) {
      id
      name
      code
      description
      departmentId
      status
      specifications
      volume
      currentBiomass
      currentCount
      isActive
      isTank
    }
  }
`;

// ============================================================================
// GRAPHQL RESPONSE TYPES
// ============================================================================

interface EquipmentListResponse {
  items: EquipmentTank[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// SERVICE FUNCTIONS
// ============================================================================

/**
 * List tanks (from Equipment table) with optional filtering
 */
export async function listTanks(filter?: TankFilterInput): Promise<TankListResponse> {
  const response = await graphqlClient.request<{ equipmentList: EquipmentListResponse }>(
    EQUIPMENT_TANKS_QUERY,
    {
      filter: {
        isTank: true,
        departmentId: filter?.departmentId,
        siteId: filter?.siteId,
        isActive: filter?.isActive,
        search: filter?.search,
      },
      // Note: pagination is omitted to use server defaults
      // The gateway has conflicting PaginationInput types between services
    }
  );

  const equipmentList = response.equipmentList;
  const tanks = equipmentList.items.map(equipmentToTank);

  // Apply additional client-side filters if needed
  let filteredTanks = tanks;

  if (filter?.tankType) {
    filteredTanks = filteredTanks.filter(t => t.tankType === filter.tankType);
  }
  if (filter?.material) {
    filteredTanks = filteredTanks.filter(t => t.material === filter.material);
  }
  if (filter?.waterType) {
    filteredTanks = filteredTanks.filter(t => t.waterType === filter.waterType);
  }
  if (filter?.hasAvailableCapacity) {
    filteredTanks = filteredTanks.filter(t => t.capacityInfo?.hasCapacity === true);
  }

  return {
    items: filteredTanks,
    total: equipmentList.total,
    offset: (equipmentList.page - 1) * equipmentList.limit,
    limit: equipmentList.limit,
    hasMore: equipmentList.page < equipmentList.totalPages,
  };
}

/**
 * Get a single tank by ID
 */
export async function getTankById(id: string): Promise<Tank> {
  const response = await graphqlClient.request<{ equipment: EquipmentTank }>(
    EQUIPMENT_BY_ID_QUERY,
    { id }
  );
  return equipmentToTank(response.equipment);
}

/**
 * Get tanks by department
 */
export async function getTanksByDepartment(departmentId: string): Promise<Tank[]> {
  const response = await listTanks({ departmentId, isActive: true, limit: 100 });
  return response.items;
}

/**
 * Get available tanks (with capacity)
 */
export async function getAvailableTanks(departmentId?: string): Promise<Tank[]> {
  const response = await listTanks({
    departmentId,
    hasAvailableCapacity: true,
    isActive: true,
    limit: 100,
  });
  return response.items;
}

/**
 * List tanks and transform to TankBatch format for Tank Operations display
 */
export async function listTanksAsBatches(filter?: TankFilterInput): Promise<TankBatch[]> {
  const response = await listTanks(filter);
  return response.items.map(tankToTankBatch);
}

// ============================================================================
// EXPORT DEFAULT
// ============================================================================

const tankService = {
  listTanks,
  getTankById,
  getTanksByDepartment,
  getAvailableTanks,
  listTanksAsBatches,
  tankToTankBatch,
};

export default tankService;
