/**
 * Get Equipment Types Query Handler
 *
 * PERF(F3-001, F5-007): Equipment types are seeded reference data that rarely change.
 * Results are cached in-process with a 1-hour TTL to avoid redundant DB queries.
 * Direct ID lookup supported to avoid full-table-scan + JS filter pattern.
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetEquipmentTypesQuery } from '../queries/get-equipment-types.query';
import { EquipmentType } from '../entities/equipment-type.entity';

/** In-process cache TTL: 1 hour (equipment types are seeded and rarely change) */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CachedResult {
  data: EquipmentType[];
  expiresAt: number;
}

@QueryHandler(GetEquipmentTypesQuery)
export class GetEquipmentTypesHandler implements IQueryHandler<GetEquipmentTypesQuery> {
  /** In-process cache keyed by serialized filter */
  private readonly cache = new Map<string, CachedResult>();

  constructor(
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
  ) {}

  async execute(query: GetEquipmentTypesQuery): Promise<EquipmentType[]> {
    const { filter } = query;

    // PERF(F3-001): Direct ID lookup — bypass cache for single-record fetch
    if (filter?.id) {
      const queryBuilder = this.equipmentTypeRepository.createQueryBuilder('equipmentType');
      queryBuilder.where('equipmentType.id = :id', { id: filter.id });
      if (filter.isActive !== undefined) {
        queryBuilder.andWhere('equipmentType.isActive = :isActive', { isActive: filter.isActive });
      }
      const result = await queryBuilder.getOne();
      return result ? [result] : [];
    }

    // PERF(F5-007): Check in-process cache for list queries
    const cacheKey = JSON.stringify(filter || {});
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const queryBuilder = this.equipmentTypeRepository.createQueryBuilder('equipmentType');

    if (filter?.category) {
      queryBuilder.where('equipmentType.category = :category', { category: filter.category });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('equipmentType.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(equipmentType.name ILIKE :search OR equipmentType.code ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    queryBuilder.orderBy('equipmentType.category', 'ASC');
    queryBuilder.addOrderBy('equipmentType.name', 'ASC');

    const result = await queryBuilder.getMany();

    // Cache result (only for non-search queries to avoid unbounded cache growth)
    if (!filter?.search) {
      // Evict expired entries if cache grows too large
      if (this.cache.size > 50) {
        const now = Date.now();
        for (const [k, v] of this.cache) {
          if (v.expiresAt < now) this.cache.delete(k);
        }
      }
      this.cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return result;
  }
}
