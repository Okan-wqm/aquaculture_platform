import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetWeeklyPlanQuery } from '../queries/get-weekly-plan.query';
import { WeeklyPlan } from '../entities/weekly-plan.entity';

@QueryHandler(GetWeeklyPlanQuery)
export class GetWeeklyPlanHandler implements IQueryHandler<GetWeeklyPlanQuery> {
  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
  ) {}

  async execute(query: GetWeeklyPlanQuery): Promise<WeeklyPlan> {
    const { tenantId, weeklyPlanId } = query;

    const plan = await this.planRepository.findOne({
      where: { id: weeklyPlanId, tenantId, isDeleted: false },
      relations: ['entries', 'entries.shift', 'entries.leaveRequest', 'employee'],
      order: {
        entries: {
          displayOrder: 'ASC',
        },
      },
    });

    if (!plan) {
      throw new NotFoundException(`Weekly plan with ID ${weeklyPlanId} not found`);
    }

    return plan;
  }
}
