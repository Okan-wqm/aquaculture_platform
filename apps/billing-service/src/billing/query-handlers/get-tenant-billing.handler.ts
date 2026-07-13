import { Injectable, Optional } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { TenantScopedRepository } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import { GetTenantBillingQuery } from '../queries/get-tenant-billing.query';
import {
  TenantBillingResponse,
  TenantSubscriptionDto,
  TenantSubscriptionStatus,
  TenantBillingPeriod,
  TenantInvoiceDto,
  TenantInvoiceStatus,
  TenantPlanLimitsDto,
  TenantUsageMetricsDto,
} from '../dto/tenant-billing-response.dto';
import { Subscription, SubscriptionStatus, BillingCycle } from '../entities/subscription.entity';
import { Invoice, InvoiceStatus } from '../entities/invoice.entity';
import {
  UsageAggregatorService,
  MeterMonthUsage,
} from '../../modules/metering/usage-aggregator.service';
import {
  MeteredBillingService,
  MeterPricingModel,
} from '../../modules/metering/metered-billing.service';
import { MeterType } from '../../modules/metering/usage-metering.service';

/** Cache TTL for tenant billing aggregate (30 seconds) */
const TENANT_BILLING_CACHE_TTL_S = 30;

/** Maximum number of recent invoices to return */
const MAX_RECENT_INVOICES = 20;

/**
 * WHY the usage source is the metering module (A6 / DB-IDENT-MEDIUM-002):
 * this handler previously read `billing.tenant_usage_metrics`, a parallel
 * usage model NO code path ever wrote — every tenant always saw the
 * zero-state. `billing.usage_aggregations` is the single persisted usage
 * SSoT (written by UsageAggregatorService.persistDirtyData, read by
 * MeteredBillingService.calculateBilling), so tenant-facing usage numbers
 * now come from the same model invoices are calculated from. Included
 * quantities come from the metering pricing model (per plan tier) — the
 * same source calculateBilling bills against — instead of the retired
 * table's never-populated `includedQuantities` jsonb.
 */
