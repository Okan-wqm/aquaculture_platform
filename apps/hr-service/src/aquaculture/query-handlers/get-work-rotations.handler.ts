import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWorkRotationsQuery } from '../queries/get-work-rotations.query';
import { WorkRotation } from '../entities/work-rotation.entity';

@QueryHandler(GetWorkRotationsQuery)
export class GetWorkRotationsHandler implements IQueryHandler<GetWorkRotationsQuery> {
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetWorkRotationsQuery): Promise<PaginatedQueryResult<WorkRotation>> {
    const { tenantId, employeeId, workAreaId, status, startDate, endDate } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const queryBuilder = this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.isDeleted = false')
      .orderBy('wr.startDate', 'DESC');

    if (employeeId) {
      queryBuilder.andWhere('wr.employeeId = :employeeId', { employeeId });
    }

    if (workAreaId) {
      queryBuilder.andWhere('wr.workAreaId = :workAreaId', { workAreaId });
    }

    if (status) {
      queryBuilder.andWhere('wr.status = :status', { status });
    }

    if (startDate) {
      queryBuilder.andWhere('wr.endDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('wr.startDate <= :endDate', { endDate });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
