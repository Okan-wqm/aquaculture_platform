/**
 * List Equipment Query Handler
 *
 * Unified query that returns data from BOTH the `equipment` table AND the `tanks` table.
 * When filtering by categories TANK, POND, or CAGE (or no category filter),
 * it also queries the tanks table and transforms Tank entities to Equipment format.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { DataSource, EntityManager } from 'typeorm';
import { ListEquipmentQuery } from '../queries/list-equipment.query';
import { Equipment, EquipmentStatus, EquipmentLocation, TankSpecifications } from '../entities/equipment.entity';
import { EquipmentSystem } from '../entities/equipment-system.entity';
import { EquipmentType, EquipmentCategory } from '../entities/equipment-type.entity';
import { Tank, TankContainerKind, TankStatus, TankType } from '../../tank/entities/tank.entity';

/**
 * Categories that can contain tank-like items from the tanks table
 */
const TANK_LIKE_CATEGORIES: EquipmentCategory[] = [
  EquipmentCategory.TANK,
  EquipmentCategory.POND,
  EquipmentCategory.CAGE,
];

type EquipmentSourcePage = Pick<PaginationResultV1<Equipment>, 'items' | 'total'>;

/**
 * Map TankStatus to EquipmentStatus
 */
function mapTankStatusToEquipmentStatus(tankStatus: TankStatus): EquipmentStatus {
  const statusMap: Record<TankStatus, EquipmentStatus> = {
    [TankStatus.ACTIVE]: EquipmentStatus.ACTIVE,
    [TankStatus.PREPARING]: EquipmentStatus.PREPARING,
    [TankStatus.CLEANING]: EquipmentStatus.CLEANING,
    [TankStatus.MAINTENANCE]: EquipmentStatus.MAINTENANCE,
    [TankStatus.HARVESTING]: EquipmentStatus.HARVESTING,
    [TankStatus.FALLOW]: EquipmentStatus.FALLOW,
    [TankStatus.QUARANTINE]: EquipmentStatus.QUARANTINE,
    [TankStatus.INACTIVE]: EquipmentStatus.OUT_OF_SERVICE,
  };
  return statusMap[tankStatus] || EquipmentStatus.OPERATIONAL;
}

/**
 * Map TankType to equipment type code
 */
function mapTankTypeToEquipmentTypeCode(tankType: TankType): string {
  const typeMap: Record<TankType, string> = {
    [TankType.CIRCULAR]: 'tank-circular',
    [TankType.RECTANGULAR]: 'tank-rectangular',
    [TankType.RACEWAY]: 'tank-raceway',
    [TankType.D_END]: 'tank-raceway', // D_END is a variant of raceway
    [TankType.OVAL]: 'tank-circular', // Oval is similar to circular
    [TankType.SQUARE]: 'tank-rectangular', // Square is similar to rectangular
    [TankType.OTHER]: 'tank-circular', // Default to circular
  };
  return typeMap[tankType] || 'tank-circular';
}

