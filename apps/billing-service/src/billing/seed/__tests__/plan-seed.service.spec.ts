import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { BILLING_CYCLES } from '@platform/event-contracts';

import { Plan } from '../../entities/plan.entity';
import { BillingCycle, PlanTier } from '../../entities/subscription.entity';
import { PlanSeedService } from '../plan-seed.service';

/**
 * Billing Revival Faz B (D4): the plan seed must include a permanent $0 FREE
 * catalog row. Provisioning resolves the catalog plan by tier, so without a
 * FREE billing.plans row a FREE tenant's provisioning throws "No active
 * billing catalog plan for tier=free".
 *
 * BILLING-CRITICAL-003 added the second half: a plan is purchasable on a cycle
 * exactly when it carries a `plan_cycle_prices` row for it, and the seed wrote
 * monthly rows only — so quarterly, semi-annual and annual could not be sold
 * at all.
 */
type SavedBySeed = Partial<Plan> | Array<{ billingCycle: BillingCycle }>;

describe('PlanSeedService — FREE $0 plan (Faz B)', () => {
  const createdPlans: Array<Partial<Plan>> = [];

  const mockRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((data: Partial<Plan>) => {
      createdPlans.push(data);
      return data;
    }),
    // Two shapes reach save(): a Plan (with its cascade-inserted cycle prices)
    // and an array of PlanCyclePrice rows backfilled onto an existing plan.
    save: jest.fn((value: SavedBySeed) => Promise.resolve(value)),
  };

  // Entity-first EntityManager overloads: (Entity, options) rather than
  // getRepository(Entity).<op>(options) — the catalogue is cross-tenant.
  const mockDataSource = {
    manager: {
      findOne: jest.fn((_entity: unknown, options: unknown) => mockRepo.findOne(options)),
      create: jest.fn((_entity: unknown, data: Partial<Plan>) => mockRepo.create(data)),
      save: jest.fn((_entity: unknown, value: SavedBySeed) => mockRepo.save(value)),
    },
  };

  beforeEach(async () => {
    createdPlans.length = 0;
    jest.clearAllMocks();
    mockRepo.findOne.mockResolvedValue(null);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [PlanSeedService, { provide: DataSource, useValue: mockDataSource }],
    }).compile();

    const service = moduleRef.get<PlanSeedService>(PlanSeedService);
    await service.onModuleInit();
  });

  it('seeds a Free plan with tier FREE and a $0 base price', () => {
    const free = createdPlans.find((p) => p.tier === PlanTier.FREE);

    expect(free).toBeDefined();
    expect(free?.name).toBe('Free');
    expect(new Decimal(free!.basePrice as Decimal).toNumber()).toBe(0);
  });

  it('prices every FREE per-metric charge at $0', () => {
    const free = createdPlans.find((p) => p.tier === PlanTier.FREE);

    expect(free?.pricing).toMatchObject({
      basePrice: 0,
      perFarmPrice: 0,
      perSensorPrice: 0,
      perUserPrice: 0,
    });
  });

  it('projects FREE limits from the canonical PLAN_CATALOG', () => {
    const free = createdPlans.find((p) => p.tier === PlanTier.FREE);

    // PLAN_CATALOG FREE: maxUsers 3 / maxFarms 1 / maxPonds 5 / maxSensors 10.
    expect(free?.limits).toMatchObject({
      maxUsers: 3,
      maxFarms: 1,
      maxPonds: 5,
      maxSensors: 10,
    });
  });

  it('still seeds the paid tiers alongside FREE', () => {
    const tiers = createdPlans.map((p) => p.tier);
    expect(tiers).toEqual(
      expect.arrayContaining([
        PlanTier.FREE,
        PlanTier.STARTER,
        PlanTier.PROFESSIONAL,
        PlanTier.ENTERPRISE,
      ]),
    );
  });

  it('prices EVERY plan for EVERY billing cycle', () => {
    for (const plan of createdPlans) {
      const cycles = (plan.cyclePrices ?? []).map((price) => price.billingCycle);
      expect(cycles.sort()).toEqual([...BILLING_CYCLES].sort());
    }
  });

  it('derives each cycle price from the monthly rate by the rule that bills it', () => {
    const starter = createdPlans.find((p) => p.tier === PlanTier.STARTER);
    const byCycle = new Map(
      (starter?.cyclePrices ?? []).map((price) => [price.billingCycle, price]),
    );

    // $49/month: 147 gross quarterly less 5%, 588 gross annually less 15%.
    expect(byCycle.get(BillingCycle.MONTHLY)?.basePrice.toString()).toBe('49');
    expect(byCycle.get(BillingCycle.QUARTERLY)?.basePrice.toString()).toBe('139.65');
    expect(byCycle.get(BillingCycle.ANNUAL)?.basePrice.toString()).toBe('499.8');
    // The stored commitment discount is the one actually charged, not a
    // number the catalogue displays and nothing bills.
    expect(byCycle.get(BillingCycle.ANNUAL)?.discountPercent.toString()).toBe('15');
  });

  it('keeps a $0 plan at $0 on every cycle', () => {
    const free = createdPlans.find((p) => p.tier === PlanTier.FREE);
    for (const price of free?.cyclePrices ?? []) {
      expect(price.basePrice.isZero()).toBe(true);
    }
  });

  it('matches an existing plan by TIER, not by name', async () => {
    // A rename through the catalogue UI used to make the seed insert a SECOND
    // plan for the same tier; four cycles under one name would have collided.
    createdPlans.length = 0;
    jest.clearAllMocks();
    mockRepo.findOne.mockImplementation(({ where }: { where: { tier: PlanTier } }) =>
      Promise.resolve(
        where.tier === PlanTier.STARTER
          ? {
              id: 'plan-1',
              name: 'Starter (renamed by an operator)',
              tier: PlanTier.STARTER,
              cyclePrices: BILLING_CYCLES.map((billingCycle) => ({ billingCycle })),
            }
          : null,
      ),
    );

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [PlanSeedService, { provide: DataSource, useValue: mockDataSource }],
    }).compile();
    await moduleRef.get<PlanSeedService>(PlanSeedService).onModuleInit();

    expect(mockRepo.findOne.mock.calls[0][0].where).toMatchObject({ tier: PlanTier.FREE });
    expect(mockRepo.findOne.mock.calls[0][0].where).not.toHaveProperty('name');
    expect(createdPlans.map((p) => p.tier)).not.toContain(PlanTier.STARTER);
  });

  it('adds the cycles an already-seeded plan is missing, without touching its prices', async () => {
    createdPlans.length = 0;
    jest.clearAllMocks();
    const savedCyclePrices: Array<{ billingCycle: BillingCycle }> = [];
    mockRepo.findOne.mockImplementation(({ where }: { where: { tier: PlanTier } }) =>
      Promise.resolve(
        where.tier === PlanTier.STARTER
          ? {
              id: 'plan-1',
              name: 'Starter',
              tier: PlanTier.STARTER,
              // Seeded before per-cycle pricing existed.
              cyclePrices: [{ billingCycle: BillingCycle.MONTHLY }],
            }
          : null,
      ),
    );
    mockRepo.save.mockImplementation((value: SavedBySeed) => {
      if (Array.isArray(value)) {
        savedCyclePrices.push(...value);
      }
      return Promise.resolve(value);
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [PlanSeedService, { provide: DataSource, useValue: mockDataSource }],
    }).compile();
    await moduleRef.get<PlanSeedService>(PlanSeedService).onModuleInit();

    // The three that were missing — and NOT monthly, whose price an operator
    // may have edited.
    expect(savedCyclePrices.map((price) => price.billingCycle).sort()).toEqual(
      [BillingCycle.ANNUAL, BillingCycle.QUARTERLY, BillingCycle.SEMI_ANNUAL].sort(),
    );
  });

  it('fails the boot rather than coming up with an unsellable catalogue', async () => {
    // This used to be a logger.warn. A catalogue that failed to seed makes
    // every provisioning answer CATALOG_MISSING: healthy service, no sales.
    createdPlans.length = 0;
    jest.clearAllMocks();
    mockRepo.findOne.mockResolvedValue(null);
    mockRepo.save.mockRejectedValue(new Error('deadlock detected'));

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [PlanSeedService, { provide: DataSource, useValue: mockDataSource }],
    }).compile();

    await expect(moduleRef.get<PlanSeedService>(PlanSeedService).onModuleInit()).rejects.toThrow(
      'deadlock detected',
    );
  });
});
