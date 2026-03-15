import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetMyGoalsQuery } from '../queries/get-my-goals.query';
import { Goal } from '../entities/goal.entity';

@QueryHandler(GetMyGoalsQuery)
export class GetMyGoalsHandler implements IQueryHandler<GetMyGoalsQuery> {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
  ) {}

  async execute(query: GetMyGoalsQuery): Promise<Goal[]> {
    const { tenantId, userId, status } = query;

    const qb = this.goalRepository
      .createQueryBuilder('g')
      .leftJoinAndSelect('g.employee', 'employee')
      .where('g.tenantId = :tenantId', { tenantId })
      .andWhere('g.employeeId = :userId', { userId })
      .andWhere('g.isDeleted = false')
      .orderBy('g.targetDate', 'ASC');

    if (status) {
      qb.andWhere('g.status = :status', { status });
    }

    return qb.getMany();
  }
}
