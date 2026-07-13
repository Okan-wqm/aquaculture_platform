import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { TenantPlan, resolvePlanLimits } from '@platform/event-contracts';
import {
  UsageAggregatorService,
  AggregatedUsage,
  AggregationPeriod,
} from './usage-aggregator.service';
import { MeterType } from './usage-metering.service';
import { BillingCycle, PlanTier } from '../../billing/entities/subscription.entity';

/**
 * Pricing tier configuration
 */
export interface PricingTier {
  minUnits: number;
  maxUnits: number | null; // null for unlimited
  pricePerUnit: number;
  flatFee?: number;
}

/**
 * Meter pricing model
 */
export interface MeterPricingModel {
  meterId: string;
  meterType: MeterType;
  displayName: string;
  unit: string;
  tiers: PricingTier[];
  includedUnits: number; // Units included in base plan
  minimumCharge?: number;
  currency: string;
}

/**
 * Tax rate configuration by region
 */
export interface TaxRateConfig {
  region: string;
  country: string;
  taxType: 'VAT' | 'GST' | 'SALES_TAX' | 'NONE';
  rate: number; // Percentage (e.g., 18 for 18%)
  name: string;
  isCompound?: boolean;
}

/**
 * Currency exchange rate
 */
export interface CurrencyRate {
  from: string;
  to: string;
  rate: number;
  updatedAt: Date;
}

/**
 * Billing calculation result for a single meter
 */
export interface MeterBillingBreakdown {
  meterId: string;
  meterType: MeterType;
  displayName: string;
  totalUnits: number;
  includedUnits: number;
  billableUnits: number;
  tierBreakdown: Array<{
    tier: number;
    unitsInTier: number;
    pricePerUnit: number;
    amount: number;
  }>;
  subtotal: number;
  minimumApplied: boolean;
  currency: string;
}

/**
 * Complete billing calculation
 */
export interface BillingCalculation {
  subscriptionId: string;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  basePlanFee: number;
  meterBreakdowns: MeterBillingBreakdown[];
  subtotalMetered: number;
  subtotalBeforeTax: number;
  taxes: Array<{
    name: string;
    rate: number;
    amount: number;
  }>;
  totalTax: number;
  total: number;
  currency: string;
  proRataAdjustment?: {
    reason: string;
    factor: number;
    adjustment: number;
  };
  credits?: {
    reason: string;
    amount: number;
  };
  discounts?: Array<{
    code: string;
    type: 'percentage' | 'fixed';
    value: number;
    amount: number;
  }>;
  finalTotal: number;
  calculatedAt: Date;
}

/**
 * Invoice preview
 */
export interface InvoicePreview extends BillingCalculation {
  estimatedCharges: boolean;
  projectedUsage?: Map<MeterType, number>;
}

/**
 * Metered Billing Service
 * Calculates billing based on usage with tiered pricing, pro-rata, taxes, and currency conversion
 */
@Injectable()
export class MeteredBillingService implements OnModuleInit {
  private readonly logger = new Logger(MeteredBillingService.name);

  // Pricing models by plan tier
  private readonly pricingModels = new Map<PlanTier, Map<MeterType, MeterPricingModel>>();

  // Tax rates by region
  private readonly taxRates = new Map<string, TaxRateConfig>();

  // Currency exchange rates
  private readonly exchangeRates = new Map<string, CurrencyRate>();

  // Default currency
  private readonly baseCurrency = 'USD';

  // Cache for billing calculations (bounded size with TTL eviction)
  private readonly calculationCache = new Map<
    string,
    { calculation: BillingCalculation; expiresAt: Date }
  >();
  private static readonly MAX_CACHE_SIZE = 1000;

  constructor(
    private readonly usageAggregator: UsageAggregatorService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing MeteredBillingService');
    await this.initializePricingModels();
    await this.initializeTaxRates();
    await this.initializeExchangeRates();

    this.logger.log('MeteredBillingService initialized successfully');
  }

