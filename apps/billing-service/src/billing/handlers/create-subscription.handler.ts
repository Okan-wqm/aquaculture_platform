import { Injectable, ConflictException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateSubscriptionCommand } from '../commands/create-subscription.command';
import { Subscription, SubscriptionStatus, BillingCycle } from '../entities/subscription.entity';

@Injectable()
@CommandHandler(CreateSubscriptionCommand)
export class CreateSubscriptionHandler
  implements ICommandHandler<CreateSubscriptionCommand, Subscription>
{
  private readonly logger = new Logger(CreateSubscriptionHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateSubscriptionCommand): Promise<Subscription> {
    const { tenantId, input, userId } = command;

    // Create a query runner for transaction management
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const subscriptionRepo = queryRunner.manager.getRepository(Subscription);

      // Check for existing active subscription with pessimistic lock
      const existingSubscription = await subscriptionRepo.findOne({
        where: { tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (existingSubscription && existingSubscription.status !== SubscriptionStatus.CANCELLED) {
        throw new ConflictException(`Active subscription already exists for tenant ${tenantId}`);
      }

      // Validate input
      if (input.pricing.basePrice < 0) {
        throw new ConflictException('Base price cannot be negative');
      }

      const startDate = input.startDate ? new Date(input.startDate) : new Date();

      if (isNaN(startDate.getTime())) {
        throw new ConflictException('Invalid start date');
      }

      const periodEnd = this.calculatePeriodEnd(startDate, input.billingCycle);

      // Handle trial period
      let status = SubscriptionStatus.ACTIVE;
      let trialEndDate: Date | undefined;

      if (input.trialDays && input.trialDays > 0) {
        if (input.trialDays > 30) {
          throw new ConflictException('Trial period cannot exceed 30 days');
        }
        status = SubscriptionStatus.TRIAL;
        trialEndDate = new Date(startDate);
        trialEndDate.setDate(trialEndDate.getDate() + input.trialDays);
      }

      const subscription = subscriptionRepo.create({
        tenantId,
        planTier: input.planTier,
        planName: input.planName.trim(),
        status,
        billingCycle: input.billingCycle,
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
        startDate,
        currentPeriodStart: startDate,
        currentPeriodEnd: periodEnd,
        trialEndDate,
        autoRenew: input.autoRenew !== false,
        stripeCustomerId: input.stripeCustomerId,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedSubscription = await subscriptionRepo.save(subscription);

      // Commit transaction
      await queryRunner.commitTransaction();

      this.logger.log(
        `Subscription created: ${savedSubscription.id} for tenant ${tenantId} with plan ${input.planTier} by user ${userId}`,
      );

      return savedSubscription;
    } catch (error) {
      // Rollback transaction on error
      await queryRunner.rollbackTransaction();

      if (error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        `Failed to create subscription for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create subscription');
    } finally {
      // Release the query runner
      await queryRunner.release();
    }
  }

  private calculatePeriodEnd(startDate: Date, billingCycle: BillingCycle): Date {
    const endDate = new Date(startDate);

    switch (billingCycle) {
      case BillingCycle.MONTHLY:
        endDate.setMonth(endDate.getMonth() + 1);
        break;
      case BillingCycle.QUARTERLY:
        endDate.setMonth(endDate.getMonth() + 3);
        break;
      case BillingCycle.SEMI_ANNUAL:
        endDate.setMonth(endDate.getMonth() + 6);
        break;
      case BillingCycle.ANNUAL:
        endDate.setFullYear(endDate.getFullYear() + 1);
        break;
    }

    return endDate;
  }
}
