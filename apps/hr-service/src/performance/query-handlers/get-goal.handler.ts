import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetGoalQuery } from '../queries/get-goal.query';
import { Goal } from '../entities/goal.entity';

@QueryHandler(GetGoalQuery)
export class GetGoalHandler implements IQueryHandler<GetGoalQuery> {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
  ) {}

  async execute(query: GetGoalQuery): Promise<Goal> {
    const { tenantId, id } = query;

    const goal = await this.goalRepository.findOne({
      where: { id, tenantId, isDeleted: false },
      relations: ['employee', 'parentGoal', 'childGoals'],
    });

    if (!goal) {
      throw new NotFoundException(`Goal with ID ${id} not found`);
    }

    return goal;
  }
}
