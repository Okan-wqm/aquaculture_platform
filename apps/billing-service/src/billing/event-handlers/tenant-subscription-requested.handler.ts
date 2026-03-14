import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { EventsHandler, IEventHandler, CommandBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent, SubscriptionProvisioningFailedEvent } from '@platform/event-contracts';
import { CreateSubscriptionCommand } from '../commands/create-subscription.command';
import { SubscriptionStatus, BillingCycle, PlanTier } from '../entities/subscription.entity';
import { SubscriptionModuleItem } from '../entities/subscription-module-item.entity';

// UUID v4 regex — matches the same pattern used throughout the billing service
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Module quantity configuration for subscription pricing
 */
interface ModuleQuantityConfig {
  moduleId: string;
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
}

/**
 * Event class for @EventsHandler registration.
 *
 * Flat structure matching the canonical TenantSubscriptionRequestedEvent
 * contract from @platform/event-contracts.
 *
 * Backward compatibility: the handler also supports a legacy `payload`
 * wrapper so that in-flight events serialised with the old shape are
 * still processed correctly.
 */
export class TenantSubscriptionRequestedEvent {
  eventType!: 'TenantSubscriptionRequested';
  timestamp!: Date;

  // Flat fields (canonical contract)
  tenantId!: string;
  tenantName!: string;
  moduleIds!: string[];
  moduleQuantities?: ModuleQuantityConfig[];
  trialDays?: number;
  tier!: string;
  billingCycle!: string;
  billingEmail?: string;
  createdBy!: string;