@QueryHandler(ListEquipmentQuery)
export class ListEquipmentHandler implements IQueryHandler<ListEquipmentQuery> {
  // WHY: equipment + tanks are per-tenant data. Reading them through a raw injected
  // repository resolves the table via the pooled connection's ambient search_path,
  // which on a lost/rotated tenant context silently reads the wrong schema (or the
  // empty source schema) — the "equipment appears then disappears" intermittent
  // failure. WHAT: read through the fail-closed runInTenantRead boundary, which pins +
  // asserts search_path + the RLS GUC to tenant_<uuid> before any query runs.
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: ListEquipmentQuery): Promise<PaginatedQueryResult<Equipment>> {
    const { tenantId, filter, pagination } = query;

    const MAX_LIMIT = 100;
    const page = pagination?.page || 1;
    // Cap limit to prevent excessive data retrieval (DTO max is 100)
    const limit = Math.min(pagination?.limit ?? 50, MAX_LIMIT);
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Determine if we should also query the tanks table
    const shouldQueryTanks = this.shouldQueryTanksTable(filter);

    // Cap the maximum rows loaded from each source to prevent OOM under large datasets.
    // We need (page * limit) rows from the merged set to satisfy the current page.
    const maxRowsNeeded = page * limit;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      // Query equipment table with row cap
      const equipmentResult = await this.queryEquipmentTable(manager, tenantId, filter, sortBy, sortOrder, maxRowsNeeded);

      // Query tanks table if applicable with row cap
      let tankResult: EquipmentSourcePage = { items: [], total: 0 };
      if (shouldQueryTanks) {
        tankResult = await this.queryAndTransformTanks(manager, tenantId, filter, sortBy, sortOrder, maxRowsNeeded);
      }

      // Merge results from both tables
      const allItems = this.dedupeMergedResults([...equipmentResult.items, ...tankResult.items]);
      const totalCount = equipmentResult.total + tankResult.total;

      // Sort merged results
      const sortedItems = this.sortMergedResults(allItems, sortBy, sortOrder);

      // Apply pagination to merged results
      const startIndex = (page - 1) * limit;
      const paginatedItems = sortedItems.slice(startIndex, startIndex + limit);

      return createPaginatedQueryResult(paginatedItems, page, limit, totalCount);
    });
  }

  /**
   * Determine if we should query the tanks table based on filter
   */
  private shouldQueryTanksTable(filter?: ListEquipmentQuery['filter']): boolean {
    // If isTank is explicitly false, don't query tanks table
    if (filter?.isTank === false) {
      return false;
    }

    // If categories filter is present, check if any tank-like categories are included
    if (filter?.categories && filter.categories.length > 0) {
      return filter.categories.some(cat => TANK_LIKE_CATEGORIES.includes(cat));
    }

    // If isTank is explicitly true, query tanks table
    if (filter?.isTank === true) {
      return true;
    }

    // Default: query tanks table (no category filter means all categories)
    return true;
  }

  /**
   * Query the equipment table
   */
  private async queryEquipmentTable(
    manager: EntityManager,
    tenantId: string,
    filter: ListEquipmentQuery['filter'],
    sortBy: string,
    sortOrder: 'ASC' | 'DESC',
    maxRows?: number,
  ): Promise<EquipmentSourcePage> {
    // tenantId is auto-injected by the tenant-scoped createQueryBuilder() — the manual
    // tenant predicate is dropped (the boundary + scoped repo enforce isolation).
    const queryBuilder = tenantManagerRepo(manager, Equipment, tenantId).createQueryBuilder('equipment');
    // DEFAULT: Only return non-deleted equipment
    queryBuilder.andWhere('equipment.isDeleted = :isDeleted', { isDeleted: false });

    // Join related entities
    queryBuilder.leftJoinAndSelect('equipment.department', 'department');
    queryBuilder.leftJoinAndSelect('equipment.equipmentType', 'equipmentType');
    queryBuilder.leftJoinAndSelect('equipment.equipmentSystems', 'equipmentSystems');
    queryBuilder.leftJoinAndSelect('equipmentSystems.system', 'system');
    // Join parent/child equipment for hierarchy display
    queryBuilder.leftJoinAndSelect('equipment.parentEquipment', 'parentEquipment');
    queryBuilder.leftJoinAndSelect('parentEquipment.equipmentType', 'parentEquipmentType');
    queryBuilder.leftJoinAndSelect('equipment.childEquipment', 'childEquipment');
    queryBuilder.leftJoinAndSelect('childEquipment.equipmentType', 'childEquipmentType');

    if (filter?.departmentId) {
      queryBuilder.andWhere('equipment.departmentId = :departmentId', { departmentId: filter.departmentId });
    }

    // Note: siteId is not a direct column on equipment - filter via department.siteId if needed
    if (filter?.siteId) {
      queryBuilder.andWhere('department.siteId = :siteId', { siteId: filter.siteId });
    }

    // Filter by systemId via junction table
    if (filter?.systemId) {
      queryBuilder.andWhere('equipmentSystems.systemId = :systemId', { systemId: filter.systemId });
    }

    if (filter?.parentEquipmentId) {
      queryBuilder.andWhere('equipment.parentEquipmentId = :parentEquipmentId', { parentEquipmentId: filter.parentEquipmentId });
    }

    // Root only filter - get equipment without parent
    if (filter?.rootOnly) {
      queryBuilder.andWhere('equipment.parentEquipmentId IS NULL');
    }

    if (filter?.equipmentTypeId) {
      queryBuilder.andWhere('equipment.equipmentTypeId = :equipmentTypeId', { equipmentTypeId: filter.equipmentTypeId });
    }

    if (filter?.status) {
      queryBuilder.andWhere('equipment.status = :status', { status: filter.status });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('equipment.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.hasWarranty) {
      queryBuilder.andWhere('equipment.warrantyEndDate > :now', { now: new Date() });
    }

    if (filter?.isVisibleInSensor !== undefined) {
      queryBuilder.andWhere('equipment.isVisibleInSensor = :isVisibleInSensor', { isVisibleInSensor: filter.isVisibleInSensor });
    }

    if (filter?.isTank !== undefined) {
      queryBuilder.andWhere('equipment.isTank = :isTank', { isTank: filter.isTank });
    }

    // Filter by equipment type categories (e.g., tank, pond, cage)
    if (filter?.categories && filter.categories.length > 0) {
      queryBuilder.andWhere('equipmentType.category IN (:...categories)', { categories: filter.categories });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(equipment.name ILIKE :search OR equipment.code ILIKE :search OR equipment.serialNumber ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting with allowlist to prevent SQL injection
    const validSortFields = ['name', 'code', 'status', 'volume', 'createdAt', 'updatedAt'];
    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    queryBuilder.orderBy(`equipment.${safeSortBy}`, sortOrder);

    // Get total count first
    const total = await queryBuilder.getCount();

    // Apply row cap to prevent loading entire dataset into memory
    if (maxRows) {
      queryBuilder.take(maxRows);
    }

    const items = await queryBuilder.getMany();

    return { items, total };
  }

  /**
   * Query tanks table and transform to Equipment format
   */
  private async queryAndTransformTanks(
    manager: EntityManager,
    tenantId: string,
    filter: ListEquipmentQuery['filter'],
    sortBy: string,
    sortOrder: 'ASC' | 'DESC',
    maxRows?: number,
  ): Promise<EquipmentSourcePage> {
    // tenantId is auto-injected by the tenant-scoped createQueryBuilder().
    const tankQueryBuilder = tenantManagerRepo(manager, Tank, tenantId).createQueryBuilder('tank');
    tankQueryBuilder.andWhere('tank.isActive = :isActive', { isActive: true });

    // Join department for siteId filtering
    tankQueryBuilder.leftJoinAndSelect('tank.department', 'department');

    // Apply filters compatible with tanks
    if (filter?.departmentId) {
      tankQueryBuilder.andWhere('tank.departmentId = :departmentId', { departmentId: filter.departmentId });
    }

    if (filter?.siteId) {
      tankQueryBuilder.andWhere('department.siteId = :siteId', { siteId: filter.siteId });
    }

    if (filter?.systemId) {
      tankQueryBuilder.andWhere('tank.systemId = :systemId', { systemId: filter.systemId });
    }

    if (filter?.equipmentTypeId) {
      tankQueryBuilder.andWhere('tank.equipmentTypeId = :equipmentTypeId', {
        equipmentTypeId: filter.equipmentTypeId,
      });
    }

    if (filter?.isActive !== undefined) {
      tankQueryBuilder.andWhere('tank.isActive = :isActive', { isActive: filter.isActive });
    }

    // Map equipment status filter to tank status
    if (filter?.status) {
      const tankStatus = this.mapEquipmentStatusToTankStatus(filter.status);
      if (tankStatus) {
        tankQueryBuilder.andWhere('tank.status = :status', { status: tankStatus });
      }
    }

    if (filter?.search) {
      tankQueryBuilder.andWhere(
        '(tank.name ILIKE :search OR tank.code ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    if (filter?.categories && filter.categories.length > 0) {
      tankQueryBuilder.andWhere('tank.containerKind IN (:...containerKinds)', {
        containerKinds: filter.categories.map((category) => this.mapCategoryToContainerKind(category)),
      });
    }

    // Apply sorting to tanks query
    const tankSortBy = this.mapSortFieldToTank(sortBy);
    tankQueryBuilder.orderBy(`tank.${tankSortBy}`, sortOrder);

    const total = await tankQueryBuilder.getCount();

    // Apply row cap to prevent loading entire dataset into memory
    if (maxRows) {
      tankQueryBuilder.take(maxRows);
    }

    const tanks = await tankQueryBuilder.getMany();

    // Load equipment types for transformation
    const equipmentTypes = await this.loadEquipmentTypesMap(manager);

    // Transform tanks to Equipment format
    return {
      items: tanks.map(tank => this.transformTankToEquipment(tank, equipmentTypes)),
      total,
    };
  }

  /**
   * Map EquipmentStatus to TankStatus
   */
  private mapEquipmentStatusToTankStatus(equipmentStatus: EquipmentStatus): TankStatus | null {
    const statusMap: Partial<Record<EquipmentStatus, TankStatus>> = {
      [EquipmentStatus.ACTIVE]: TankStatus.ACTIVE,
      [EquipmentStatus.PREPARING]: TankStatus.PREPARING,
      [EquipmentStatus.CLEANING]: TankStatus.CLEANING,
      [EquipmentStatus.MAINTENANCE]: TankStatus.MAINTENANCE,
      [EquipmentStatus.HARVESTING]: TankStatus.HARVESTING,
      [EquipmentStatus.FALLOW]: TankStatus.FALLOW,
      [EquipmentStatus.QUARANTINE]: TankStatus.QUARANTINE,
      [EquipmentStatus.OUT_OF_SERVICE]: TankStatus.INACTIVE,
    };
    return statusMap[equipmentStatus] || null;
  }

  /**
   * Map sort field to tank-compatible field
   */
  private mapSortFieldToTank(sortBy: string): string {
    const fieldMap: Record<string, string> = {
      'createdAt': 'createdAt',
      'updatedAt': 'updatedAt',
      'name': 'name',
      'code': 'code',
      'status': 'status',
      'volume': 'volume',
    };
    return fieldMap[sortBy] || 'createdAt';
  }

  /**
   * Load equipment types into a map for quick lookup
   * PERF(F5-007): Cached in-process with 1-hour TTL since equipment types are seeded reference data
   */
  private equipmentTypesCache: { map: Map<string, EquipmentType>; expiresAt: number } | null = null;
  private static readonly EQUIPMENT_TYPES_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  private async loadEquipmentTypesMap(manager: EntityManager): Promise<Map<string, EquipmentType>> {
    if (this.equipmentTypesCache && this.equipmentTypesCache.expiresAt > Date.now()) {
      return this.equipmentTypesCache.map;
    }

    // Use explicit farm schema to avoid tenant shadow tables; run on the boundary's
    // tenant-pinned connection (manager) rather than a random pooled connection.
    const equipmentTypes: EquipmentType[] = await manager.query(
      `SELECT * FROM "farm"."equipment_types" WHERE "category" = ANY($1)`,
      [[EquipmentCategory.TANK, EquipmentCategory.POND, EquipmentCategory.CAGE]],
    );

    const map = new Map<string, EquipmentType>();
    for (const type of equipmentTypes) {
      map.set(type.code, type);
    }

    this.equipmentTypesCache = {
      map,
      expiresAt: Date.now() + ListEquipmentHandler.EQUIPMENT_TYPES_CACHE_TTL_MS,
    };

    return map;
  }

  /**
   * Transform a Tank entity to Equipment format
   */
  private transformTankToEquipment(
    tank: Tank,
    equipmentTypes: Map<string, EquipmentType>,
  ): Equipment {
    const equipmentTypeCode = tank.equipmentTypeCode || mapTankTypeToEquipmentTypeCode(tank.tankType);
    const equipmentType = equipmentTypes.get(equipmentTypeCode);

    // Build specifications JSONB from tank dimensions
    const specifications: TankSpecifications = {
      tankType: tank.tankType as TankSpecifications['tankType'],
      material: tank.material as TankSpecifications['material'],
      waterType: tank.waterType as TankSpecifications['waterType'],
      dimensions: {
        diameter: tank.diameter ? Number(tank.diameter) : undefined,
        length: tank.length ? Number(tank.length) : undefined,
        width: tank.width ? Number(tank.width) : undefined,
        depth: Number(tank.depth),
        waterDepth: tank.waterDepth ? Number(tank.waterDepth) : undefined,
        freeboard: tank.freeboard ? Number(tank.freeboard) : undefined,
      },
      volume: Number(tank.volume),
      waterVolume: tank.waterVolume ? Number(tank.waterVolume) : undefined,
      maxBiomass: Number(tank.maxBiomass),
      maxDensity: Number(tank.maxDensity),
      maxCount: tank.currentCount || undefined,
      waterFlow: tank.waterFlow || undefined,
      aeration: tank.aeration || undefined,
    };

    // Create Equipment object from Tank
    const equipment = new Equipment();
    equipment.id = tank.id;
    equipment.tenantId = tank.tenantId;
    equipment.name = tank.name;
    equipment.code = tank.code;
    equipment.description = tank.description;
    equipment.departmentId = tank.departmentId;
    equipment.department = tank.department;
    equipment.status = mapTankStatusToEquipmentStatus(tank.status);
    equipment.specifications = specifications;
    equipment.location = tank.location as EquipmentLocation;
    equipment.notes = tank.notes;
    equipment.installationDate = tank.installationDate;
    equipment.isTank = true;
    equipment.isVisibleInSensor = true; // Tanks are typically visible in sensor module
    equipment.volume = Number(tank.volume);
    equipment.currentBiomass = Number(tank.currentBiomass);
    equipment.currentCount = tank.currentCount;
    equipment.isActive = tank.isActive;
    equipment.isDeleted = false;
    equipment.createdAt = tank.createdAt;
    equipment.updatedAt = tank.updatedAt;
    equipment.createdBy = tank.createdBy;
    equipment.updatedBy = tank.updatedBy;
    equipment.version = tank.version;

    // Set equipment type if found
    if (equipmentType) {
      equipment.equipmentTypeId = equipmentType.id;
      equipment.equipmentType = equipmentType;
    } else if (tank.equipmentTypeId) {
      equipment.equipmentTypeId = tank.equipmentTypeId;
    }

    // Populate equipmentSystems from tank's systemId (single FK → synthetic junction)
    if (tank.systemId) {
      equipment.equipmentSystems = [{
        id: `${tank.id}-${tank.systemId}`,
        tenantId: tank.tenantId,
        equipmentId: tank.id,
        systemId: tank.systemId,
        isPrimary: true,
        criticalityLevel: 3,
        createdAt: tank.createdAt,
        createdBy: tank.createdBy,
      }] as EquipmentSystem[];
    } else {
      equipment.equipmentSystems = [];
    }
    equipment.childEquipment = [];

    return equipment;
  }

  /**
   * Sort merged results from both tables
   */
  private sortMergedResults(
    items: Equipment[],
    sortBy: string,
    sortOrder: 'ASC' | 'DESC',
  ): Equipment[] {
    return items.sort((a, b) => {
      let aValue: any;
      let bValue: any;

      switch (sortBy) {
        case 'name':
          aValue = a.name?.toLowerCase() || '';
          bValue = b.name?.toLowerCase() || '';
          break;
        case 'code':
          aValue = a.code?.toLowerCase() || '';
          bValue = b.code?.toLowerCase() || '';
          break;
        case 'status':
          aValue = a.status || '';
          bValue = b.status || '';
          break;
        case 'volume':
          aValue = Number(a.volume) || 0;
          bValue = Number(b.volume) || 0;
          break;
        case 'updatedAt':
          aValue = a.updatedAt?.getTime() || 0;
          bValue = b.updatedAt?.getTime() || 0;
          break;
        case 'createdAt':
        default:
          aValue = a.createdAt?.getTime() || 0;
          bValue = b.createdAt?.getTime() || 0;
          break;
      }

      if (aValue < bValue) return sortOrder === 'ASC' ? -1 : 1;
      if (aValue > bValue) return sortOrder === 'ASC' ? 1 : -1;
      return 0;
    });
  }

  private dedupeMergedResults(items: Equipment[]): Equipment[] {
    const byId = new Map<string, Equipment>();
    for (const item of items) {
      byId.set(item.id, item);
    }
    return [...byId.values()];
  }

  private mapCategoryToContainerKind(category: EquipmentCategory): TankContainerKind {
    if (category === EquipmentCategory.POND) return TankContainerKind.POND;
    if (category === EquipmentCategory.CAGE) return TankContainerKind.CAGE;
    return TankContainerKind.TANK;
  }
}