@Injectable()
@QueryHandler(GetTenantBillingQuery)
export class GetTenantBillingHandler
  implements IQueryHandler<GetTenantBillingQuery, TenantBillingResponse>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly usageAggregator: UsageAggregatorService,
    private readonly meteredBilling: MeteredBillingService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async execute(query: GetTenantBillingQuery): Promise<TenantBillingResponse> {
    const { tenantId } = query;

    // Serve from cache if available
    if (this.redisService) {
      const cacheKey = `tenant-billing:${tenantId}`;
      const cached = await this.redisService.getJson<TenantBillingResponse>(cacheKey);
      if (cached) return cached;
    }

    // Fetch subscription, invoices, and month-to-date usage in parallel
    const [subscription, invoices, usage] = await Promise.all([
      this.getSubscription(tenantId),
      this.getRecentInvoices(tenantId),
      this.usageAggregator.getPersistedMonthUsage(tenantId, new Date()),
    ]);

    const pricing = subscription
      ? this.meteredBilling.getPricingModel(subscription.planTier)
      : undefined;

    const result: TenantBillingResponse = {
      subscription: subscription ? this.mapSubscription(subscription) : null,
      invoices: invoices.map((inv) => this.mapInvoice(inv)),
      planLimits: subscription ? this.mapPlanLimits(subscription, usage, pricing) : null,
      usageMetrics: this.mapUsageMetrics(usage, pricing),
    };

    // Cache the result
    if (this.redisService) {
      const cacheKey = `tenant-billing:${tenantId}`;
      await this.redisService.setJson(cacheKey, result, TENANT_BILLING_CACHE_TTL_S);
    }

    return result;
  }

  // ============================================================================
  // Data Fetching
  // ============================================================================

  private async getSubscription(tenantId: string): Promise<Subscription | null> {
    const repo = TenantScopedRepository.create(this.dataSource, Subscription, tenantId);
    return repo.findOne({
      where: {},
      order: { createdAt: 'DESC' },
    });
  }

  private async getRecentInvoices(tenantId: string): Promise<Invoice[]> {
    const repo = TenantScopedRepository.create(this.dataSource, Invoice, tenantId);
    return repo.find({
      where: {
        status: In([
          InvoiceStatus.PAID,
          InvoiceStatus.PENDING,
          InvoiceStatus.OVERDUE,
          InvoiceStatus.DRAFT,
          InvoiceStatus.VOID,
        ]),
      },
      order: { issueDate: 'DESC' },
      take: MAX_RECENT_INVOICES,
    });
  }

  // ============================================================================
  // Mapping: Backend entities -> Frontend DTOs
  // ============================================================================

  private mapSubscription(sub: Subscription): TenantSubscriptionDto {
    return {
      id: sub.id,
      plan: sub.planName,
      status: this.mapSubscriptionStatus(sub.status),
      billingPeriod: this.mapBillingPeriod(sub.billingCycle),
      currentPeriodStart: sub.currentPeriodStart.toISOString(),
      currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
      trialEndDate: sub.trialEndDate ? sub.trialEndDate.toISOString() : null,
      monthlyPrice: this.calculateMonthlyPrice(sub),
      currency: sub.pricing?.currency || 'USD',
    };
  }

  private mapInvoice(inv: Invoice): TenantInvoiceDto {
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amount: Number(inv.total),
      currency: inv.currency,
      status: this.mapInvoiceStatus(inv.status),
      issuedAt: inv.issueDate.toISOString(),
      dueDate: inv.dueDate.toISOString(),
      paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
      description: this.buildInvoiceDescription(inv),
    };
  }

  private mapPlanLimits(
    sub: Subscription,
    usage: Map<MeterType, MeterMonthUsage>,
    pricing: Map<MeterType, MeterPricingModel> | undefined,
  ): TenantPlanLimitsDto {
    const limits = sub.limits;

    return {
      maxFarms: limits?.maxFarms ?? 0,
      maxSensors: limits?.maxSensors ?? 0,
      maxUsers: limits?.maxUsers ?? 0,
      // PlanLimits (subscription jsonb) tracks no storage quota; the metering
      // pricing model's included GB per plan tier is the storage allowance.
      maxStorage: this.includedUnits(pricing, MeterType.DATA_STORAGE),
      currentFarms: Math.round(this.gaugeLevel(usage, MeterType.FARMS_ACTIVE)),
      currentSensors: Math.round(this.gaugeLevel(usage, MeterType.SENSORS_ACTIVE)),
      currentUsers: Math.round(this.gaugeLevel(usage, MeterType.USERS_ACTIVE)),
      currentStorage: this.gaugeLevel(usage, MeterType.DATA_STORAGE),
    };
  }

  private mapUsageMetrics(
    usage: Map<MeterType, MeterMonthUsage>,
    pricing: Map<MeterType, MeterPricingModel> | undefined,
  ): TenantUsageMetricsDto {
    // With no aggregation rows every value below is 0 — the same zero-state
    // shape the frontend has always rendered, but now derived from the real
    // usage model instead of a special-case branch.
    return {
      apiCallsThisMonth: Math.round(this.cumulativeTotal(usage, MeterType.API_CALLS)),
      apiCallsLimit: this.includedUnits(pricing, MeterType.API_CALLS),
      storageUsedGb: this.gaugeLevel(usage, MeterType.DATA_STORAGE),
      storageLimit: this.includedUnits(pricing, MeterType.DATA_STORAGE),
      sensorReadingsThisMonth: Math.round(this.cumulativeTotal(usage, MeterType.SENSOR_READINGS)),
      // Readings allowance comes from the pricing model. The retired code fell
      // back to sub.limits.maxSensors — a sensor COUNT, not a readings/month
      // quota — which conflated two different units.
      sensorReadingsLimit: this.includedUnits(pricing, MeterType.SENSOR_READINGS),
    };
  }

  // ============================================================================
  // Usage Accessors
  // ============================================================================

  /** Month-to-date total for cumulative counters (api calls, readings). */
  private cumulativeTotal(usage: Map<MeterType, MeterMonthUsage>, meter: MeterType): number {
    return usage.get(meter)?.cumulativeTotal ?? 0;
  }

  /** Current level for gauge meters (storage GB, active users/farms/sensors). */
  private gaugeLevel(usage: Map<MeterType, MeterMonthUsage>, meter: MeterType): number {
    return usage.get(meter)?.latestLevel ?? 0;
  }

  /** Included quantity for a meter from the plan tier's pricing model. */
  private includedUnits(
    pricing: Map<MeterType, MeterPricingModel> | undefined,
    meter: MeterType,
  ): number {
    return pricing?.get(meter)?.includedUnits ?? 0;
  }

  // ============================================================================
  // Enum Mapping Helpers
  // ============================================================================

  private mapSubscriptionStatus(status: SubscriptionStatus): TenantSubscriptionStatus {
    const mapping: Record<SubscriptionStatus, TenantSubscriptionStatus> = {
      [SubscriptionStatus.ACTIVE]: TenantSubscriptionStatus.ACTIVE,
      [SubscriptionStatus.TRIAL]: TenantSubscriptionStatus.TRIAL,
      [SubscriptionStatus.PAST_DUE]: TenantSubscriptionStatus.PAST_DUE,
      [SubscriptionStatus.CANCELLED]: TenantSubscriptionStatus.CANCELLED,
      [SubscriptionStatus.SUSPENDED]: TenantSubscriptionStatus.SUSPENDED,
      [SubscriptionStatus.EXPIRED]: TenantSubscriptionStatus.CANCELLED, // Expired maps to cancelled for frontend
    };
    return mapping[status] ?? TenantSubscriptionStatus.ACTIVE;
  }

  private mapBillingPeriod(cycle: BillingCycle): TenantBillingPeriod {
    // Frontend only supports MONTHLY | YEARLY
    switch (cycle) {
      case BillingCycle.ANNUAL:
        return TenantBillingPeriod.YEARLY;
      case BillingCycle.MONTHLY:
      case BillingCycle.QUARTERLY:
      case BillingCycle.SEMI_ANNUAL:
      default:
        return TenantBillingPeriod.MONTHLY;
    }
  }

  private mapInvoiceStatus(status: InvoiceStatus): TenantInvoiceStatus {
    const mapping: Record<InvoiceStatus, TenantInvoiceStatus> = {
      [InvoiceStatus.PAID]: TenantInvoiceStatus.PAID,
      [InvoiceStatus.PENDING]: TenantInvoiceStatus.PENDING,
      [InvoiceStatus.SENT]: TenantInvoiceStatus.PENDING, // Sent = still pending payment
      [InvoiceStatus.OVERDUE]: TenantInvoiceStatus.OVERDUE,
      [InvoiceStatus.DRAFT]: TenantInvoiceStatus.DRAFT,
      [InvoiceStatus.VOID]: TenantInvoiceStatus.VOID,
      [InvoiceStatus.PARTIALLY_PAID]: TenantInvoiceStatus.PENDING,
      [InvoiceStatus.REFUNDED]: TenantInvoiceStatus.VOID,
    };
    return mapping[status] ?? TenantInvoiceStatus.PENDING;
  }

  // ============================================================================
  // Price & Description Helpers
  // ============================================================================

  /**
   * Calculate the effective monthly price from the subscription pricing.
   * For annual plans, divides by 12.
   */
  private calculateMonthlyPrice(sub: Subscription): number {
    const basePrice = Number(sub.pricing?.basePrice ?? 0);

    switch (sub.billingCycle) {
      case BillingCycle.ANNUAL:
        return Math.round((basePrice / 12) * 100) / 100;
      case BillingCycle.SEMI_ANNUAL:
        return Math.round((basePrice / 6) * 100) / 100;
      case BillingCycle.QUARTERLY:
        return Math.round((basePrice / 3) * 100) / 100;
      case BillingCycle.MONTHLY:
      default:
        return basePrice;
    }
  }

  /**
   * Build a human-readable description for an invoice.
   * Uses notes if available, otherwise constructs from line items.
   */
  private buildInvoiceDescription(inv: Invoice): string {
    if (inv.notes) {
      return inv.notes;
    }

    if (inv.lineItems && inv.lineItems.length > 0) {
      const firstItem = inv.lineItems[0]!;
      if (inv.lineItems.length === 1) {
        return firstItem.description;
      }
      return `${firstItem.description} (+${inv.lineItems.length - 1} more)`;
    }

    return `Invoice ${inv.invoiceNumber}`;
  }
}
