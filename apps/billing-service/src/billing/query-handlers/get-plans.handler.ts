import { Injectable } from '@nestjs/common';
import { DataSource, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetPlansQuery } from '../queries/get-plans.query';
import { Plan } from '../entities/plan.entity';

@Injectable()
@QueryHandler(GetPlansQuery)
export class GetPlansHandler
  implements IQueryHandler<GetPlansQuery, Plan[]>
{
  constructor(private readonly dataSource: DataSource) {}

  async execute(query: GetPlansQuery): Promise<Plan[]> {
    const planRepo = this.dataSource.getRepository(Plan);

    const where: FindOptionsWhere<Plan> = {};

    if (query.publicOnly) {
      where.isActive = true;
      where.isPublic = true;
    }

    return planRepo.find({
      where,
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }
}
