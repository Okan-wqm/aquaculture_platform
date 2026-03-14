import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetPlanByIdQuery } from '../queries/get-plan-by-id.query';
import { Plan } from '../entities/plan.entity';

@Injectable()
@QueryHandler(GetPlanByIdQuery)
export class GetPlanByIdHandler
  implements IQueryHandler<GetPlanByIdQuery, Plan | null>
{
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetPlanByIdQuery): Promise<Plan | null> {
    const planRepo = this.dataSource.getRepository(Plan);

    return planRepo.findOne({
      where: { id: query.planId },
    });
  }
}
