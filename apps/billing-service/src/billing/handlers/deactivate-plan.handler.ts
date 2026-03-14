import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DeactivatePlanCommand } from '../commands/deactivate-plan.command';
import { Plan } from '../entities/plan.entity';

@Injectable()
@CommandHandler(DeactivatePlanCommand)
export class DeactivatePlanHandler
  implements ICommandHandler<DeactivatePlanCommand, Plan>
{
  private readonly logger = new Logger(DeactivatePlanHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeactivatePlanCommand): Promise<Plan> {
    const { planId, userId } = command;

    return await this.dataSource.transaction(async (manager) => {
      const planRepo = manager.getRepository(Plan);

      const plan = await planRepo.findOne({
        where: { id: planId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!plan) {
        throw new NotFoundException(`Plan with id ${planId} not found`);
      }

      if (!plan.isActive) {
        throw new BadRequestException(
          `Plan "${plan.name}" is already deactivated`,
        );
      }

      // SAFETY: We soft-deactivate instead of deleting.
      // Existing subscriptions that reference this plan tier/name continue to work.
      // The plan simply won't appear in public listings or be selectable for new subscriptions.
      plan.isActive = false;
      plan.isPublic = false;
      plan.updatedBy = userId;

      const savedPlan = await planRepo.save(plan);

      this.logger.log(
        `Plan deactivated: ${savedPlan.id} "${savedPlan.name}" by user ${userId}`,
      );

      return savedPlan;
    });
  }
}
