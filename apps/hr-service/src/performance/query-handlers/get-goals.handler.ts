import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetGoalsQuery } from '../queries/get-goals.query';
import { Goal } from '../entities/goal.entity';

export interface PaginatedGoals {
  items: Goal[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetGoalsQuery)
export class GetGoalsHandler implements IQueryHandler<GetGoalsQuery> {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
  ) {}

  async execute(query: GetGoalsQuery): Promise<PaginatedGoals> {
    const { tenantId, employeeId, status } = query;

    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const offset = Math.max(query.offset || 0, 0);

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

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }
}
