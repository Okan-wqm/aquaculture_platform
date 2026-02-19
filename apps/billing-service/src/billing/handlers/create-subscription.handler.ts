import { Injectable, ConflictException, Logger, InternalServerErrorException, Optional } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { RedisService } from '@aquaculture/backend-common';
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
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async execute(command: CreateSubscriptionCommand): Promise<Subscription> {
    const { tenantId, input, userId } = command;

    // Validate application-level inputs BEFORE acquiring a DB connection from the pool.
    // This avoids holding a connection during cheap validation logic, preventing pool
    // exhaustion under burst provisioning (LOW-004).
    if (input.pricing.basePrice < 0) {
      throw new ConflictException('Base price cannot be negative');
    }

    const startDate = input.startDate ? new Date(input.startDate) : new Date();
    if (isNaN(startDate.getTime())) {
      throw new ConflictException('Invalid start date');
    }

    if (input.trialDays && input.trialDays > 0 && input.trialDays > 30) {
      throw new ConflictException('Trial period cannot exceed 30 days');
    }

    // Create a query runner for transaction management
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const subscriptionRepo = queryRunner.manager.getRepository(Subscription);

      // Check for existing subscription with pessimistic lock to prevent race conditions
      const existingSubscription = await subscriptionRepo.findOne({
        where: { tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (existingSubscription) {
        if (existingSubscription.status !== SubscriptionStatus.CANCELLED) {
          throw new ConflictException(`Active subscription already exists for tenant ${tenantId}`);
        }
        // Delete the cancelled subscription so the unique index on tenantId
        // is not violated when the new row is inserted below.
        await subscriptionRepo.delete(existingSubscription.id);
      }

      const periodEnd = this.calculatePeriodEnd(startDate, input.billingCycle);

      // Handle trial period
      let status = SubscriptionStatus.ACTIVE;
      let trialEndDate: Date | undefined;

      if (input.trialDays && input.trialDays > 0) {
        // trialDays > 30 is already validated before the transaction starts
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

      // Invalidate subscription cache so the new subscription is immediately visible
      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => { /* non-fatal */ });
      }

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
    return this.addMonthsClamped(startDate, this.cycleToMonths(billingCycle));
  }

  private cycleToMonths(billingCycle: BillingCycle): number {
    switch (billingCycle) {
      case BillingCycle.MONTHLY:    return 1;
      case BillingCycle.QUARTERLY:  return 3;
      case BillingCycle.SEMI_ANNUAL: return 6;
      case BillingCycle.ANNUAL:     return 12;
    }
  }

  /**
   * Add months to a date, clamping the day to the last valid day of the target month.
   * Avoids the JS Date.setMonth() overflow bug (e.g. Jan 31 + 1 month → Mar 3).
   */
  private addMonthsClamped(date: Date, months: number): Date {
    const targetYear = date.getFullYear();
    const targetMonth = date.getMonth() + months;

    // Last day of the target month
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    const clampedDay = Math.min(date.getDate(), lastDay);

    const result = new Date(date);
    result.setFullYear(targetYear, targetMonth, clampedDay);
    return result;
  }
}
