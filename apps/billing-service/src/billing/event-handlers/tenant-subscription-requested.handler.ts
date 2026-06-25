import { TenantScopedRepository } from '@aquaculture/backend-common/database';
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { EventsHandler, IEventHandler, CommandBus } from '@nestjs/cqrs';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { EventHandler, NatsEventBus } from '@platform/event-bus';
import {
  createBaseEvent,
  SubscriptionProvisioningFailedEvent,
  TenantPlan,
  toTenantPlan,
} from '@platform/event-contracts';
import { DataSource, Repository } from 'typeorm';

import { CreateSubscriptionCommand } from '../commands/create-subscription.command';
import { Plan } from '../entities/plan.entity';
import { SubscriptionModuleItem } from '../entities/subscription-module-item.entity';
import { SubscriptionStatus, BillingCycle, PlanTier, PlanLimits } from '../entities/subscription.entity';
import { billingPlanLimitsFor } from '../plan-limits.util';
// WHY type-only: the runtime Subscription class is loaded via dynamic
// import() further down to avoid a module-load cycle; the static type
// reference here has no runtime footprint.
import type { Subscription } from '../entities/subscription.entity';

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
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
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

// Plan limits are no longer hand-copied here. The Plan entity (DB) is read
// first; when absent, limits fall back to the canonical PLAN_CATALOG SSoT via
// billingPlanLimitsFor() (see usage below). Pricing remains tier-defaulted
// locally — it is not a plan *limit* and is out of the PLAN_CATALOG scope.

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
 * Maximum number of retry attempts before an event is dead-lettered.
 */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Base delay between retries (30 seconds). Actual delay = base * 2^retryCount.
 */
const RETRY_BASE_DELAY_MS = 30_000;

/**
 * Tenant Subscription Requested Event Handler
 *
 * Listens for TenantSubscriptionRequested events and creates subscriptions
 * for newly created tenants.
 *
 * Retry architecture:
 * - On failure, the event payload is persisted to billing.subscription_provisioning_retries.
 * - A scheduled cron job (every 2 minutes) picks up due retries with exponential backoff.
 * - After MAX_RETRY_ATTEMPTS, the event is dead-lettered (status='dead_letter') and a
 *   SubscriptionProvisioningFailed event is published for admin alerting.
 */
