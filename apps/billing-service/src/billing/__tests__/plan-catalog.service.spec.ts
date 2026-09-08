/**
 * The plan catalogue writer, against a fake DataSource (ADR-0013 /
 * BILLING-CRITICAL-002).
 *
 * The behaviours pinned here are the ones that made `admin.plan_definitions`
 * unsafe and are the reason this service replaced it:
 *
 *   - a price is validated against the constraints the columns CHECK, so a
 *     negative price or a `discountPercent` of 400 is refused instead of
 *     landing in a jsonb blob no constraint can reach;
 *   - a price change replaces the whole cycle set inside ONE transaction, so
 *     no reader observes a plan priced half old and half new;
 *   - decimals stay exact end to end — `19.99` in is `19.99` out, never
 *     19.989999999999998;
 *   - an update revises only what it names, and deprecation retires a plan
 *     rather than deleting a row live subscriptions still resolve.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { BillingPlanTier, type BillingPlanInput } from '@platform/event-contracts';
import Decimal from 'decimal.js';

import { PlanAddOn, PlanCyclePrice } from '../entities/plan-catalog.entity';
import { Plan, PlanVisibility } from '../entities/plan.entity';
import { BillingCycle } from '../entities/subscription.entity';
import { PlanCatalogService, toPlanSnapshot } from '../services/plan-catalog.service';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const PLAN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

function planInput(overrides: Partial<BillingPlanInput> = {}): BillingPlanInput {
  return {
    code: 'starter_2026',
    name: 'Starter',
    tier: BillingPlanTier.STARTER,
    currency: 'usd',
    limits: {
      maxUsers: 5,
      maxFarms: 2,
      maxPonds: 10,
      maxSensors: 20,
      maxModules: 3,
      storageGB: 50,
      dataRetentionDays: 365,
      apiRateLimit: 100,
      alertsEnabled: true,
      reportsEnabled: true,
      customBrandingEnabled: false,
      apiAccessEnabled: false,
      customIntegrationsEnabled: false,
      ssoEnabled: false,
      auditLogEnabled: true,
      prioritySupport: false,
      dedicatedAccountManager: false,
    },
    cyclePrices: [
      {
        billingCycle: 'monthly',
        basePrice: '19.99',
        perUserPrice: '5.00',
        perFarmPrice: '10.00',
        perModulePrice: '4.00',
        discountPercent: '0',
      },
    ],
    ...overrides,
  };
}

function planRow(overrides: Partial<Plan> = {}): Plan {
  const base: Plan = {
    id: PLAN_ID,
    code: 'starter_2026',
    name: 'Starter',
    description: null,
    shortDescription: null,
    tier: BillingPlanTier.STARTER,
    currency: 'USD',
    billingCycle: BillingCycle.MONTHLY,
    visibility: PlanVisibility.PUBLIC,
    isRecommended: false,
    basePrice: new Decimal('19.99'),
    pricing: {
      basePrice: 19.99,
      perUserPrice: 5,
      perFarmPrice: 10,
      perSensorPrice: 0,
      currency: 'USD',
    },
    limits: planInput().limits,
    features: { coreFeatures: [], advancedFeatures: [], premiumFeatures: [] },
    cyclePrices: [],
    addOns: [],
    isActive: true,
    isPublic: true,
    sortOrder: 0,
    trialDays: null,
    gracePeriodDays: null,
    upgradeMessage: null,
    downgradeWarning: null,
    icon: null,
    color: null,
    badge: null,
    stripeProductId: null,
    stripePriceIds: null,
    version: 1,
    isDeleted: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: undefined,
    updatedBy: undefined,
    // `Plan` extends the soft-delete base class, so a fixture that is a real
    // `Plan` carries its methods too — no cast, so a column added to the
    // entity fails this file until the fixture declares it.
    softDelete(): void {
      base.isDeleted = true;
    },
    sanitize(): Plan {
      return base;
    },
  };
  return Object.assign(base, overrides);
}

interface Fakes {
  service: PlanCatalogService;
  plans: { findOne: jest.Mock; save: jest.Mock };
  manager: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  /** Everything `save` was handed, in order — the transaction's write log. */
  writes: unknown[];
}

