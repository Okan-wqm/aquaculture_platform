import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import Decimal from 'decimal.js';
import { UpdatePlanCommand } from '../commands/update-plan.command';
import { Plan } from '../entities/plan.entity';

@Injectable()
@CommandHandler(UpdatePlanCommand)
export class UpdatePlanHandler
  implements ICommandHandler<UpdatePlanCommand, Plan>
{
  private readonly logger = new Logger(UpdatePlanHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdatePlanCommand): Promise<Plan> {
    const { planId, input, userId } = command;

    return await this.dataSource.transaction(async (manager) => {
      // Plan is the cross-tenant platform catalog (platform-admin CRUD).
      // eslint-disable-next-line no-restricted-syntax -- cross-tenant catalog
      const planRepo = manager.getRepository(Plan);

      // Fetch with pessimistic lock to prevent concurrent updates
      const plan = await planRepo.findOne({
        where: { id: planId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!plan) {
        throw new NotFoundException(`Plan with id ${planId} not found`);
      }

      // Optimistic concurrency check via version column
      if (plan.version !== input.expectedVersion) {
        throw new ConflictException(
          `Plan has been modified by another user. Expected version ${input.expectedVersion}, current version ${plan.version}. Please refresh and try again.`,
        );
      }

      // Check for duplicate name if name is being changed
      if (input.name && input.name.trim() !== plan.name) {
        const existingPlan = await planRepo.findOne({
          where: { name: input.name.trim() },
        });
        if (existingPlan && existingPlan.id !== planId) {
          throw new ConflictException(
            `A plan with name "${input.name.trim()}" already exists`,
          );
        }
        plan.name = input.name.trim();
      }

      // Apply partial updates — SAFETY: these changes only affect NEW subscriptions.
      // Existing subscriptions snapshot pricing/limits at creation time.
      if (input.tier !== undefined) plan.tier = input.tier;
      if (input.basePrice !== undefined) plan.basePrice = new Decimal(input.basePrice);
      if (input.currency !== undefined) plan.currency = input.currency;
      if (input.billingCycle !== undefined) plan.billingCycle = input.billingCycle;
      if (input.limits !== undefined) {
        plan.limits = {
          maxFarms: input.limits.maxFarms,
          maxPonds: input.limits.maxPonds,
          maxSensors: input.limits.maxSensors,
          maxUsers: input.limits.maxUsers,
          dataRetentionDays: input.limits.dataRetentionDays,
          alertsEnabled: input.limits.alertsEnabled,
          reportsEnabled: input.limits.reportsEnabled,
          apiAccessEnabled: input.limits.apiAccessEnabled,
          customIntegrationsEnabled: input.limits.customIntegrationsEnabled,
        };
      }
      if (input.pricing !== undefined) {
        plan.pricing = {
          basePrice: input.pricing.basePrice,
          perFarmPrice: input.pricing.perFarmPrice,
          perSensorPrice: input.pricing.perSensorPrice,
          perUserPrice: input.pricing.perUserPrice,
          currency: input.pricing.currency || plan.currency,
        };
        // Keep top-level basePrice in sync
        plan.basePrice = new Decimal(input.pricing.basePrice);
      }
      if (input.features !== undefined) {
        // ADR-0013: a flat GraphQL list carries no grouping, so it replaces
        // the core set and leaves the advanced/premium sets as authored.
        plan.features = {
          coreFeatures: input.features,
          advancedFeatures: plan.features?.advancedFeatures ?? [],
          premiumFeatures: plan.features?.premiumFeatures ?? [],
        };
      }
      if (input.isPublic !== undefined) plan.isPublic = input.isPublic;
      if (input.sortOrder !== undefined) plan.sortOrder = input.sortOrder;

      plan.updatedBy = userId;

      const savedPlan = await planRepo.save(plan);

      this.logger.log(
        `Plan updated: ${savedPlan.id} "${savedPlan.name}" to version ${savedPlan.version} by user ${userId}`,
      );

      return savedPlan;
    });
  }
}
