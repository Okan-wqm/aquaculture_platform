/**
 * GetTenantBillingHandler Unit Tests
 *
 * A6 / DB-IDENT-MEDIUM-002 (ORPHAN-MEDIUM-382): the handler reads tenant
 * usage from the metering SSoT — persisted usage_aggregations rows via
 * UsageAggregatorService.getPersistedMonthUsage — and included quantities
 * from MeteredBillingService's per-plan-tier pricing model. The retired
 * billing.tenant_usage_metrics parallel model (which no code path ever
 * wrote) must not be involved anywhere.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { GetTenantBillingHandler } from '../query-handlers/get-tenant-billing.handler';
import { GetTenantBillingQuery } from '../queries/get-tenant-billing.query';
import {
  Subscription,
  SubscriptionStatus,
  BillingCycle,
  PlanTier,
} from '../entities/subscription.entity';
import { Invoice } from '../entities/invoice.entity';
import {
  UsageAggregatorService,
  MeterMonthUsage,
} from '../../modules/metering/usage-aggregator.service';
import {
  MeteredBillingService,
  MeterPricingModel,
} from '../../modules/metering/metered-billing.service';
import { MeterType } from '../../modules/metering/usage-metering.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-001';

function buildSubscription(): Partial<Subscription> {
  return {
    id: 'sub-001',
    tenantId: TENANT_ID,
    planTier: PlanTier.STARTER,
    planName: 'Starter',
    status: SubscriptionStatus.ACTIVE,
    billingCycle: BillingCycle.MONTHLY,
    limits: {
      maxFarms: 3,
      maxPonds: 10,
      maxSensors: 25,
      maxUsers: 5,
      dataRetentionDays: 90,
      alertsEnabled: true,
      reportsEnabled: true,
      apiAccessEnabled: true,
      customIntegrationsEnabled: false,
    },
    pricing: { basePrice: 99, currency: 'USD' },
    currentPeriodStart: new Date('2026-07-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  } as Partial<Subscription>;
}

function buildMonthUsage(): Map<MeterType, MeterMonthUsage> {
  return new Map<MeterType, MeterMonthUsage>([
    [
      MeterType.API_CALLS,
      { meterType: MeterType.API_CALLS, cumulativeTotal: 1234.4, latestLevel: 40 },
    ],
    [
      MeterType.SENSOR_READINGS,
      { meterType: MeterType.SENSOR_READINGS, cumulativeTotal: 500, latestLevel: 20 },
    ],
    [
      MeterType.DATA_STORAGE,
      { meterType: MeterType.DATA_STORAGE, cumulativeTotal: 90, latestLevel: 12.5 },
    ],
    [
      MeterType.FARMS_ACTIVE,
      { meterType: MeterType.FARMS_ACTIVE, cumulativeTotal: 60, latestLevel: 2 },
    ],
    [
      MeterType.SENSORS_ACTIVE,
      { meterType: MeterType.SENSORS_ACTIVE, cumulativeTotal: 300, latestLevel: 14 },
    ],
    [
      MeterType.USERS_ACTIVE,
      { meterType: MeterType.USERS_ACTIVE, cumulativeTotal: 120, latestLevel: 4 },
    ],
  ]);
}

function buildPricingModel(): Map<MeterType, MeterPricingModel> {
  const pricing = new Map<MeterType, MeterPricingModel>();
  const base = { meterId: 'm', displayName: 'm', unit: 'u', currency: 'USD', tiers: [] };
  pricing.set(MeterType.API_CALLS, {
    ...base,
    meterType: MeterType.API_CALLS,
    includedUnits: 10000,
  });
  pricing.set(MeterType.DATA_STORAGE, {
    ...base,
    meterType: MeterType.DATA_STORAGE,
    includedUnits: 5,
  });
  pricing.set(MeterType.SENSOR_READINGS, {
    ...base,
    meterType: MeterType.SENSOR_READINGS,
    includedUnits: 100000,
  });
  return pricing;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDataSource(subscription: Partial<Subscription> | null) {
  const subscriptionRepo = {
    metadata: { columns: [{ propertyName: 'tenantId' }] },
    findOne: jest.fn().mockResolvedValue(subscription),
  };
  const invoiceRepo = {
    metadata: { columns: [{ propertyName: 'tenantId' }] },
    find: jest.fn().mockResolvedValue([]),
  };
  return {
    getRepository: jest.fn().mockImplementation((entity: unknown) => {
      if (entity === Subscription) return subscriptionRepo;
      if (entity === Invoice) return invoiceRepo;
      throw new Error('Unexpected repository request in GetTenantBillingHandler spec');
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GetTenantBillingHandler', () => {
  let handler: GetTenantBillingHandler;
  let mockAggregator: { getPersistedMonthUsage: jest.Mock };
  let mockMeteredBilling: { getPricingModel: jest.Mock };

  async function buildHandler(
    subscription: Partial<Subscription> | null,
    usage: Map<MeterType, MeterMonthUsage>,
    pricing: Map<MeterType, MeterPricingModel> | undefined,
  ): Promise<void> {
    mockAggregator = { getPersistedMonthUsage: jest.fn().mockResolvedValue(usage) };
    mockMeteredBilling = { getPricingModel: jest.fn().mockReturnValue(pricing) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GetTenantBillingHandler,
        { provide: DataSource, useValue: createMockDataSource(subscription) },
        { provide: UsageAggregatorService, useValue: mockAggregator },
        { provide: MeteredBillingService, useValue: mockMeteredBilling },
      ],
    }).compile();

    handler = moduleRef.get(GetTenantBillingHandler);
  }

  it('reads month usage from the metering SSoT, pinned to the query tenant', async () => {
    await buildHandler(buildSubscription(), buildMonthUsage(), buildPricingModel());

    await handler.execute(new GetTenantBillingQuery(TENANT_ID));

    expect(mockAggregator.getPersistedMonthUsage).toHaveBeenCalledTimes(1);
    expect(mockAggregator.getPersistedMonthUsage).toHaveBeenCalledWith(TENANT_ID, expect.any(Date));
    expect(mockMeteredBilling.getPricingModel).toHaveBeenCalledWith(PlanTier.STARTER);
  });

  it('maps cumulative counters, gauge levels, and pricing-model included units into usageMetrics', async () => {
    await buildHandler(buildSubscription(), buildMonthUsage(), buildPricingModel());

    const result = await handler.execute(new GetTenantBillingQuery(TENANT_ID));

    expect(result.usageMetrics).toEqual({
      apiCallsThisMonth: 1234, // Int field — rounded from the decimal sum
      apiCallsLimit: 10000,
      storageUsedGb: 12.5, // gauge: latest bucket level, NOT the month sum
      storageLimit: 5,
      sensorReadingsThisMonth: 500,
      sensorReadingsLimit: 100000,
    });
  });

  it('maps gauge levels into planLimits current* and storage allowance from the pricing model', async () => {
    await buildHandler(buildSubscription(), buildMonthUsage(), buildPricingModel());

    const result = await handler.execute(new GetTenantBillingQuery(TENANT_ID));

    expect(result.planLimits).toEqual({
      maxFarms: 3,
      maxSensors: 25,
      maxUsers: 5,
      maxStorage: 5, // DATA_STORAGE includedUnits — no longer a hardcoded 0
      currentFarms: 2,
      currentSensors: 14,
      currentUsers: 4,
      currentStorage: 12.5,
    });
  });

  it('returns the zero-state usageMetrics when no aggregation rows exist', async () => {
    await buildHandler(buildSubscription(), new Map(), buildPricingModel());

    const result = await handler.execute(new GetTenantBillingQuery(TENANT_ID));

    expect(result.usageMetrics).toEqual({
      apiCallsThisMonth: 0,
      apiCallsLimit: 10000,
      storageUsedGb: 0,
      storageLimit: 5,
      sensorReadingsThisMonth: 0,
      sensorReadingsLimit: 100000,
    });
  });

  it('returns zero limits and null planLimits when the tenant has no subscription', async () => {
    await buildHandler(null, new Map(), undefined);

    const result = await handler.execute(new GetTenantBillingQuery(TENANT_ID));

    expect(result.subscription).toBeNull();
    expect(result.planLimits).toBeNull();
    expect(mockMeteredBilling.getPricingModel).not.toHaveBeenCalled();
    expect(result.usageMetrics).toEqual({
      apiCallsThisMonth: 0,
      apiCallsLimit: 0,
      storageUsedGb: 0,
      storageLimit: 0,
      sensorReadingsThisMonth: 0,
      sensorReadingsLimit: 0,
    });
  });
});
