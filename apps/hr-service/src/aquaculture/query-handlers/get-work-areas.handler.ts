import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
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

  async execute(query: GetWorkAreasQuery): Promise<WorkArea[]> {
    const { tenantId, workAreaType, isOffshore, isActive } = query;

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

    return queryBuilder.getMany();
  }
}