@Injectable()
@EventsHandler(TenantSubscriptionRequestedEvent)
@EventHandler('TenantSubscriptionRequested')
export class TenantSubscriptionRequestedHandler
  implements IEventHandler<TenantSubscriptionRequestedEvent>
{
  private readonly logger = new Logger(TenantSubscriptionRequestedHandler.name);
  private retryTableEnsured = false;

  constructor(
    private readonly commandBus: CommandBus,
    private readonly dataSource: DataSource,
    @InjectRepository(Plan)
    private readonly planRepository: Repository<Plan>,
    @InjectRepository(SubscriptionModuleItem)
    private readonly subscriptionModuleItemRepository: Repository<SubscriptionModuleItem>,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
  ) {}

  async handle(
    event: TenantSubscriptionRequestedEvent,
    options: { persistFailure?: boolean } = {},
  ): Promise<void> {
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

      // Try to fetch plan from the database first; fall back to hardcoded defaults
      // if no Plan entity exists for this tier yet (backward compatibility).
      const tierKey = tier.toLowerCase();
      let limits: PlanLimits;
      let pricing: typeof DEFAULT_PRICING[string];
      let resolvedPlanId: string | undefined;

      const planEntity = await this.planRepository.findOne({
        where: { tier: planTier, isActive: true },
        order: { sortOrder: 'ASC' },
      });

      if (planEntity) {
        resolvedPlanId = planEntity.id;
        limits = {
          maxFarms: planEntity.limits.maxFarms,
          maxPonds: planEntity.limits.maxPonds,
          maxSensors: planEntity.limits.maxSensors,
          maxUsers: planEntity.limits.maxUsers,
          dataRetentionDays: planEntity.limits.dataRetentionDays,
          alertsEnabled: planEntity.limits.alertsEnabled,
          reportsEnabled: planEntity.limits.reportsEnabled,
          apiAccessEnabled: planEntity.limits.apiAccessEnabled,
          customIntegrationsEnabled: planEntity.limits.customIntegrationsEnabled,
        };
        pricing = {
          basePrice: Number(planEntity.pricing.basePrice),
          perFarmPrice: Number(planEntity.pricing.perFarmPrice) || 0,
          perSensorPrice: Number(planEntity.pricing.perSensorPrice) || 0,
          perUserPrice: Number(planEntity.pricing.perUserPrice) || 0,
        };
        this.logger.log(
          `Using Plan entity "${planEntity.name}" (${planEntity.id}) for tier ${tier}`,
        );
      } else {
        // No Plan row yet — fall back to the canonical PLAN_CATALOG SSoT
        // (unknown tier → STARTER), never a locally hand-copied table.
        limits = billingPlanLimitsFor(toTenantPlan(tierKey) ?? TenantPlan.STARTER);
        pricing = DEFAULT_PRICING[tierKey] ?? {
          basePrice: 49,
          perFarmPrice: 10,
          perSensorPrice: 2,
          perUserPrice: 5,
        };
        this.logger.warn(
          `No Plan entity found for tier ${tier}, using hardcoded defaults`,
        );
      }

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
        planName: planEntity?.name || `${this.capitalizeFirst(tier)} Plan`,
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
      const subscription = await this.commandBus.execute<CreateSubscriptionCommand, Subscription>(
        new CreateSubscriptionCommand(
          tenantId,
          subscriptionInput,
          createdBy || 'system',
        ),
      );

      // Link the subscription to the Plan entity if one was resolved
      if (resolvedPlanId) {
        const { Subscription } = await import('../entities/subscription.entity');
        await TenantScopedRepository.create(this.dataSource, Subscription, tenantId).update(
          { id: subscription.id },
          { planId: resolvedPlanId },
        );
        subscription.planId = resolvedPlanId;
      }

      this.logger.log(
        `Subscription ${subscription.id} created for tenant ${tenantId} with tier ${planTier}` +
        (resolvedPlanId ? ` (planId: ${resolvedPlanId})` : ''),
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
      // Persist the failed event for scheduled retry instead of giving up immediately.
      // This prevents orphaned tenants (tenants with no subscription) when NATS or the
      // billing DB is temporarily unavailable.
      if (options.persistFailure !== false) {
        await this.persistForRetry(event, (error as Error).message);
      }
      throw error;
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
      employees?: number;
      devices?: number;
      storageGb?: number;
      apiCalls?: number;
      alerts?: number;
      reports?: number;
      integrations?: number;
    }>,
  ): Promise<void> {
    const moduleItemRepo = this.subscriptionModuleItemRepository;

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

  // ─── Retry Infrastructure ──────────────────────────────────────────

  /**
   * Verify the migration-owned retry table exists. Called once per service-instance lifetime.
   */
  private async ensureRetryTable(): Promise<void> {
    if (this.retryTableEnsured) return;
    const rows: unknown = await this.dataSource.query(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema = 'billing'
          AND table_name = 'subscription_provisioning_retries'
          AND table_type = 'BASE TABLE'
        LIMIT 1`,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(
        'billing.subscription_provisioning_retries is missing; run aqua-db-migrate before billing-service',
      );
    }
    this.retryTableEnsured = true;
  }

  /**
   * Persist a failed event for scheduled retry with exponential backoff.
   */
  private async persistForRetry(
    event: TenantSubscriptionRequestedEvent,
    errorMessage: string,
  ): Promise<void> {
    const tenantId = event.tenantId || event.payload?.tenantId;
    try {
      await this.ensureRetryTable();
      const nextRetryAt = new Date(Date.now() + RETRY_BASE_DELAY_MS);
      await this.dataSource.query(
        `INSERT INTO billing.subscription_provisioning_retries
           (tenant_id, event_payload, error_message, retry_count, status, next_retry_at)
         VALUES ($1, $2, $3, 0, 'pending', $4)
         ON CONFLICT DO NOTHING`,
        [tenantId, JSON.stringify(event), errorMessage, nextRetryAt],
      );
      this.logger.warn(
        `Queued subscription provisioning retry for tenant ${tenantId} (next retry at ${nextRetryAt.toISOString()})`,
      );
    } catch (persistError) {
      // If even persistence fails, publish the failure event as a last resort
      this.logger.error(
        `Failed to persist retry for tenant ${tenantId}: ${(persistError as Error).message}`,
      );
      await this.publishProvisioningFailed(tenantId!, errorMessage, undefined, undefined);
    }
  }

  /**
   * Scheduled retry: every 2 minutes, pick up pending retries whose next_retry_at
   * has elapsed and re-attempt subscription creation. Dead-letters after MAX_RETRY_ATTEMPTS.
   */
  @Cron('*/2 * * * *', { name: 'subscription-provisioning-retry' })
  async processRetryQueue(): Promise<void> {
    try {
      await this.ensureRetryTable();
    } catch {
      return; // Table not ready yet
    }

    const now = new Date();
    // Atomically claim pending retries to prevent concurrent processing
    // TypeORM's dataSource.query() wraps UPDATE results as [rows[], affectedCount]
    const result: unknown = await this.dataSource.query(
      `UPDATE billing.subscription_provisioning_retries
         SET status = 'processing', updated_at = NOW()
       WHERE status = 'pending' AND next_retry_at <= $1
       RETURNING id, tenant_id, event_payload, retry_count`,
      [now],
    );
    const resultList = Array.isArray(result) ? (result as readonly unknown[]) : [];
    const claimedRows = Array.isArray(resultList[0])
      ? (resultList[0] as readonly unknown[])
      : resultList;
    const rows = claimedRows as Array<{
      id: string;
      tenant_id: string;
      event_payload: Record<string, unknown>;
      retry_count: number;
    }>;

    if (rows.length === 0) return;

    this.logger.log(`Processing ${rows.length} subscription provisioning retry(ies)`);

    for (const row of rows) {
      try {
        // Guard: skip malformed rows (missing required fields)
        if (!row.id || !row.event_payload || typeof row.retry_count !== 'number') {
          this.logger.warn(`Skipping malformed retry row: ${JSON.stringify({ id: row.id, hasPayload: !!row.event_payload })}`);
          continue;
        }

        // Reconstruct the event and re-invoke handle()
        // JSONB column — validated at insert time; safe to cast
        const event = row.event_payload as unknown as TenantSubscriptionRequestedEvent;
        await this.handle(event, { persistFailure: false });

        // Success — remove from retry queue
        await this.dataSource.query(
          `DELETE FROM billing.subscription_provisioning_retries WHERE id = $1`,
          [row.id],
        );
        this.logger.log(
          `Subscription provisioning retry succeeded for tenant ${row.tenant_id}`,
        );
      } catch (error) {
        const newRetryCount = (row.retry_count ?? 0) + 1;

        try {
          if (newRetryCount >= MAX_RETRY_ATTEMPTS) {
            // Dead-letter: mark as permanently failed
            await this.dataSource.query(
              `UPDATE billing.subscription_provisioning_retries
                 SET status = 'dead_letter', retry_count = $2, error_message = $3, updated_at = NOW()
               WHERE id = $1`,
              [row.id, newRetryCount, (error as Error).message],
            );
            this.logger.error(
              `Subscription provisioning dead-lettered for tenant ${row.tenant_id} after ${newRetryCount} attempts`,
            );
            // Publish failure event so admin-api or alerting can detect the orphaned tenant
            await this.publishProvisioningFailed(
              row.tenant_id,
              `Dead-lettered after ${newRetryCount} retry attempts: ${(error as Error).message}`,
            );
          } else {
            // Exponential backoff: 30s * 2^retryCount
            const backoffMs = RETRY_BASE_DELAY_MS * Math.pow(2, newRetryCount);
            const nextRetryAt = new Date(Date.now() + backoffMs);
            await this.dataSource.query(
              `UPDATE billing.subscription_provisioning_retries
                 SET status = 'pending', retry_count = $2, error_message = $3,
                     next_retry_at = $4, updated_at = NOW()
               WHERE id = $1`,
              [row.id, newRetryCount, (error as Error).message, nextRetryAt],
            );
            this.logger.warn(
              `Subscription provisioning retry ${newRetryCount}/${MAX_RETRY_ATTEMPTS} failed for tenant ${row.tenant_id}, next retry at ${nextRetryAt.toISOString()}`,
            );
          }
        } catch (updateError) {
          this.logger.error(
            `Failed to update retry status for row ${row.id}: ${(updateError as Error).message}`,
          );
        }
      }
    }
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
