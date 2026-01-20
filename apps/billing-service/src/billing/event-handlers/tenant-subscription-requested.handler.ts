import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler, CommandBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { CreateSubscriptionCommand } from '../commands/create-subscription.command';
import { SubscriptionStatus, BillingCycle, PlanTier } from '../entities/subscription.entity';

/**
 * Event payload structure for TenantSubscriptionRequested
 */
interface TenantSubscriptionRequestedPayload {
  tenantId: string;
  tenantName: string;
  moduleIds: string[];
  moduleQuantities?: Array<{
    moduleId: string;
    users?: number;
    farms?: number;
    ponds?: number;
    sensors?: number;
    employees?: number;
  }>;
  trialDays?: number;
  tier: string;
  billingCycle: string;
  billingEmail?: string;
  createdBy: string;
}

/**
 * Event structure
 */
interface TenantSubscriptionRequestedEvent {
  eventType: 'TenantSubscriptionRequested';
  payload: TenantSubscriptionRequestedPayload;
  timestamp: Date;
}

/**
 * Default plan limits by tier
 */
const DEFAULT_LIMITS: Record<string, {
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxUsers: number;
  dataRetentionDays: number;
  alertsEnabled: boolean;
  reportsEnabled: boolean;
  apiAccessEnabled: boolean;
  customIntegrationsEnabled: boolean;
}> = {
  starter: {
    maxFarms: 3,
    maxPonds: 30,
    maxSensors: 20,
    maxUsers: 5,
    dataRetentionDays: 90,
    alertsEnabled: true,
    reportsEnabled: false,
    apiAccessEnabled: false,
    customIntegrationsEnabled: false,
  },
  professional: {
    maxFarms: 10,
    maxPonds: 100,
    maxSensors: 100,
    maxUsers: 25,
    dataRetentionDays: 365,
    alertsEnabled: true,
    reportsEnabled: true,
    apiAccessEnabled: true,
    customIntegrationsEnabled: false,
  },
  enterprise: {
    maxFarms: -1, // unlimited
    maxPonds: -1,
    maxSensors: -1,
    maxUsers: -1,
    dataRetentionDays: 730,
    alertsEnabled: true,
    reportsEnabled: true,
    apiAccessEnabled: true,
    customIntegrationsEnabled: true,
  },
};

/**
 * Default pricing by tier (monthly base price)
 */
const DEFAULT_PRICING: Record<string, {
  basePrice: number;
  perFarmPrice: number;
  perSensorPrice: number;
  perUserPrice: number;
}> = {
  starter: {
    basePrice: 49,
    perFarmPrice: 10,
    perSensorPrice: 2,
    perUserPrice: 5,
  },
  professional: {
    basePrice: 149,
    perFarmPrice: 15,
    perSensorPrice: 3,
    perUserPrice: 8,
  },
  enterprise: {
    basePrice: 499,
    perFarmPrice: 20,
    perSensorPrice: 5,
    perUserPrice: 10,
  },
};

/**
 * Tenant Subscription Requested Event Handler
 *
 * Listens for TenantSubscriptionRequested events and creates subscriptions
 * for newly created tenants.
 */
