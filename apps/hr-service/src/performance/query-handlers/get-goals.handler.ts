import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetGoalsQuery } from '../queries/get-goals.query';
import { Goal } from '../entities/goal.entity';

@QueryHandler(GetGoalsQuery)
export class GetGoalsHandler implements IQueryHandler<GetGoalsQuery> {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
  ) {}

  async execute(query: GetGoalsQuery): Promise<PaginatedQueryResult<Goal>> {
    const { tenantId, employeeId, status } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const qb = this.goalRepository
      .createQueryBuilder('g')
      .leftJoinAndSelect('g.employee', 'employee')
      .where('g.tenantId = :tenantId', { tenantId })
      .andWhere('g.isDeleted = false')
      .orderBy('g.targetDate', 'ASC')
      .addOrderBy('g.priority', 'DESC');

    if (employeeId) {
      qb.andWhere('g.employeeId = :employeeId', { employeeId });
    }

    if (status) {
      qb.andWhere('g.status = :status', { status });
    }

    const [items, total] = await qb
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
