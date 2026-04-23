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
import { TenantUsageMetrics, UsagePeriodType } from '../entities/tenant-usage-metrics.entity';

/** Cache TTL for tenant billing aggregate (30 seconds) */
const TENANT_BILLING_CACHE_TTL_S = 30;

/** Maximum number of recent invoices to return */
const MAX_RECENT_INVOICES = 20;

@Injectable()
@QueryHandler(GetTenantBillingQuery)
export class GetTenantBillingHandler
  implements IQueryHandler<GetTenantBillingQuery, TenantBillingResponse>
{
  constructor(
    private readonly dataSource: DataSource,
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

    // Fetch subscription, invoices, and usage metrics in parallel
    const [subscription, invoices, usageMetrics] = await Promise.all([
      this.getSubscription(tenantId),
      this.getRecentInvoices(tenantId),
      this.getCurrentUsageMetrics(tenantId),
    ]);

    const result: TenantBillingResponse = {
      subscription: subscription ? this.mapSubscription(subscription) : null,
      invoices: invoices.map((inv) => this.mapInvoice(inv)),
      planLimits: subscription ? this.mapPlanLimits(subscription, usageMetrics) : null,
      usageMetrics: this.mapUsageMetrics(subscription, usageMetrics),
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

  private async getCurrentUsageMetrics(tenantId: string): Promise<TenantUsageMetrics | null> {
    const repo = TenantScopedRepository.create(this.dataSource, TenantUsageMetrics, tenantId);

    // Get the most recent monthly usage record (moduleId is null for tenant-wide).
    return repo.findOne({
      where: {
        periodType: UsagePeriodType.MONTHLY,
      },
      order: { periodStart: 'DESC' },
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
    usage: TenantUsageMetrics | null,
  ): TenantPlanLimitsDto {
    const limits = sub.limits;

    return {
      maxFarms: limits?.maxFarms ?? 0,
      maxSensors: limits?.maxSensors ?? 0,
      maxUsers: limits?.maxUsers ?? 0,
      maxStorage: 0, // PlanLimits entity does not track storage in GB; default to 0
      currentFarms: usage?.metrics?.farms?.current ?? 0,
      currentSensors: usage?.metrics?.sensors?.current ?? 0,
      currentUsers: usage?.metrics?.users?.current ?? 0,
      currentStorage: usage?.metrics?.storageGb?.current ?? 0,
    };
  }

  private mapUsageMetrics(
    sub: Subscription | null,
    usage: TenantUsageMetrics | null,
  ): TenantUsageMetricsDto | null {
    if (!usage) {
      // Return zero-state metrics so the frontend always has data to render
      return {
        apiCallsThisMonth: 0,
        apiCallsLimit: 0,
        storageUsedGb: 0,
        storageLimit: 0,
        sensorReadingsThisMonth: 0,
        sensorReadingsLimit: 0,
      };
    }

    const includedQty = usage.includedQuantities || {};

    return {
      apiCallsThisMonth: usage.getTotalUsage('apiCalls'),
      apiCallsLimit: includedQty['apiCalls'] ?? 0,
      storageUsedGb: usage.getCurrentUsage('storageGb'),
      storageLimit: includedQty['storageGb'] ?? 0,
      sensorReadingsThisMonth: usage.getTotalUsage('sensors'),
      sensorReadingsLimit: includedQty['sensors'] ?? (sub?.limits?.maxSensors ?? 0),
    };
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
