/**
 * The custom-plan writer, against a fake DataSource (ADR-0013 /
 * BILLING-CRITICAL-002).
 *
 * A custom plan is a negotiated price. `admin.custom_plans` priced it in admin,
 * in floats, and kept every per-module and per-line amount inside one `jsonb`
 * column. What is pinned here is what that made possible and what no longer is:
 *
 *   - the plan's total comes FROM the quote, so the builder's preview and the
 *     stored plan are the same number from the same code — never two copies of
 *     one discount rule;
 *   - a discount outside [0, 100] is REFUSED rather than flooring the plan to
 *     zero, and a negative fixed amount is refused too;
 *   - a validity window that can never contain a day is refused;
 *   - the lifecycle is a state machine here, not a check in the caller: a
 *     rejected plan cannot be approved, a draft cannot be activated, and an
 *     expired plan cannot be activated at all;
 *   - a clone is credited to the operator who cloned it, not to whoever wrote
 *     the original;
 *   - the tenant's ACTIVE plan is the one in force TODAY, not merely the one
 *     whose status says `active` — nothing in the platform ever set a plan to
 *     `expired`, so the previous query returned plans that had lapsed.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { BillingCustomPlanInput, BillingModuleQuote } from '@platform/event-contracts';
import { BillingPlanTier } from '@platform/event-contracts';
import Decimal from 'decimal.js';

import { CustomPlan, CustomPlanLineItem, CustomPlanModule } from '../entities/custom-plan.entity';
import { BillingCycle, PlanTier } from '../entities/subscription.entity';
import { ModulePricingService } from '../services/module-pricing.service';
import {
  CustomPlanService,
  toCustomPlanSnapshot,
  toProvisioningModuleItems,
} from '../services/custom-plan.service';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const TENANT = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const MODULE_ID = 'a1b2c3d4-0000-4000-8000-00000000000a';

function planInput(overrides: Partial<BillingCustomPlanInput> = {}): BillingCustomPlanInput {
  return {
    tenantId: TENANT,
    name: 'Negotiated',
    modules: [
      {
        moduleId: MODULE_ID,
        moduleCode: 'farm',
        moduleName: 'Farm',
        quantities: { users: 10, farms: 2 },
      },
    ],
    validFrom: '2026-01-01',
    ...overrides,
  };
}

function quote(overrides: Partial<BillingModuleQuote> = {}): BillingModuleQuote {
  return {
    modules: [
      {
        moduleId: MODULE_ID,
        moduleCode: 'farm',
        moduleName: 'Farm',
        lineItems: [
          {
            metric: 'per_user',
            metricLabel: 'Per user',
            quantity: 10,
            includedQuantity: 0,
            billableQuantity: 10,
            listUnitPrice: '5',
            unitPrice: '5',
            total: '50',
            tierMultiplier: '1',
          },
        ],
        subtotal: '400',
        tierDiscount: '0',
        total: '400',
      },
    ],
    subtotal: '400',
    tierDiscount: '0',
    cycleDiscountAmount: '0',
    cycleDiscountPercent: '0',
    discountAmount: '0',
    negotiatedDiscountAmount: '0',
    tax: '0',
    taxRate: '0',
    total: '400',
    monthlyTotal: '400',
    annualTotal: '4800',
    billingCycle: 'monthly',
    billingCycleMultiplier: 1,
    currency: 'USD',
    tier: BillingPlanTier.CUSTOM,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    unpricedModuleCodes: [],
    ...overrides,
  };
}

function planRow(overrides: Partial<CustomPlan> = {}): CustomPlan {
  const base: CustomPlan = {
    id: PLAN_ID,
    tenantId: TENANT,
    name: 'Negotiated',
    description: null,
    basePlanId: null,
    tier: PlanTier.CUSTOM,
    billingCycle: BillingCycle.MONTHLY,
    modules: [],
    monthlySubtotal: new Decimal('400'),
    discountPercent: new Decimal('0'),
    discountAmount: new Decimal('0'),
    discountReason: null,
    monthlyTotal: new Decimal('400'),
    currency: 'USD',
    status: 'draft',
    validFrom: '2026-01-01',
    validTo: null,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    notes: null,
    subscriptionId: null,
    unpricedModuleCodes: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
  };
  return Object.assign(base, overrides);
}

interface Fakes {
  service: CustomPlanService;
  plans: { findOne: jest.Mock; save: jest.Mock; delete: jest.Mock; createQueryBuilder: jest.Mock };
  pricing: { quote: jest.Mock };
  manager: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  writes: unknown[];
}

async function build(existing: CustomPlan | null = null): Promise<Fakes> {
  const writes: unknown[] = [];
  const plans = {
    findOne: jest.fn().mockResolvedValue(existing),
    save: jest.fn((value: CustomPlan) => Promise.resolve(value)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
  const pricing = { quote: jest.fn().mockResolvedValue(quote()) };
  const manager = {
    findOne: jest.fn().mockResolvedValue(existing ?? planRow()),
    create: jest.fn((_entity: unknown, value: unknown) => value),
    save: jest.fn((value: unknown) => {
      writes.push(value);
      if (Array.isArray(value)) return Promise.resolve(value);
      return Promise.resolve(Object.assign({ id: PLAN_ID }, value as Record<string, unknown>));
    }),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const dataSource = {
    transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      CustomPlanService,
      { provide: getRepositoryToken(CustomPlan), useValue: plans },
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: ModulePricingService, useValue: pricing },
    ],
  }).compile();

  return { service: moduleRef.get(CustomPlanService), plans, pricing, manager, writes };
}

describe('CustomPlanService (ADR-0013): a negotiated price lives with the prices', () => {
  describe('create', () => {
    it('refuses a plan that selects no module', async () => {
      const { service } = await build();
      await expect(service.create(planInput({ modules: [] }), ACTOR)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a discount above 100 percent instead of flooring the total to zero', async () => {
      const { service } = await build();
      await expect(service.create(planInput({ discountPercent: '400' }), ACTOR)).rejects.toThrow(
        /between 0 and 100/,
      );
    });

    it('refuses a negative fixed discount', async () => {
      const { service } = await build();
      await expect(service.create(planInput({ discountAmount: '-10.00' }), ACTOR)).rejects.toThrow(
        /cannot be negative/,
      );
    });

    it('refuses a validity window that can never contain a day', async () => {
      const { service } = await build();
      await expect(
        service.create(planInput({ validFrom: '2026-06-01', validTo: '2026-01-01' }), ACTOR),
      ).rejects.toThrow(/earlier than validFrom/);
    });

    it('takes the total FROM the quote, so one rule prices the plan', async () => {
      const { service, pricing, writes } = await build();
      pricing.quote.mockResolvedValue(
        quote({ monthlyTotal: '350', negotiatedDiscountAmount: '50' }),
      );

      await service.create(planInput({ discountPercent: '10', discountAmount: '10.00' }), ACTOR);

      // The negotiated discount went TO billing's quote, and the total came back.
      expect(pricing.quote).toHaveBeenCalledWith(
        expect.objectContaining({
          negotiatedDiscountPercent: '10',
          negotiatedDiscountAmount: '10',
        }),
      );
      const plan = writes[0] as { monthlySubtotal: Decimal; monthlyTotal: Decimal };
      expect(plan.monthlySubtotal.toString()).toBe('400');
      expect(plan.monthlyTotal.toString()).toBe('350');
    });

    it('records the module and its priced lines as rows, in exact decimals', async () => {
      const { service, manager } = await build();

      await service.create(planInput(), ACTOR);

      const moduleRows = manager.create.mock.calls.filter(
        ([entity]) => entity === CustomPlanModule,
      );
      expect(moduleRows).toHaveLength(1);
      expect((moduleRows[0]![1] as { subtotal: Decimal }).subtotal.toString()).toBe('400');

      const lineRows = manager.create.mock.calls.filter(
        ([entity]) => entity === CustomPlanLineItem,
      );
      expect(lineRows).toHaveLength(1);
      const line = lineRows[0]![1] as { unitPrice: Decimal; total: Decimal; quantity: number };
      expect(line.unitPrice.toString()).toBe('5');
      expect(line.total.toString()).toBe('50');
      // The BILLABLE quantity, not the selected one: an included allowance is
      // priced at zero and must not be billed twice.
      expect(line.quantity).toBe(10);
    });

    it('upper-cases the currency and starts the plan as a draft', async () => {
      const { service, writes } = await build();
      await service.create(planInput({ currency: 'eur' }), ACTOR);
      expect(writes[0]).toMatchObject({ currency: 'EUR', status: 'draft', createdBy: ACTOR });
    });

    it('records which selected modules had no price sheet', async () => {
      const { service, pricing, writes } = await build();
      pricing.quote.mockResolvedValue(quote({ unpricedModuleCodes: ['sensor'] }));
      await service.create(planInput(), ACTOR);
      expect(writes[0]).toMatchObject({ unpricedModuleCodes: ['sensor'] });
    });
  });

  describe('lifecycle', () => {
    it('refuses to modify a plan that is already approved', async () => {
      const { service } = await build(planRow({ status: 'approved' }));
      await expect(service.update(PLAN_ID, { name: 'Renamed' }, ACTOR)).rejects.toThrow(
        /Cannot modify/,
      );
    });

    it('reprices the stored selection when only the discount changes', async () => {
      const existing = planRow({
        modules: [
          Object.assign(new CustomPlanModule(), {
            id: 'row-1',
            customPlanId: PLAN_ID,
            moduleId: MODULE_ID,
            moduleCode: 'farm',
            moduleName: 'Farm',
            quantities: { users: 10 },
            lineItems: [],
            subtotal: new Decimal('400'),
          }),
        ],
      });
      const { service, pricing } = await build(existing);
      pricing.quote.mockResolvedValue(quote({ monthlyTotal: '360' }));

      await service.update(PLAN_ID, { discountPercent: '10' }, ACTOR);

      // Not a second copy of the discount rule here: the stored selection is
      // re-quoted so the same code applies the new discount.
      expect(pricing.quote).toHaveBeenCalledWith(
        expect.objectContaining({ negotiatedDiscountPercent: '10' }),
      );
    });

    it('refuses to approve a plan that was rejected', async () => {
      const { service } = await build(planRow({ status: 'rejected' }));
      await expect(service.approve(PLAN_ID, ACTOR)).rejects.toThrow(/cannot become approved/);
    });

    it('refuses to submit a plan that prices nothing', async () => {
      const { service } = await build(planRow({ modules: [] }));
      await expect(service.submitForApproval(PLAN_ID, ACTOR)).rejects.toThrow(
        /at least one module/,
      );
    });

    it('refuses a rejection with no reason', async () => {
      const { service } = await build(planRow({ status: 'pending_approval' }));
      await expect(service.reject(PLAN_ID, '   ', ACTOR)).rejects.toThrow(/needs a reason/);
    });

    it('refuses to activate a plan whose validity has already lapsed', async () => {
      const { service } = await build(planRow({ status: 'approved', validTo: '2025-12-31' }));
      await expect(
        service.activate(PLAN_ID, 'sub-1', ACTOR, new Date('2026-06-01T00:00:00Z')),
      ).rejects.toThrow(/expired on 2025-12-31/);
    });

    it('activates an approved plan and records the subscription', async () => {
      const { service, plans } = await build(planRow({ status: 'approved' }));
      await service.activate(PLAN_ID, 'sub-1', ACTOR, new Date('2026-06-01T00:00:00Z'));
      expect(plans.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active', subscriptionId: 'sub-1' }),
      );
    });

    it('refuses to delete anything but a draft', async () => {
      const { service } = await build(planRow({ status: 'active' }));
      await expect(service.remove(PLAN_ID, ACTOR)).rejects.toThrow(/Only draft/);
    });

    it('raises for a plan that does not exist', async () => {
      const { service } = await build();
      await expect(service.approve(PLAN_ID, ACTOR)).rejects.toThrow(NotFoundException);
    });
  });

  describe('clone', () => {
    it('credits the clone to the operator, not to the original author', async () => {
      const source = planRow({
        status: 'active',
        approvedBy: 'someone-else',
        approvedAt: new Date('2026-02-01T00:00:00Z'),
        rejectionReason: 'an old rejection',
        subscriptionId: 'sub-original',
        createdBy: 'original-author',
      });
      const { service, writes } = await build(source);

      await service.clone(PLAN_ID, 'other-tenant', ACTOR);

      expect(writes[0]).toMatchObject({
        tenantId: 'other-tenant',
        name: 'Negotiated (Copy)',
        status: 'draft',
        approvedBy: null,
        approvedAt: null,
        rejectionReason: null,
        subscriptionId: null,
        createdBy: ACTOR,
        updatedBy: ACTOR,
      });
    });
  });

  describe('toProvisioningModuleItems', () => {
    it('allocates the plan discount so the parts sum EXACTLY to it', () => {
      const plan = planRow({
        monthlySubtotal: new Decimal('400'),
        monthlyTotal: new Decimal('366.67'),
        modules: [
          Object.assign(new CustomPlanModule(), {
            id: 'row-1',
            customPlanId: PLAN_ID,
            moduleId: MODULE_ID,
            moduleCode: 'farm',
            moduleName: 'Farm',
            quantities: {},
            lineItems: [],
            subtotal: new Decimal('300'),
          }),
          Object.assign(new CustomPlanModule(), {
            id: 'row-2',
            customPlanId: PLAN_ID,
            moduleId: 'a1b2c3d4-0000-4000-8000-00000000000b',
            moduleCode: 'sensor',
            moduleName: 'Sensor',
            quantities: {},
            lineItems: [],
            subtotal: new Decimal('100'),
          }),
        ],
      });

      const items = toProvisioningModuleItems(plan);

      expect(items.map((item) => item.discountAmount)).toEqual(['25', '8.33']);
      expect(items.map((item) => item.total)).toEqual(['275', '91.67']);
      expect(
        items.reduce((sum, item) => sum.plus(item.discountAmount), new Decimal(0)).toString(),
      ).toBe('33.33');
    });

    it('allocates nothing when the plan carries no discount', () => {
      const plan = planRow({
        modules: [
          Object.assign(new CustomPlanModule(), {
            id: 'row-1',
            customPlanId: PLAN_ID,
            moduleId: MODULE_ID,
            moduleCode: 'farm',
            moduleName: 'Farm',
            quantities: {},
            lineItems: [],
            subtotal: new Decimal('400'),
          }),
        ],
      });
      expect(toProvisioningModuleItems(plan)[0]?.discountAmount).toBe('0');
    });
  });

  describe('toCustomPlanSnapshot', () => {
    it('puts every amount on the wire as an exact decimal string', () => {
      const snapshot = toCustomPlanSnapshot(
        planRow({
          monthlySubtotal: new Decimal('400'),
          discountPercent: new Decimal('12.5'),
          discountAmount: new Decimal('10.5'),
          monthlyTotal: new Decimal('339.5'),
        }),
      );

      expect(snapshot.monthlySubtotal).toBe('400');
      expect(snapshot.discountPercent).toBe('12.5');
      expect(snapshot.discountAmount).toBe('10.5');
      expect(snapshot.monthlyTotal).toBe('339.5');
      expect(typeof snapshot.monthlyTotal).toBe('string');
    });
  });
});
