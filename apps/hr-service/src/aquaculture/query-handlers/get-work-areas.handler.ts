import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWorkAreasQuery } from '../queries/get-work-areas.query';
import { WorkArea } from '../entities/work-area.entity';

@QueryHandler(GetWorkAreasQuery)
export class GetWorkAreasHandler implements IQueryHandler<GetWorkAreasQuery> {
  constructor(
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
  ) {}

  async execute(query: GetWorkAreasQuery): Promise<PaginatedQueryResult<WorkArea>> {
    const { tenantId, workAreaType, isOffshore, isActive } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

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
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
