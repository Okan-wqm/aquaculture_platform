import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWorkAreasQuery } from '../queries/get-work-areas.query';
import { WorkArea } from '../entities/work-area.entity';

export interface PaginatedWorkAreas {
  items: WorkArea[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetWorkAreasQuery)
export class GetWorkAreasHandler implements IQueryHandler<GetWorkAreasQuery> {
  constructor(
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
  ) {}

  async execute(query: GetWorkAreasQuery): Promise<PaginatedWorkAreas> {
    const { tenantId, workAreaType, isOffshore, isActive, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

    const queryBuilder = this.workAreaRepository
      .createQueryBuilder('wa')
      .where('wa.tenantId = :tenantId', { tenantId })
      .andWhere('wa.isDeleted = false')
      .orderBy('wa.displayOrder', 'ASC')
      .addOrderBy('wa.name', 'ASC');

    if (workAreaType) {
      queryBuilder.andWhere('wa.workAreaType = :workAreaType', { workAreaType });
    }

    if (isOffshore !== undefined) {
      queryBuilder.andWhere('wa.isOffshore = :isOffshore', { isOffshore });
    }

    if (isActive !== undefined) {
      queryBuilder.andWhere('wa.isActive = :isActive', { isActive });
    }

    const [items, total] = await queryBuilder
      .skip(effectiveOffset)
      .take(effectiveLimit)
      .getManyAndCount();

    return {
      items,
      total,
      limit: effectiveLimit,
      offset: effectiveOffset,
      hasMore: effectiveOffset + items.length < total,
    };
  }
}