@Injectable()
@EventsHandler()
export class TenantSubscriptionRequestedHandler
  implements IEventHandler<TenantSubscriptionRequestedEvent>
{
  private readonly logger = new Logger(TenantSubscriptionRequestedHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly dataSource: DataSource,
  ) {}

  async handle(event: TenantSubscriptionRequestedEvent): Promise<void> {
    // Verify this is the correct event type
    if (event.eventType !== 'TenantSubscriptionRequested') {
      return;
    }

    const { payload } = event;
    this.logger.log(`Processing subscription request for tenant ${payload.tenantId}`);

    try {
      // Map tier string to PlanTier enum
      const planTier = this.mapToPlanTier(payload.tier);

      // Map billing cycle string to BillingCycle enum
      const billingCycle = this.mapToBillingCycle(payload.billingCycle);

      // Get default limits and pricing for tier
      const tierKey = payload.tier.toLowerCase();
      const limits = DEFAULT_LIMITS[tierKey] ?? {
        maxFarms: 3,
        maxPonds: 30,
        maxSensors: 20,
        maxUsers: 5,
        dataRetentionDays: 90,
        alertsEnabled: true,
        reportsEnabled: false,
        apiAccessEnabled: false,
        customIntegrationsEnabled: false,
      };
      const pricing = DEFAULT_PRICING[tierKey] ?? {
        basePrice: 49,
        perFarmPrice: 10,
        perSensorPrice: 2,
        perUserPrice: 5,
      };

      // Calculate total based on module quantities if provided
      let calculatedBasePrice = pricing.basePrice;
      if (payload.moduleIds && payload.moduleIds.length > 0) {
        // Add per-module pricing
        const moduleCount = payload.moduleIds.length;
        // Each module adds to base price
        calculatedBasePrice += moduleCount * 25; // $25 per module base

        // Add quantity-based pricing
        if (payload.moduleQuantities) {
          for (const mq of payload.moduleQuantities) {
            if (mq.farms) calculatedBasePrice += mq.farms * pricing.perFarmPrice;
            if (mq.sensors) calculatedBasePrice += mq.sensors * pricing.perSensorPrice;
            if (mq.users) calculatedBasePrice += mq.users * pricing.perUserPrice;
          }
        }
      }

      // Create subscription command input
      const subscriptionInput = {
        planTier,
        planName: `${this.capitalizeFirst(payload.tier)} Plan`,
        billingCycle,
        trialDays: payload.trialDays || 14, // Default 14-day trial
        limits: {
          maxFarms: limits.maxFarms,
          maxPonds: limits.maxPonds,
          maxSensors: limits.maxSensors,
          maxUsers: limits.maxUsers,
          dataRetentionDays: limits.dataRetentionDays,
          alertsEnabled: limits.alertsEnabled,
          reportsEnabled: limits.reportsEnabled,
          apiAccessEnabled: limits.apiAccessEnabled,
          customIntegrationsEnabled: limits.customIntegrationsEnabled,
        },
        pricing: {
          basePrice: calculatedBasePrice,
          perFarmPrice: pricing.perFarmPrice,
          perSensorPrice: pricing.perSensorPrice,
          perUserPrice: pricing.perUserPrice,
          currency: 'USD',
        },
        autoRenew: true,
        startDate: new Date().toISOString(),
      };

      // Execute create subscription command
      const subscription = await this.commandBus.execute(
        new CreateSubscriptionCommand(
          payload.tenantId,
          subscriptionInput,
          payload.createdBy || 'system',
        ),
      );

      this.logger.log(
        `Subscription ${subscription.id} created for tenant ${payload.tenantId} with tier ${planTier}`,
      );

      // Create subscription module items if modules were assigned
      if (payload.moduleIds && payload.moduleIds.length > 0) {
        await this.createSubscriptionModuleItems(
          subscription.id,
          payload.tenantId,
          payload.moduleIds,
          payload.moduleQuantities,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to create subscription for tenant ${payload.tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // Don't throw - we don't want to fail the entire tenant creation
      // The subscription can be created manually if needed
    }
  }

  /**
   * Create subscription module items to track which modules are in the subscription
   */
  private async createSubscriptionModuleItems(
    subscriptionId: string,
    tenantId: string,
    moduleIds: string[],
    moduleQuantities?: Array<{
      moduleId: string;
      users?: number;
      farms?: number;
      ponds?: number;
      sensors?: number;
    }>,
  ): Promise<void> {
    try {
      for (const moduleId of moduleIds) {
        const quantities = moduleQuantities?.find((mq) => mq.moduleId === moduleId);

        // Get module info
        const moduleInfo = await this.dataSource.query(
          `SELECT code, name FROM modules WHERE id = $1`,
          [moduleId],
        );

        const moduleCode = moduleInfo[0]?.code || 'unknown';
        const moduleName = moduleInfo[0]?.name || 'Unknown Module';

        // Calculate module price (simplified)
        const baseModulePrice = 25; // $25 base per module
        const quantityPrice =
          (quantities?.farms || 0) * 10 +
          (quantities?.sensors || 0) * 2 +
          (quantities?.users || 0) * 5;
        const monthlyPrice = baseModulePrice + quantityPrice;

        await this.dataSource.query(
          `
          INSERT INTO subscription_module_items (
            id, subscription_id, module_id, module_code, module_name,
            monthly_price, quantities, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), NOW()
          )
          ON CONFLICT (subscription_id, module_id) DO UPDATE SET
            monthly_price = $5,
            quantities = $6,
            updated_at = NOW()
          `,
          [
            subscriptionId,
            moduleId,
            moduleCode,
            moduleName,
            monthlyPrice,
            JSON.stringify(quantities || {}),
          ],
        );
      }

      this.logger.log(
        `Created ${moduleIds.length} subscription module items for subscription ${subscriptionId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to create subscription module items: ${(error as Error).message}`,
      );
    }
  }

  private mapToPlanTier(tier: string): PlanTier {
    const tierMap: Record<string, PlanTier> = {
      starter: PlanTier.STARTER,
      professional: PlanTier.PROFESSIONAL,
      enterprise: PlanTier.ENTERPRISE,
      custom: PlanTier.CUSTOM,
    };
    return tierMap[tier.toLowerCase()] || PlanTier.STARTER;
  }

  private mapToBillingCycle(cycle: string): BillingCycle {
    const cycleMap: Record<string, BillingCycle> = {
      monthly: BillingCycle.MONTHLY,
      quarterly: BillingCycle.QUARTERLY,
      semi_annual: BillingCycle.SEMI_ANNUAL,
      annual: BillingCycle.ANNUAL,
    };
    return cycleMap[cycle.toLowerCase()] || BillingCycle.MONTHLY;
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }
}