  /**
   * Periodically warn when hardcoded exchange rates have gone stale (Billing
   * Revival Faz E).
   *
   * WHY `@Cron` not `setInterval`: the previous `setInterval` was created in
   * `onModuleInit` but its handle was never stored and never cleared — a timer
   * leak that outlived the module. `@Cron` registers with Nest's
   * SchedulerRegistry, so the billing app owns its lifecycle and stops it on
   * shutdown.
   *
   * WHAT: hourly, warn for any exchange rate older than 24h. Rates should be
   * replaced with a live feed (e.g. Open Exchange Rates) in production.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'metered-billing-stale-fx-warn' })
  warnOnStaleExchangeRates(): void {
    const now = Date.now();
    for (const [pair, rate] of this.exchangeRates) {
      const ageHours = (now - rate.updatedAt.getTime()) / (1000 * 60 * 60);
      if (ageHours > 24) {
        this.logger.warn(
          `Exchange rate ${pair} is ${Math.floor(ageHours)}h old — update via updateExchangeRate() or integrate a live FX feed.`,
        );
      }
    }
  }

  /**
   * Initialize pricing models for all plan tiers
   */
  private async initializePricingModels(): Promise<void> {
    // Starter Plan Pricing
    const starterPricing = new Map<MeterType, MeterPricingModel>();

    starterPricing.set(MeterType.API_CALLS, {
      meterId: 'api-calls-starter',
      meterType: MeterType.API_CALLS,
      displayName: 'API Calls',
      unit: 'calls',
      includedUnits: 10000,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 50000, pricePerUnit: 0.001 },
        { minUnits: 50001, maxUnits: 100000, pricePerUnit: 0.0008 },
        { minUnits: 100001, maxUnits: null, pricePerUnit: 0.0005 },
      ],
    });

    starterPricing.set(MeterType.DATA_STORAGE, {
      meterId: 'data-storage-starter',
      meterType: MeterType.DATA_STORAGE,
      displayName: 'Data Storage',
      unit: 'GB',
      includedUnits: 5,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 50, pricePerUnit: 0.1 },
        { minUnits: 51, maxUnits: 200, pricePerUnit: 0.08 },
        { minUnits: 201, maxUnits: null, pricePerUnit: 0.05 },
      ],
    });

    starterPricing.set(MeterType.SENSOR_READINGS, {
      meterId: 'sensor-readings-starter',
      meterType: MeterType.SENSOR_READINGS,
      displayName: 'Sensor Readings',
      unit: 'readings',
      includedUnits: 100000,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 500000, pricePerUnit: 0.00005 },
        { minUnits: 500001, maxUnits: 1000000, pricePerUnit: 0.00003 },
        { minUnits: 1000001, maxUnits: null, pricePerUnit: 0.00001 },
      ],
    });

    starterPricing.set(MeterType.ALERTS_SENT, {
      meterId: 'alerts-sent-starter',
      meterType: MeterType.ALERTS_SENT,
      displayName: 'Alerts Sent',
      unit: 'alerts',
      includedUnits: 100,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 1000, pricePerUnit: 0.05 },
        { minUnits: 1001, maxUnits: null, pricePerUnit: 0.02 },
      ],
    });

    starterPricing.set(MeterType.REPORTS_GENERATED, {
      meterId: 'reports-starter',
      meterType: MeterType.REPORTS_GENERATED,
      displayName: 'Reports Generated',
      unit: 'reports',
      includedUnits: 10,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 100, pricePerUnit: 0.5 },
        { minUnits: 101, maxUnits: null, pricePerUnit: 0.25 },
      ],
    });

    starterPricing.set(MeterType.USERS_ACTIVE, {
      meterId: 'active-users-starter',
      meterType: MeterType.USERS_ACTIVE,
      displayName: 'Active Users',
      unit: 'users',
      includedUnits: 3,
      currency: 'USD',
      minimumCharge: 0,
      tiers: [
        { minUnits: 0, maxUnits: 10, pricePerUnit: 5 },
        { minUnits: 11, maxUnits: 50, pricePerUnit: 4 },
        { minUnits: 51, maxUnits: null, pricePerUnit: 3 },
      ],
    });

    starterPricing.set(MeterType.PONDS_ACTIVE, {
      meterId: 'ponds-starter',
      meterType: MeterType.PONDS_ACTIVE,
      displayName: 'Ponds Managed',
      unit: 'ponds',
      includedUnits: 5,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 20, pricePerUnit: 10 },
        { minUnits: 21, maxUnits: 50, pricePerUnit: 8 },
        { minUnits: 51, maxUnits: null, pricePerUnit: 5 },
      ],
    });

    this.pricingModels.set(PlanTier.STARTER, starterPricing);

    // Professional Plan Pricing (more generous limits, lower per-unit costs)
    const professionalPricing = new Map<MeterType, MeterPricingModel>();

    professionalPricing.set(MeterType.API_CALLS, {
      meterId: 'api-calls-professional',
      meterType: MeterType.API_CALLS,
      displayName: 'API Calls',
      unit: 'calls',
      includedUnits: 100000,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 500000, pricePerUnit: 0.0005 },
        { minUnits: 500001, maxUnits: 1000000, pricePerUnit: 0.0003 },
        { minUnits: 1000001, maxUnits: null, pricePerUnit: 0.0001 },
      ],
    });

    professionalPricing.set(MeterType.DATA_STORAGE, {
      meterId: 'data-storage-professional',
      meterType: MeterType.DATA_STORAGE,
      displayName: 'Data Storage',
      unit: 'GB',
      includedUnits: 50,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 200, pricePerUnit: 0.05 },
        { minUnits: 201, maxUnits: 500, pricePerUnit: 0.03 },
        { minUnits: 501, maxUnits: null, pricePerUnit: 0.02 },
      ],
    });

    professionalPricing.set(MeterType.SENSOR_READINGS, {
      meterId: 'sensor-readings-professional',
      meterType: MeterType.SENSOR_READINGS,
      displayName: 'Sensor Readings',
      unit: 'readings',
      includedUnits: 1000000,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 5000000, pricePerUnit: 0.00002 },
        { minUnits: 5000001, maxUnits: null, pricePerUnit: 0.00001 },
      ],
    });

    professionalPricing.set(MeterType.ALERTS_SENT, {
      meterId: 'alerts-sent-professional',
      meterType: MeterType.ALERTS_SENT,
      displayName: 'Alerts Sent',
      unit: 'alerts',
      includedUnits: 1000,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 5000, pricePerUnit: 0.02 },
        { minUnits: 5001, maxUnits: null, pricePerUnit: 0.01 },
      ],
    });

    professionalPricing.set(MeterType.REPORTS_GENERATED, {
      meterId: 'reports-professional',
      meterType: MeterType.REPORTS_GENERATED,
      displayName: 'Reports Generated',
      unit: 'reports',
      includedUnits: 100,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 500, pricePerUnit: 0.2 },
        { minUnits: 501, maxUnits: null, pricePerUnit: 0.1 },
      ],
    });

    professionalPricing.set(MeterType.USERS_ACTIVE, {
      meterId: 'active-users-professional',
      meterType: MeterType.USERS_ACTIVE,
      displayName: 'Active Users',
      unit: 'users',
      includedUnits: 10,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 50, pricePerUnit: 3 },
        { minUnits: 51, maxUnits: 100, pricePerUnit: 2.5 },
        { minUnits: 101, maxUnits: null, pricePerUnit: 2 },
      ],
    });

    professionalPricing.set(MeterType.PONDS_ACTIVE, {
      meterId: 'ponds-professional',
      meterType: MeterType.PONDS_ACTIVE,
      displayName: 'Ponds Managed',
      unit: 'ponds',
      includedUnits: 25,
      currency: 'USD',
      tiers: [
        { minUnits: 0, maxUnits: 100, pricePerUnit: 5 },
        { minUnits: 101, maxUnits: null, pricePerUnit: 3 },
      ],
    });

    this.pricingModels.set(PlanTier.PROFESSIONAL, professionalPricing);

    // Enterprise Plan Pricing (most generous, custom pricing available)
    const enterprisePricing = new Map<MeterType, MeterPricingModel>();

    enterprisePricing.set(MeterType.API_CALLS, {
      meterId: 'api-calls-enterprise',
      meterType: MeterType.API_CALLS,
      displayName: 'API Calls',
      unit: 'calls',
      includedUnits: 1000000,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 0.00005 }],
    });

    enterprisePricing.set(MeterType.DATA_STORAGE, {
      meterId: 'data-storage-enterprise',
      meterType: MeterType.DATA_STORAGE,
      displayName: 'Data Storage',
      unit: 'GB',
      includedUnits: 500,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 0.01 }],
    });

    enterprisePricing.set(MeterType.SENSOR_READINGS, {
      meterId: 'sensor-readings-enterprise',
      meterType: MeterType.SENSOR_READINGS,
      displayName: 'Sensor Readings',
      unit: 'readings',
      includedUnits: 10000000,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 0.000005 }],
    });

    enterprisePricing.set(MeterType.ALERTS_SENT, {
      meterId: 'alerts-sent-enterprise',
      meterType: MeterType.ALERTS_SENT,
      displayName: 'Alerts Sent',
      unit: 'alerts',
      includedUnits: 10000,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 0.005 }],
    });

    enterprisePricing.set(MeterType.REPORTS_GENERATED, {
      meterId: 'reports-enterprise',
      meterType: MeterType.REPORTS_GENERATED,
      displayName: 'Reports Generated',
      unit: 'reports',
      includedUnits: 1000,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 0.05 }],
    });

    enterprisePricing.set(MeterType.USERS_ACTIVE, {
      meterId: 'active-users-enterprise',
      meterType: MeterType.USERS_ACTIVE,
      displayName: 'Active Users',
      unit: 'users',
      includedUnits: 100,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 1 }],
    });

    enterprisePricing.set(MeterType.PONDS_ACTIVE, {
      meterId: 'ponds-enterprise',
      meterType: MeterType.PONDS_ACTIVE,
      displayName: 'Ponds Managed',
      unit: 'ponds',
      includedUnits: 200,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 1 }],
    });

    this.pricingModels.set(PlanTier.ENTERPRISE, enterprisePricing);

    // FREE Plan Pricing (Billing Revival Faz B) — permanent $0 tier.
    // Every meter is priced at 0 on a single open-ended tier so NO usage can
    // ever produce a charge (FREE = fully free). `includedUnits` is sourced from
    // the canonical PLAN_CATALOG FREE entry so the free allowance surfaced to the
    // UI stays in lockstep with the SSoT. Without this entry `calculateBilling`
    // would throw "No pricing model found for plan tier: free".
    const freeLimits = resolvePlanLimits(TenantPlan.FREE);
    const freePricing = new Map<MeterType, MeterPricingModel>();
    const freeMeter = (
      meterType: MeterType,
      meterId: string,
      displayName: string,
      unit: string,
      includedUnits: number,
    ): MeterPricingModel => ({
      meterId,
      meterType,
      displayName,
      unit,
      includedUnits,
      minimumCharge: 0,
      currency: 'USD',
      tiers: [{ minUnits: 0, maxUnits: null, pricePerUnit: 0 }],
    });

    freePricing.set(
      MeterType.API_CALLS,
      freeMeter(
        MeterType.API_CALLS,
        'api-calls-free',
        'API Calls',
        'calls',
        freeLimits.maxApiRequests,
      ),
    );
    freePricing.set(
      MeterType.DATA_STORAGE,
      freeMeter(
        MeterType.DATA_STORAGE,
        'data-storage-free',
        'Data Storage',
        'GB',
        freeLimits.maxStorageGb,
      ),
    );
    freePricing.set(
      MeterType.SENSOR_READINGS,
      freeMeter(
        MeterType.SENSOR_READINGS,
        'sensor-readings-free',
        'Sensor Readings',
        'readings',
        0,
      ),
    );
    freePricing.set(
      MeterType.ALERTS_SENT,
      freeMeter(MeterType.ALERTS_SENT, 'alerts-sent-free', 'Alerts Sent', 'alerts', 0),
    );
    freePricing.set(
      MeterType.REPORTS_GENERATED,
      freeMeter(MeterType.REPORTS_GENERATED, 'reports-free', 'Reports Generated', 'reports', 0),
    );
    freePricing.set(
      MeterType.USERS_ACTIVE,
      freeMeter(
        MeterType.USERS_ACTIVE,
        'active-users-free',
        'Active Users',
        'users',
        freeLimits.maxUsers,
      ),
    );
    freePricing.set(
      MeterType.PONDS_ACTIVE,
      freeMeter(
        MeterType.PONDS_ACTIVE,
        'ponds-free',
        'Ponds Managed',
        'ponds',
        freeLimits.maxPonds,
      ),
    );

    this.pricingModels.set(PlanTier.FREE, freePricing);

    this.logger.log(`Initialized pricing models for ${this.pricingModels.size} plan tiers`);
  }

  /**
   * Initialize tax rates for different regions
   */
  private async initializeTaxRates(): Promise<void> {
    // Turkey
    this.taxRates.set('TR', {
      region: 'TR',
      country: 'Turkey',
      taxType: 'VAT',
      rate: 18,
      name: 'KDV',
    });

    // USA (varies by state - using average)
    this.taxRates.set('US', {
      region: 'US',
      country: 'United States',
      taxType: 'SALES_TAX',
      rate: 0, // No federal sales tax, state-level varies
      name: 'Sales Tax',
    });

    this.taxRates.set('US-CA', {
      region: 'US-CA',
      country: 'United States - California',
      taxType: 'SALES_TAX',
      rate: 7.25,
      name: 'California Sales Tax',
    });

    this.taxRates.set('US-NY', {
      region: 'US-NY',
      country: 'United States - New York',
      taxType: 'SALES_TAX',
      rate: 8,
      name: 'New York Sales Tax',
    });

    this.taxRates.set('US-TX', {
      region: 'US-TX',
      country: 'United States - Texas',
      taxType: 'SALES_TAX',
      rate: 6.25,
      name: 'Texas Sales Tax',
    });

    // European Union
    this.taxRates.set('DE', {
      region: 'DE',
      country: 'Germany',
      taxType: 'VAT',
      rate: 19,
      name: 'MwSt',
    });

    this.taxRates.set('FR', {
      region: 'FR',
      country: 'France',
      taxType: 'VAT',
      rate: 20,
      name: 'TVA',
    });

    this.taxRates.set('NL', {
      region: 'NL',
      country: 'Netherlands',
      taxType: 'VAT',
      rate: 21,
      name: 'BTW',
    });

    this.taxRates.set('GB', {
      region: 'GB',
      country: 'United Kingdom',
      taxType: 'VAT',
      rate: 20,
      name: 'VAT',
    });

    // Asia Pacific
    this.taxRates.set('JP', {
      region: 'JP',
      country: 'Japan',
      taxType: 'GST',
      rate: 10,
      name: 'Consumption Tax',
    });

    this.taxRates.set('AU', {
      region: 'AU',
      country: 'Australia',
      taxType: 'GST',
      rate: 10,
      name: 'GST',
    });

    this.taxRates.set('SG', {
      region: 'SG',
      country: 'Singapore',
      taxType: 'GST',
      rate: 8,
      name: 'GST',
    });

    // Southeast Asia
    this.taxRates.set('TH', {
      region: 'TH',
      country: 'Thailand',
      taxType: 'VAT',
      rate: 7,
      name: 'VAT',
    });

    this.taxRates.set('VN', {
      region: 'VN',
      country: 'Vietnam',
      taxType: 'VAT',
      rate: 10,
      name: 'VAT',
    });

    this.taxRates.set('ID', {
      region: 'ID',
      country: 'Indonesia',
      taxType: 'VAT',
      rate: 11,
      name: 'PPN',
    });

    // South America
    this.taxRates.set('BR', {
      region: 'BR',
      country: 'Brazil',
      taxType: 'VAT',
      rate: 17, // ICMS varies by state
      name: 'ICMS',
    });

    this.taxRates.set('CL', {
      region: 'CL',
      country: 'Chile',
      taxType: 'VAT',
      rate: 19,
      name: 'IVA',
    });

    this.logger.log(`Initialized tax rates for ${this.taxRates.size} regions`);
  }

  /**
   * Initialize currency exchange rates
   */
  private async initializeExchangeRates(): Promise<void> {
    const now = new Date();

    // Major currencies
    this.exchangeRates.set('USD-EUR', { from: 'USD', to: 'EUR', rate: 0.92, updatedAt: now });
    this.exchangeRates.set('USD-GBP', { from: 'USD', to: 'GBP', rate: 0.79, updatedAt: now });
    this.exchangeRates.set('USD-TRY', { from: 'USD', to: 'TRY', rate: 32.5, updatedAt: now });
    this.exchangeRates.set('USD-JPY', { from: 'USD', to: 'JPY', rate: 149.5, updatedAt: now });
    this.exchangeRates.set('USD-AUD', { from: 'USD', to: 'AUD', rate: 1.53, updatedAt: now });
    this.exchangeRates.set('USD-CAD', { from: 'USD', to: 'CAD', rate: 1.36, updatedAt: now });
    this.exchangeRates.set('USD-CHF', { from: 'USD', to: 'CHF', rate: 0.88, updatedAt: now });
    this.exchangeRates.set('USD-CNY', { from: 'USD', to: 'CNY', rate: 7.24, updatedAt: now });
    this.exchangeRates.set('USD-INR', { from: 'USD', to: 'INR', rate: 83.1, updatedAt: now });
    this.exchangeRates.set('USD-SGD', { from: 'USD', to: 'SGD', rate: 1.34, updatedAt: now });
    this.exchangeRates.set('USD-THB', { from: 'USD', to: 'THB', rate: 35.5, updatedAt: now });
    this.exchangeRates.set('USD-VND', { from: 'USD', to: 'VND', rate: 24500, updatedAt: now });
    this.exchangeRates.set('USD-IDR', { from: 'USD', to: 'IDR', rate: 15700, updatedAt: now });
    this.exchangeRates.set('USD-BRL', { from: 'USD', to: 'BRL', rate: 4.97, updatedAt: now });

    this.logger.log(`Initialized ${this.exchangeRates.size} exchange rates`);
  }

  /**
   * Calculate billing for a subscription period
   */
  async calculateBilling(
    subscriptionId: string,
    tenantId: string,
    planTier: PlanTier,
    billingCycle: BillingCycle,
    periodStart: Date,
    periodEnd: Date,
    basePlanFee: number,
    region: string,
    targetCurrency: string = 'USD',
  ): Promise<BillingCalculation> {
    this.logger.log(
      `Calculating billing for subscription ${subscriptionId}, period ${periodStart.toISOString()} - ${periodEnd.toISOString()}`,
    );

    // BILLING-MEDIUM-006 cure: tenant-scoped cache key. Even
    // though calculationCache is in-process today, the
    // layer-1-nestjs platform contract requires tenant-scoped
    // cache keys (`cache:<service>:<tenant>:<resource>:<key>`).
    // Pre-cure the key was `${subscriptionId}-${period}` —
    // technically unique because subscriptionId is globally
    // unique, but a future promotion to Redis without prior
    // adjustment would inherit the bad shape and a logical bug
    // in subscriptionId allocation could cause cross-tenant
    // cache bleed. Building the discipline in NOW prevents the
    // future regression class.
    const cacheKey = `cache:metered-billing:${tenantId}:billing-calculation:${subscriptionId}-${periodStart.getTime()}-${periodEnd.getTime()}`;
    const cached = this.calculationCache.get(cacheKey);
    if (cached && cached.expiresAt > new Date()) {
      this.logger.debug(`Returning cached billing calculation for ${cacheKey}`);
      return cached.calculation;
    }

    // Get pricing model for plan tier
    const pricingModel = this.pricingModels.get(planTier);
    if (!pricingModel) {
      throw new Error(`No pricing model found for plan tier: ${planTier}`);
    }

    // Get aggregated usage for the period
    const aggregationPeriod = this.billingCycleToAggregationPeriod(billingCycle);
    const usageData: AggregatedUsage[] = this.usageAggregator.getAggregationsInRange(
      tenantId,
      aggregationPeriod,
      periodStart,
      periodEnd,
    );

    // Calculate meter breakdowns
    const meterBreakdowns: MeterBillingBreakdown[] = [];
    let subtotalMetered = 0;

    for (const [meterType, pricing] of pricingModel) {
      const usage = usageData.find((u: AggregatedUsage) => u.meterType === meterType);
      const totalUnits = usage?.totalUsage ?? 0;

      const breakdown = this.calculateMeterBilling(pricing, totalUnits);
      meterBreakdowns.push(breakdown);
      subtotalMetered += breakdown.subtotal;
    }

    // Calculate subtotal before tax
    const subtotalBeforeTax = basePlanFee + subtotalMetered;

    // Calculate taxes
    const taxConfig = this.taxRates.get(region);
    const taxes: Array<{ name: string; rate: number; amount: number }> = [];
    let totalTax = 0;

    if (taxConfig && taxConfig.rate > 0) {
      const taxAmount = this.roundCurrency(subtotalBeforeTax * (taxConfig.rate / 100));
      taxes.push({
        name: taxConfig.name,
        rate: taxConfig.rate,
        amount: taxAmount,
      });
      totalTax = taxAmount;
    }

    // Calculate total
    const total = subtotalBeforeTax + totalTax;

    // Convert currency if needed
    let finalTotal = total;
    if (targetCurrency !== this.baseCurrency) {
      finalTotal = this.convertCurrency(total, this.baseCurrency, targetCurrency);
    }

    const calculation: BillingCalculation = {
      subscriptionId,
      tenantId,
      periodStart,
      periodEnd,
      basePlanFee,
      meterBreakdowns,
      subtotalMetered,
      subtotalBeforeTax,
      taxes,
      totalTax,
      total,
      currency: targetCurrency,
      finalTotal,
      calculatedAt: new Date(),
    };

    // Evict expired entries before inserting
    this.evictExpiredCacheEntries();

    // Cache the calculation for 5 minutes
    this.calculationCache.set(cacheKey, {
      calculation,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    this.eventEmitter.emit('billing.calculated', {
      subscriptionId,
      tenantId,
      total: finalTotal,
      currency: targetCurrency,
      periodStart,
      periodEnd,
    });

    this.logger.log(
      `Billing calculated for ${subscriptionId}: ${targetCurrency} ${finalTotal.toFixed(2)}`,
    );
    return calculation;
  }

  /**
   * Calculate billing for a single meter
   */
  private calculateMeterBilling(
    pricing: MeterPricingModel,
    totalUnits: number,
  ): MeterBillingBreakdown {
    const billableUnits = Math.max(0, totalUnits - pricing.includedUnits);
    const tierBreakdown: MeterBillingBreakdown['tierBreakdown'] = [];

    let remainingUnits = billableUnits;
    let subtotal = 0;
    let tierIndex = 0;

    for (const tier of pricing.tiers) {
      if (remainingUnits <= 0) break;

      const tierStart = tier.minUnits;
      const tierEnd = tier.maxUnits ?? Infinity;
      const tierCapacity = tierEnd - tierStart;

      const unitsInTier = Math.min(remainingUnits, tierCapacity);
      const tierAmount = this.roundCurrency(unitsInTier * tier.pricePerUnit);

      if (unitsInTier > 0) {
        tierBreakdown.push({
          tier: tierIndex + 1,
          unitsInTier,
          pricePerUnit: tier.pricePerUnit,
          amount: tierAmount,
        });
        subtotal += tierAmount;
      }

      remainingUnits -= unitsInTier;
      tierIndex++;
    }

    // Apply minimum charge if applicable
    let minimumApplied = false;
    if (
      pricing.minimumCharge !== undefined &&
      subtotal < pricing.minimumCharge &&
      billableUnits > 0
    ) {
      subtotal = pricing.minimumCharge;
      minimumApplied = true;
    }

    return {
      meterId: pricing.meterId,
      meterType: pricing.meterType,
      displayName: pricing.displayName,
      totalUnits,
      includedUnits: pricing.includedUnits,
      billableUnits,
      tierBreakdown,
      subtotal,
      minimumApplied,
      currency: pricing.currency,
    };
  }

  /**
   * Calculate pro-rata billing for partial periods
   */
  async calculateProRataBilling(
    subscriptionId: string,
    tenantId: string,
    planTier: PlanTier,
    basePlanFee: number,
    fullPeriodStart: Date,
    fullPeriodEnd: Date,
    actualStart: Date,
    actualEnd: Date,
    reason: 'upgrade' | 'downgrade' | 'mid_cycle_start' | 'cancellation',
    region: string,
    targetCurrency: string = 'USD',
  ): Promise<BillingCalculation> {
    this.logger.log(`Calculating pro-rata billing for ${subscriptionId}, reason: ${reason}`);

    const fullPeriodDays = this.daysBetween(fullPeriodStart, fullPeriodEnd);
    const actualDays = this.daysBetween(actualStart, actualEnd);
    const proRataFactor = actualDays / fullPeriodDays;

    this.logger.debug(
      `Pro-rata factor: ${proRataFactor.toFixed(4)} (${actualDays}/${fullPeriodDays} days)`,
    );

    // Calculate billing for the actual partial period only.
    // Usage is queried for actualStart-actualEnd, so metered charges already reflect the shorter period.
    // Only the base plan fee needs pro-rata adjustment.
    const fullCalculation = await this.calculateBilling(
      subscriptionId,
      tenantId,
      planTier,
      BillingCycle.MONTHLY,
      actualStart,
      actualEnd,
      basePlanFee * proRataFactor,
      region,
      targetCurrency,
    );

    // No secondary adjustment on metered charges -- they are already for the actual period
    const proRataCalculation: BillingCalculation = {
      ...fullCalculation,
      proRataAdjustment: {
        reason: this.getProRataReasonDescription(reason),
        factor: proRataFactor,
        adjustment: 0,
      },
    };

    this.eventEmitter.emit('billing.prorata.calculated', {
      subscriptionId,
      tenantId,
      reason,
      factor: proRataFactor,
      adjustment: 0,
    });

    return proRataCalculation;
  }

  /**
   * Generate invoice preview with projected usage
   */
  async generateInvoicePreview(
    subscriptionId: string,
    tenantId: string,
    planTier: PlanTier,
    billingCycle: BillingCycle,
    basePlanFee: number,
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    region: string,
    targetCurrency: string = 'USD',
  ): Promise<InvoicePreview> {
    this.logger.log(`Generating invoice preview for ${subscriptionId}`);

    const now = new Date();
    const daysElapsed = this.daysBetween(currentPeriodStart, now);
    const totalDays = this.daysBetween(currentPeriodStart, currentPeriodEnd);
    const projectionFactor = totalDays / Math.max(daysElapsed, 1);

    // Get current usage
    const currentCalculation = await this.calculateBilling(
      subscriptionId,
      tenantId,
      planTier,
      billingCycle,
      currentPeriodStart,
      now,
      basePlanFee,
      region,
      targetCurrency,
    );

    // Project usage to end of period
    const projectedUsage = new Map<MeterType, number>();
    for (const breakdown of currentCalculation.meterBreakdowns) {
      const projectedUnits = Math.ceil(breakdown.totalUnits * projectionFactor);
      projectedUsage.set(breakdown.meterType, projectedUnits);
    }

    // Calculate projected billing
    const projectedCalculation = await this.calculateBillingWithProjectedUsage(
      subscriptionId,
      tenantId,
      planTier,
      billingCycle,
      currentPeriodStart,
      currentPeriodEnd,
      basePlanFee,
      projectedUsage,
      region,
      targetCurrency,
    );

    const preview: InvoicePreview = {
      ...projectedCalculation,
      estimatedCharges: true,
      projectedUsage,
    };

    return preview;
  }

  /**
   * Calculate billing with specific usage values (for projections)
   */
  private async calculateBillingWithProjectedUsage(
    subscriptionId: string,
    tenantId: string,
    planTier: PlanTier,
    billingCycle: BillingCycle,
    periodStart: Date,
    periodEnd: Date,
    basePlanFee: number,
    projectedUsage: Map<MeterType, number>,
    region: string,
    targetCurrency: string,
  ): Promise<BillingCalculation> {
    const pricingModel = this.pricingModels.get(planTier);
    if (!pricingModel) {
      throw new Error(`No pricing model found for plan tier: ${planTier}`);
    }

    const meterBreakdowns: MeterBillingBreakdown[] = [];
    let subtotalMetered = 0;

    for (const [meterType, pricing] of pricingModel) {
      const totalUnits = projectedUsage.get(meterType) ?? 0;
      const breakdown = this.calculateMeterBilling(pricing, totalUnits);
      meterBreakdowns.push(breakdown);
      subtotalMetered += breakdown.subtotal;
    }

    const subtotalBeforeTax = basePlanFee + subtotalMetered;

    const taxConfig = this.taxRates.get(region);
    const taxes: Array<{ name: string; rate: number; amount: number }> = [];
    let totalTax = 0;

    if (taxConfig && taxConfig.rate > 0) {
      const taxAmount = this.roundCurrency(subtotalBeforeTax * (taxConfig.rate / 100));
      taxes.push({
        name: taxConfig.name,
        rate: taxConfig.rate,
        amount: taxAmount,
      });
      totalTax = taxAmount;
    }

    const total = subtotalBeforeTax + totalTax;
    let finalTotal = total;

    if (targetCurrency !== this.baseCurrency) {
      finalTotal = this.convertCurrency(total, this.baseCurrency, targetCurrency);
    }

    return {
      subscriptionId,
      tenantId,
      periodStart,
      periodEnd,
      basePlanFee,
      meterBreakdowns,
      subtotalMetered,
      subtotalBeforeTax,
      taxes,
      totalTax,
      total,
      currency: targetCurrency,
      finalTotal,
      calculatedAt: new Date(),
    };
  }

  /**
   * Apply credits to a billing calculation
   */
  applyCredits(
    calculation: BillingCalculation,
    creditAmount: number,
    reason: string,
  ): BillingCalculation {
    const adjustedCalculation = { ...calculation };
    const creditToApply = Math.min(creditAmount, calculation.finalTotal);

    adjustedCalculation.credits = {
      reason,
      amount: creditToApply,
    };
    adjustedCalculation.finalTotal = this.roundCurrency(calculation.finalTotal - creditToApply);

    this.logger.log(
      `Applied credit of ${creditToApply} to calculation, new total: ${adjustedCalculation.finalTotal}`,
    );
    return adjustedCalculation;
  }

  /**
   * Apply discount codes to a billing calculation
   */
  applyDiscount(
    calculation: BillingCalculation,
    discountCode: string,
    discountType: 'percentage' | 'fixed',
    discountValue: number,
  ): BillingCalculation {
    const adjustedCalculation = { ...calculation };
    let discountAmount: number;

    if (discountType === 'percentage') {
      discountAmount = this.roundCurrency(calculation.subtotalBeforeTax * (discountValue / 100));
    } else {
      discountAmount = Math.min(discountValue, calculation.subtotalBeforeTax);
    }

    adjustedCalculation.discounts = [
      ...(calculation.discounts ?? []),
      {
        code: discountCode,
        type: discountType,
        value: discountValue,
        amount: discountAmount,
      },
    ];

    // Recalculate totals with discount
    const totalDiscounts = adjustedCalculation.discounts.reduce((sum, d) => sum + d.amount, 0);
    const discountedSubtotal = calculation.subtotalBeforeTax - totalDiscounts;

    // Recalculate tax on discounted amount
    let newTotalTax = 0;
    const newTaxes = calculation.taxes.map((tax) => {
      const newTaxAmount = this.roundCurrency(discountedSubtotal * (tax.rate / 100));
      newTotalTax += newTaxAmount;
      return { ...tax, amount: newTaxAmount };
    });

    adjustedCalculation.taxes = newTaxes;
    adjustedCalculation.totalTax = newTotalTax;
    const newTotal = discountedSubtotal + newTotalTax;
    adjustedCalculation.total = newTotal;

    // Both total and finalTotal must use the same currency
    if (calculation.currency !== this.baseCurrency) {
      const converted = this.convertCurrency(newTotal, this.baseCurrency, calculation.currency);
      adjustedCalculation.total = converted;
      adjustedCalculation.finalTotal = converted;
    } else {
      adjustedCalculation.finalTotal = newTotal;
    }

    this.logger.log(
      `Applied discount ${discountCode}: ${discountAmount}, new total: ${adjustedCalculation.finalTotal}`,
    );
    return adjustedCalculation;
  }

  /**
   * Get tax rate for a region
   */
  getTaxRate(region: string): TaxRateConfig | undefined {
    return this.taxRates.get(region);
  }

  /**
   * Get all supported tax regions
   */
  getSupportedTaxRegions(): string[] {
    return Array.from(this.taxRates.keys());
  }

  /**
   * Get exchange rate between currencies
   * Validates staleness: rates older than 24 hours trigger a warning, older than 72 hours block non-USD billing.
   */
  getExchangeRate(from: string, to: string): number {
    if (from === to) return 1;

    const key = `${from}-${to}`;
    let rate = this.exchangeRates.get(key);

    if (!rate) {
      // Try reverse
      const reverseKey = `${to}-${from}`;
      const reverseRate = this.exchangeRates.get(reverseKey);
      if (reverseRate) {
        return 1 / reverseRate.rate;
      }
      throw new BadRequestException(`No exchange rate found for ${from} to ${to}`);
    }

    // Staleness check
    const ageMs = Date.now() - rate.updatedAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours > 72) {
      throw new BadRequestException(
        `Exchange rate ${from}->${to} is stale (${Math.floor(ageHours)}h old). Cannot bill in non-base currency until rates are refreshed.`,
      );
    }

    if (ageHours > 24) {
      this.logger.warn(
        `Exchange rate ${from}->${to} is ${Math.floor(ageHours)}h old. Rates should be refreshed.`,
      );
    }

    return rate.rate;
  }

  /**
   * Convert amount between currencies
   */
  convertCurrency(amount: number, from: string, to: string): number {
    const rate = this.getExchangeRate(from, to);
    return this.roundCurrency(amount * rate);
  }

  /**
   * Get pricing model for a plan tier
   */
  getPricingModel(planTier: PlanTier): Map<MeterType, MeterPricingModel> | undefined {
    return this.pricingModels.get(planTier);
  }

  /**
   * Update exchange rate
   */
  async updateExchangeRate(from: string, to: string, rate: number): Promise<void> {
    const key = `${from}-${to}`;
    this.exchangeRates.set(key, {
      from,
      to,
      rate,
      updatedAt: new Date(),
    });

    this.eventEmitter.emit('billing.exchange_rate.updated', { from, to, rate });
    this.logger.log(`Updated exchange rate ${from}/${to}: ${rate}`);
  }

  /**
   * MED-02: Invalidate the billing calculation cache whenever a subscription changes.
   * Without this, upgrades, downgrades, and cancellations would be invisible to the
   * billing engine for up to 5 minutes (the cache TTL).
   */
  @OnEvent('subscription.cancelled')
  @OnEvent('subscription.updated')
  @OnEvent('subscription.created')
  handleSubscriptionChange(event: { subscriptionId?: string; id?: string }): void {
    const subscriptionId = event.subscriptionId ?? event.id;
    if (subscriptionId) {
      this.clearCache(subscriptionId);
      this.logger.log(
        `Billing cache invalidated for subscription ${subscriptionId} on subscription change`,
      );
    } else {
      // Clear all if no specific subscription ID is available
      this.clearCache();
      this.logger.log(
        'Billing cache fully invalidated on subscription change event with no subscriptionId',
      );
    }
  }

  /**
   * Handle usage threshold breach event
   */
  @OnEvent('usage.threshold.breached')
  async handleThresholdBreach(event: {
    tenantId: string;
    meterType: MeterType;
    currentUsage: number;
    threshold: number;
    percentage: number;
  }): Promise<void> {
    this.logger.warn(
      `Usage threshold breached for tenant ${event.tenantId}: ` +
        `${event.meterType} at ${event.percentage.toFixed(1)}% (${event.currentUsage}/${event.threshold})`,
    );

    // Emit billing-specific event for potential overages
    this.eventEmitter.emit('billing.usage.high', {
      ...event,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Evict expired cache entries and enforce size limit
   */
  private evictExpiredCacheEntries(): void {
    const now = new Date();
    for (const [key, entry] of this.calculationCache) {
      if (entry.expiresAt <= now) {
        this.calculationCache.delete(key);
      }
    }
    // Enforce size limit by removing oldest entries
    if (this.calculationCache.size > MeteredBillingService.MAX_CACHE_SIZE) {
      const excess = this.calculationCache.size - MeteredBillingService.MAX_CACHE_SIZE;
      const iterator = this.calculationCache.keys();
      for (let i = 0; i < excess; i++) {
        const key = iterator.next().value;
        if (key) this.calculationCache.delete(key);
      }
    }
  }

  /**
   * Clear calculation cache
   */
  clearCache(subscriptionId?: string): void {
    if (subscriptionId) {
      // The cache key is the tenant-scoped shape built in calculateBilling:
      //   cache:metered-billing:<tenant>:billing-calculation:<subscriptionId>-<start>-<end>
      // so the subscriptionId is NOT the key prefix — matching on the exact
      // `:billing-calculation:<subscriptionId>-` segment is required. (A prior
      // `key.startsWith(subscriptionId)` match silently cleared nothing after
      // the BILLING-MEDIUM-006 key reshape, so the MED-02 subscription-change
      // invalidation @OnEvent path never actually flushed stale calculations.)
      const marker = `:billing-calculation:${subscriptionId}-`;
      const keysToDelete: string[] = [];
      for (const key of this.calculationCache.keys()) {
        if (key.includes(marker)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach((key) => this.calculationCache.delete(key));
      this.logger.log(`Cleared ${keysToDelete.length} cached calculations for ${subscriptionId}`);
    } else {
      const count = this.calculationCache.size;
      this.calculationCache.clear();
      this.logger.log(`Cleared all ${count} cached calculations`);
    }
  }

  // Helper methods

  private billingCycleToAggregationPeriod(cycle: BillingCycle): AggregationPeriod {
    switch (cycle) {
      case BillingCycle.MONTHLY:
        return AggregationPeriod.MONTHLY;
      case BillingCycle.QUARTERLY:
        return AggregationPeriod.QUARTERLY;
      case BillingCycle.SEMI_ANNUAL:
        // Use monthly aggregation for semi-annual and combine all 6 months in the range query
        return AggregationPeriod.MONTHLY;
      case BillingCycle.ANNUAL:
        return AggregationPeriod.YEARLY;
      default:
        return AggregationPeriod.MONTHLY;
    }
  }

  private roundCurrency(amount: number): number {
    return Math.round(amount * 100) / 100;
  }

  private daysBetween(start: Date, end: Date): number {
    const msPerDay = 24 * 60 * 60 * 1000;
    // Math.max(1, ...) ensures a same-day range is treated as 1 day, preventing
    // a zero pro-rata factor that would zero out the entire bill.
    return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / msPerDay));
  }

  private getProRataReasonDescription(reason: string): string {
    const descriptions: Record<string, string> = {
      upgrade: 'Plan upgrade - prorated for remaining period',
      downgrade: 'Plan downgrade - credit for unused portion',
      mid_cycle_start: 'Mid-cycle subscription start',
      cancellation: 'Subscription cancellation - credit for unused period',
    };
    return descriptions[reason] ?? reason;
  }
}
