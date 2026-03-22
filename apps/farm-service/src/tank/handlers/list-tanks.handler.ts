/**
 * List Tanks Query Handler
 * @module Tank/Handlers
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListTanksQuery } from '../queries/list-tanks.query';
import { Tank } from '../entities/tank.entity';

@QueryHandler(ListTanksQuery)
export class ListTanksHandler
  implements IQueryHandler<ListTanksQuery, PaginatedQueryResult<Tank>>
{
  constructor(
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
  ) {}

  async execute(query: ListTanksQuery): Promise<PaginatedQueryResult<Tank>> {
    const { tenantId, filter } = query;

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 20;
    const sortBy = filter?.sortBy ?? 'name';
    const sortOrder = filter?.sortOrder ?? 'ASC';

    // Build query
    const queryBuilder = this.tankRepository
      .createQueryBuilder('tank')
      .leftJoinAndSelect('tank.department', 'department')
      .where('tank.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.departmentId) {
      queryBuilder.andWhere('tank.departmentId = :departmentId', {
        departmentId: filter.departmentId,
      });
    }

    if (filter?.tankType) {
      queryBuilder.andWhere('tank.tankType = :tankType', {
        tankType: filter.tankType,
      });
    }

    if (filter?.material) {
      queryBuilder.andWhere('tank.material = :material', {
        material: filter.material,
      });
    }

    if (filter?.waterType) {
      queryBuilder.andWhere('tank.waterType = :waterType', {
        waterType: filter.waterType,
      });
    }

    if (filter?.status) {
      queryBuilder.andWhere('tank.status = :status', {
        status: filter.status,
      });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('tank.isActive = :isActive', {
        isActive: filter.isActive,
      });
    }

    // Filter by available capacity
    if (filter?.hasAvailableCapacity === true) {
      queryBuilder.andWhere('tank.currentBiomass < tank.maxBiomass');
    }

    // Volume filters
    if (filter?.minVolume !== undefined) {
      queryBuilder.andWhere('tank.volume >= :minVolume', {
        minVolume: filter.minVolume,
      });
    }

    if (filter?.maxVolume !== undefined) {
      queryBuilder.andWhere('tank.volume <= :maxVolume', {
        maxVolume: filter.maxVolume,
      });
    }

    // Search across multiple fields
    if (filter?.search) {
      const search = `%${filter.search}%`;
      queryBuilder.andWhere(
        '(tank.name ILIKE :search OR tank.code ILIKE :search OR tank.description ILIKE :search)',
        { search },
      );
    }

    // Apply sorting
    const validSortFields = [
      'name',
      'code',
      'tankType',
      'volume',
      'maxBiomass',
      'currentBiomass',
      'status',
      'createdAt',
      'updatedAt',
    ];

    const validSortOrders = ['ASC', 'DESC'] as const;
    const safeSortOrder = validSortOrders.includes(sortOrder?.toUpperCase() as any)
      ? (sortOrder.toUpperCase() as 'ASC' | 'DESC')
      : 'ASC';

    if (validSortFields.includes(sortBy)) {
      queryBuilder.orderBy(
        `tank.${sortBy}`,
        safeSortOrder,
      );
    } else {
      queryBuilder.orderBy('tank.name', 'ASC');
    }

    // Apply pagination
    queryBuilder.skip(offset).take(limit);

    // PERF(F1-006): Single query for both count and data instead of two separate round-trips
    const [items, total] = await queryBuilder.getManyAndCount();
    const page = Math.floor(offset / limit) + 1;

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
