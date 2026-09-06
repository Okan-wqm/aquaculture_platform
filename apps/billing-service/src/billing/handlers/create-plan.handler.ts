import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreatePlanCommand } from '../commands/create-plan.command';
import { Plan } from '../entities/plan.entity';
import { BillingCycle } from '../entities/subscription.entity';

@Injectable()
@CommandHandler(CreatePlanCommand)
export class CreatePlanHandler
  implements ICommandHandler<CreatePlanCommand, Plan>
{
  private readonly logger = new Logger(CreatePlanHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CreatePlanCommand): Promise<Plan> {
    const { input, userId } = command;

    // Validate base price matches pricing.basePrice for consistency
    if (input.pricing.basePrice !== input.basePrice) {
      throw new ConflictException(
        'basePrice and pricing.basePrice must match',
      );
    }

    return await this.dataSource.transaction(async (manager) => {
      // Plan is the cross-tenant platform catalog (platform-admin CRUD).
      // eslint-disable-next-line no-restricted-syntax -- cross-tenant catalog
      const planRepo = manager.getRepository(Plan);

      // Check for duplicate plan name
      const existingPlan = await planRepo.findOne({
        where: { name: input.name.trim() },
      });

      if (existingPlan) {
        throw new ConflictException(
          `A plan with name "${input.name.trim()}" already exists`,
        );
      }

      const plan = planRepo.create({
        name: input.name.trim(),
        tier: input.tier,
        basePrice: input.basePrice,
        currency: input.currency || 'USD',
        billingCycle: input.billingCycle || BillingCycle.MONTHLY,
        limits: {
          maxFarms: input.limits.maxFarms,
          maxPonds: input.limits.maxPonds,
          maxSensors: input.limits.maxSensors,
          maxUsers: input.limits.maxUsers,
          dataRetentionDays: input.limits.dataRetentionDays,
          alertsEnabled: input.limits.alertsEnabled,
          reportsEnabled: input.limits.reportsEnabled,
          apiAccessEnabled: input.limits.apiAccessEnabled,
          customIntegrationsEnabled: input.limits.customIntegrationsEnabled,
        },
        pricing: {
          basePrice: input.pricing.basePrice,
          perFarmPrice: input.pricing.perFarmPrice,
          perSensorPrice: input.pricing.perSensorPrice,
          perUserPrice: input.pricing.perUserPrice,
          currency: input.pricing.currency || 'USD',
        },
        // ADR-0013: `features` became grouped when admin.plan_definitions
        // merged in. A flat GraphQL list has no grouping, so it is all core.
        features: {
          coreFeatures: input.features ?? [],
          advancedFeatures: [],
          premiumFeatures: [],
        },
        isActive: true,
        isPublic: input.isPublic !== false,
        sortOrder: input.sortOrder || 0,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedPlan = await planRepo.save(plan);

      this.logger.log(
        `Plan created: ${savedPlan.id} "${savedPlan.name}" (${savedPlan.tier}) by user ${userId}`,
      );

      return savedPlan;
    });
  }
}
