import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetOverdueGoalsQuery } from '../queries/get-overdue-goals.query';
import { Goal, GoalStatus } from '../entities/goal.entity';

@QueryHandler(GetOverdueGoalsQuery)
export class GetOverdueGoalsHandler implements IQueryHandler<GetOverdueGoalsQuery> {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
  ) {}

  async execute(query: GetOverdueGoalsQuery): Promise<Goal[]> {
    const { tenantId, departmentId } = query;

    const today = new Date();

    const qb = this.goalRepository
      .createQueryBuilder('g')
      .leftJoinAndSelect('g.employee', 'employee')
      .where('g.tenantId = :tenantId', { tenantId })
      .andWhere('g.isDeleted = false')
      .andWhere('g.status IN (:...activeStatuses)', {
        activeStatuses: [GoalStatus.NOT_STARTED, GoalStatus.IN_PROGRESS],
      })
      .andWhere('g.targetDate < :today', { today: today.toISOString().split('T')[0] })
      .orderBy('g.targetDate', 'ASC');

    if (departmentId) {
      qb.andWhere('employee.departmentHrId = :departmentId', { departmentId });
    }

    const goals = await qb.getMany();

    // Calculate daysOverdue for each goal
    return goals.map((goal) => {
      const targetDate = new Date(goal.targetDate);
      const diffTime = today.getTime() - targetDate.getTime();
      goal.daysOverdue = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return goal;
    });
  }
}