  // Legacy nested payload (backward compat)
  payload?: {
    tenantId: string;
    tenantName: string;
    moduleIds: string[];
    moduleQuantities?: ModuleQuantityConfig[];
    trialDays?: number;
    tier: string;
    billingCycle: string;
    billingEmail?: string;
    createdBy: string;
  };
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
@EventsHandler(TenantSubscriptionRequestedEvent)
export class TenantSubscriptionRequestedHandler
  implements IEventHandler<TenantSubscriptionRequestedEvent>
{
  private readonly logger = new Logger(TenantSubscriptionRequestedHandler.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly dataSource: DataSource,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
  ) {}

  async handle(event: TenantSubscriptionRequestedEvent): Promise<void> {
    // Verify this is the correct event type
    if (event.eventType !== 'TenantSubscriptionRequested') {
      return;
    }

    // Backward compatibility: support both flat events (canonical contract)
    // and legacy nested-payload events.  Flat fields take precedence.
    const tenantId = event.tenantId || event.payload?.tenantId;
    const tenantName = event.tenantName || event.payload?.tenantName;
    const moduleIds = event.moduleIds || event.payload?.moduleIds || [];
    const moduleQuantities = event.moduleQuantities || event.payload?.moduleQuantities;
    const trialDays = event.trialDays ?? event.payload?.trialDays;
    const tier = event.tier || event.payload?.tier;
    const billingCycle = event.billingCycle || event.payload?.billingCycle;
    const billingEmail = event.billingEmail || event.payload?.billingEmail;
    const createdBy = event.createdBy || event.payload?.createdBy;

    this.logger.log(`Processing subscription request for tenant ${tenantId}`);

    // SECURITY: Validate tenantId is a proper UUID before any DB operation
    if (!tenantId || !UUID_REGEX.test(tenantId)) {
      this.logger.error(`Invalid tenantId in NATS payload: ${tenantId}`);
      return;
    }

    // SECURITY: Validate all moduleIds are valid UUIDs before any DB operation.
    // moduleIds arrive from an untrusted NATS event payload; a malformed value could
    // cause DoS-style errors or information leakage via DB error messages.
    if (moduleIds && moduleIds.length > 0) {
      const invalidIds = moduleIds.filter((id) => !UUID_REGEX.test(id));
      if (invalidIds.length > 0) {
        this.logger.error(
          `Invalid moduleId(s) in NATS payload for tenant ${tenantId}: ${invalidIds.join(', ')}`,
        );
        await this.publishProvisioningFailed(tenantId, 'Invalid moduleId format in event payload', moduleIds);
        return;
      }
    }

    // Validate required tier field
    if (!tier) {
      this.logger.error(`Missing tier in NATS payload for tenant ${tenantId}`);
      await this.publishProvisioningFailed(tenantId, 'Missing tier in event payload');
      return;
    }

    try {
      // Map tier string to PlanTier enum
      const planTier = this.mapToPlanTier(tier);

      // Map billing cycle string to BillingCycle enum
      const mappedBillingCycle = this.mapToBillingCycle(billingCycle || 'monthly');

      // Get default limits and pricing for tier
      const tierKey = tier.toLowerCase();
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
      if (moduleIds && moduleIds.length > 0) {
        // Add per-module pricing
        const moduleCount = moduleIds.length;
        // Each module adds to base price
        calculatedBasePrice += moduleCount * 25; // $25 per module base

        // Add quantity-based pricing
        if (moduleQuantities) {
          for (const mq of moduleQuantities) {
            if (mq.farms) calculatedBasePrice += mq.farms * pricing.perFarmPrice;
            if (mq.sensors) calculatedBasePrice += mq.sensors * pricing.perSensorPrice;
            if (mq.users) calculatedBasePrice += mq.users * pricing.perUserPrice;
          }
        }
      }

      // Create subscription command input
      const subscriptionInput = {
        planTier,
        planName: `${this.capitalizeFirst(tier)} Plan`,
        billingCycle: mappedBillingCycle,
        trialDays: trialDays || 14, // Default 14-day trial
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
          tenantId,
          subscriptionInput,
          createdBy || 'system',
        ),
      );

      this.logger.log(
        `Subscription ${subscription.id} created for tenant ${tenantId} with tier ${planTier}`,
      );

      // Create subscription module items if modules were assigned
      if (moduleIds && moduleIds.length > 0) {
        await this.createSubscriptionModuleItems(
          subscription.id,
          tenantId,
          moduleIds,
          moduleQuantities,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to create subscription for tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // MED-05: Publish a failure event so admin-api-service or alerting can detect and
      // remediate the orphaned tenant (a tenant with no subscription has no plan limits).
      await this.publishProvisioningFailed(tenantId, (error as Error).message, moduleIds, tier);
      // Don't re-throw — we don't want to fail the entire tenant creation flow.
      // The subscription can be created manually; the failure event signals the discrepancy.
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
    const moduleItemRepo = this.dataSource.getRepository(SubscriptionModuleItem);

    try {
      // Batch-fetch all module info in one query instead of N sequential queries
      const moduleInfoRows: Array<{ id: string; code: string; name: string }> =
        await this.dataSource.query(
          `SELECT id, code, name FROM modules WHERE id = ANY($1)`,
          [moduleIds],
        );
      const moduleMap = new Map(moduleInfoRows.map((m) => [m.id, m]));

      // Build all upsert payloads and batch-insert in one call
      const upsertPayloads = moduleIds.map((moduleId) => {
        const quantities = moduleQuantities?.find((mq) => mq.moduleId === moduleId);
        const info = moduleMap.get(moduleId);
        const moduleCode = info?.code || 'unknown';
        const moduleName = info?.name || 'Unknown Module';

        const baseModulePrice = 25; // $25 base per module
        const quantityPrice =
          (quantities?.farms || 0) * 10 +
          (quantities?.sensors || 0) * 2 +
          (quantities?.users || 0) * 5;
        const monthlyPrice = baseModulePrice + quantityPrice;

        return {
          subscriptionId,
          moduleId,
          moduleCode,
          moduleName,
          quantities: quantities || {},
          lineItems: [] as never[],
          subtotal: monthlyPrice,
          discountAmount: 0,
          total: monthlyPrice,
          currency: 'USD',
        };
      });

      // Single batch upsert for all module items
      await moduleItemRepo.upsert(upsertPayloads, {
        conflictPaths: ['subscriptionId', 'moduleId'],
      });

      this.logger.log(
        `Created ${moduleIds.length} subscription module items for subscription ${subscriptionId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to create subscription module items for subscription ${subscriptionId}: ${(error as Error).message}`,
        (error as Error).stack,
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

  /**
   * Publish a SubscriptionProvisioningFailed event via NATS.
   * Errors are caught and logged — a failure to publish must never mask the original error.
   */
  private async publishProvisioningFailed(
    tenantId: string,
    error: string,
    moduleIds?: string[],
    tier?: string,
  ): Promise<void> {
    try {
      const event: SubscriptionProvisioningFailedEvent = {
        ...createBaseEvent<SubscriptionProvisioningFailedEvent>(
          'SubscriptionProvisioningFailed',
          tenantId,
        ),
        error,
        tier: tier as SubscriptionProvisioningFailedEvent['tier'],
        moduleIds,
      };
      await this.eventBus?.publish(event);
    } catch (publishError) {
      this.logger.warn(
        `Failed to publish SubscriptionProvisioningFailed event for tenant ${tenantId}: ${
          publishError instanceof Error ? publishError.message : 'Unknown error'
        }`,
      );
    }
  }
}