async function build(existing: Plan | null = null): Promise<Fakes> {
  const writes: unknown[] = [];
  const plans = {
    findOne: jest.fn().mockResolvedValue(existing),
    save: jest.fn((value: Plan) => Promise.resolve(value)),
  };

  const manager = {
    findOne: jest.fn().mockResolvedValue(existing ?? planRow()),
    create: jest.fn((_entity: unknown, value: unknown) => value),
    save: jest.fn((value: unknown) => {
      writes.push(value);
      const row = Array.isArray(value) ? value[0] : value;
      return Promise.resolve(
        Array.isArray(value)
          ? value
          : Object.assign({ id: PLAN_ID }, row as Record<string, unknown>),
      );
    }),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };

  const dataSource = {
    transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      PlanCatalogService,
      { provide: getRepositoryToken(Plan), useValue: plans },
      { provide: getDataSourceToken(), useValue: dataSource },
    ],
  }).compile();

  return { service: moduleRef.get(PlanCatalogService), plans, manager, writes };
}

describe('PlanCatalogService (ADR-0013): billing is the only plan catalogue', () => {
  describe('create', () => {
    it('refuses a plan that prices no cycle at all', async () => {
      const { service } = await build();

      await expect(service.create(planInput({ cyclePrices: [] }), ACTOR)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses the same cycle priced twice', async () => {
      const { service } = await build();
      const monthly = planInput().cyclePrices[0]!;

      await expect(
        service.create(planInput({ cyclePrices: [monthly, { ...monthly }] }), ACTOR),
      ).rejects.toThrow(/priced twice/);
    });

    it('refuses a negative price', async () => {
      const { service } = await build();
      const monthly = planInput().cyclePrices[0]!;

      await expect(
        service.create(planInput({ cyclePrices: [{ ...monthly, perUserPrice: '-1.00' }] }), ACTOR),
      ).rejects.toThrow(/negative/);
    });

    it('refuses a cycle discount outside [0, 100]', async () => {
      const { service } = await build();
      const monthly = planInput().cyclePrices[0]!;

      await expect(
        service.create(planInput({ cyclePrices: [{ ...monthly, discountPercent: '400' }] }), ACTOR),
      ).rejects.toThrow(/between 0 and 100/);
    });

    it('refuses a currency that is not an ISO-4217 code', async () => {
      const { service } = await build();

      await expect(service.create(planInput({ currency: 'dollars' }), ACTOR)).rejects.toThrow(
        /ISO-4217/,
      );
    });

    it('refuses a name another plan already holds', async () => {
      const { service, plans } = await build();
      plans.findOne.mockResolvedValueOnce(planRow());

      await expect(service.create(planInput(), ACTOR)).rejects.toThrow(ConflictException);
    });

    it('refuses a code another plan already holds', async () => {
      const { service, plans } = await build();
      plans.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(planRow());

      await expect(service.create(planInput(), ACTOR)).rejects.toThrow(/code/);
    });

    it('keeps the price exact and upper-cases the currency', async () => {
      const { service, manager, writes } = await build();

      await service.create(planInput(), ACTOR);

      const plan = writes[0] as { currency: string; basePrice: Decimal };
      expect(plan.currency).toBe('USD');
      expect(plan.basePrice.toString()).toBe('19.99');

      const cycleRows = manager.create.mock.calls.filter(([entity]) => entity === PlanCyclePrice);
      expect(cycleRows).toHaveLength(1);
      const row = cycleRows[0]![1] as { basePrice: Decimal; billingCycle: BillingCycle };
      // Exact, and the entity's own enum member — not the wire literal, which
      // TypeORM would persist as a value the column's enum does not accept.
      expect(row.basePrice.toString()).toBe('19.99');
      expect(row.billingCycle).toBe(BillingCycle.MONTHLY);
    });

    it('records the actor on both audit columns', async () => {
      const { service, writes } = await build();

      await service.create(planInput(), ACTOR);

      expect(writes[0]).toMatchObject({ createdBy: ACTOR, updatedBy: ACTOR });
    });
  });

  describe('update', () => {
    it('raises for a plan that does not exist', async () => {
      const { service } = await build();

      await expect(service.update(PLAN_ID, { name: 'Renamed' }, ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('revises only the fields the caller named', async () => {
      const { service, writes } = await build(planRow());

      await service.update(PLAN_ID, { sortOrder: 7 }, ACTOR);

      expect(writes[0]).toMatchObject({
        sortOrder: 7,
        name: 'Starter',
        code: 'starter_2026',
        updatedBy: ACTOR,
      });
    });

    it('replaces the whole cycle set rather than merging into it', async () => {
      const { service, manager } = await build(planRow());

      await service.update(
        PLAN_ID,
        {
          cyclePrices: [
            {
              billingCycle: 'annual',
              basePrice: '199.00',
              perUserPrice: '4.00',
              perFarmPrice: '9.00',
              perModulePrice: '3.00',
              discountPercent: '17',
            },
          ],
        },
        ACTOR,
      );

      // Deleted then re-inserted inside the caller's transaction: a reader
      // cannot observe the plan priced half old and half new.
      expect(manager.delete).toHaveBeenCalledWith(PlanCyclePrice, { planId: PLAN_ID });
      const cycleRows = manager.create.mock.calls.filter(([entity]) => entity === PlanCyclePrice);
      expect(cycleRows).toHaveLength(1);
      expect((cycleRows[0]![1] as { billingCycle: BillingCycle }).billingCycle).toBe(
        BillingCycle.ANNUAL,
      );
    });

    it('validates a revised price with the same rules as a new one', async () => {
      const { service } = await build(planRow());

      await expect(
        service.update(
          PLAN_ID,
          {
            cyclePrices: [
              {
                billingCycle: 'monthly',
                basePrice: '-1.00',
                perUserPrice: '0',
                perFarmPrice: '0',
                perModulePrice: '0',
                discountPercent: '0',
              },
            ],
          },
          ACTOR,
        ),
      ).rejects.toThrow(/negative/);
    });

    it('clears the add-ons when an empty list is sent, but leaves them alone when absent', async () => {
      const withAddOn = await build(planRow());
      await withAddOn.service.update(PLAN_ID, { addOns: [] }, ACTOR);
      expect(withAddOn.manager.delete).toHaveBeenCalledWith(PlanAddOn, { planId: PLAN_ID });

      const untouched = await build(planRow());
      await untouched.service.update(PLAN_ID, { sortOrder: 2 }, ACTOR);
      expect(untouched.manager.delete).not.toHaveBeenCalled();
    });
  });

  describe('deprecate', () => {
    it('retires the plan instead of deleting a row subscriptions resolve', async () => {
      const { service, plans } = await build(planRow());

      await service.deprecate(PLAN_ID, ACTOR);

      expect(plans.save).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: PlanVisibility.DEPRECATED,
          isActive: false,
          isPublic: false,
          updatedBy: ACTOR,
        }),
      );
    });
  });

  describe('toPlanSnapshot', () => {
    it('puts every price on the wire as an exact decimal string', () => {
      const snapshot = toPlanSnapshot(
        planRow({
          cyclePrices: [
            {
              id: 'c1',
              planId: PLAN_ID,
              billingCycle: BillingCycle.MONTHLY,
              basePrice: new Decimal('19.99'),
              perUserPrice: new Decimal('5'),
              perFarmPrice: new Decimal('10'),
              perModulePrice: new Decimal('4'),
              discountPercent: new Decimal('0'),
            },
          ],
          addOns: [
            {
              id: 'a1',
              planId: PLAN_ID,
              code: 'sms',
              name: 'SMS pack',
              description: null,
              price: new Decimal('7.5'),
              billingCycle: BillingCycle.MONTHLY,
            },
          ],
        }),
      );

      expect(snapshot.cyclePrices[0]).toMatchObject({
        billingCycle: 'monthly',
        basePrice: '19.99',
      });
      expect(snapshot.addOns[0]).toMatchObject({ code: 'sms', price: '7.5' });
      expect(typeof snapshot.cyclePrices[0]!.basePrice).toBe('string');
    });
  });
});
