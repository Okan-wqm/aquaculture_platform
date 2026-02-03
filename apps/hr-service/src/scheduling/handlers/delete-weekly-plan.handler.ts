import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DeleteWeeklyPlanCommand } from '../commands/delete-weekly-plan.command';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';

@CommandHandler(DeleteWeeklyPlanCommand)
export class DeleteWeeklyPlanHandler implements ICommandHandler<DeleteWeeklyPlanCommand> {
  private readonly logger = new Logger(DeleteWeeklyPlanHandler.name);

  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
  ) {}

  async execute(command: DeleteWeeklyPlanCommand): Promise<boolean> {
    const { tenantId, userId, weeklyPlanId } = command;

    const plan = await this.planRepository.findOne({
      where: { id: weeklyPlanId, tenantId, isDeleted: false },
    });

    if (!plan) {
      throw new NotFoundException(`Weekly plan with ID ${weeklyPlanId} not found`);
    }

    if (plan.status === WeeklyPlanStatus.PUBLISHED) {
      throw new BadRequestException('Cannot delete a published plan');
    }

    // Soft delete
    plan.isDeleted = true;
    plan.deletedAt = new Date();
    plan.updatedBy = userId;

    await this.planRepository.save(plan);

    return true;
  }
}
