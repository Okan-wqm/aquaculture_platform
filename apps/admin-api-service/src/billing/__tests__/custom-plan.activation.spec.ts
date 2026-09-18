/**
 * `CustomPlanService.activate` — billing owns the plan AND the subscription
 * (ADR-0013, ADMIN-HIGH-011).
 *
 * The plan itself moved to `billing.custom_plans`; admin-api reads it through
 * the read-only mapping and orchestrates the two billing calls. What is pinned
 * here is the part admin still owns:
 *
 *   - the provisioning command's identifiers derive from the plan id, so a
 *     retry after a timeout replays billing's receipt instead of provisioning
 *     a second subscription;
 *   - the plan-level discount is allocated across module rows from the exact
 *     `numeric` amounts billing stored, summing EXACTLY to the plan's discount;
 *   - the irreversible provisioning call is not made for a plan that is not
 *     approved. billing refuses the transition authoritatively, but it refuses
 *     it AFTER the subscription would already exist.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BillingPlanTier } from '@platform/event-contracts';
import Decimal from 'decimal.js';

import { Tenant } from '../../tenant/entities/tenant.entity';
import {
  CustomPlanLineItemReadOnly,
  CustomPlanModuleReadOnly,
  CustomPlanReadOnly,
} from '../entities/external/custom-plan.entity';
import { BillingAdminCommandClientService } from '../services/billing-admin-command-client.service';
import { CustomPlanService } from '../services/custom-plan.service';

const PLAN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const TENANT_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

function lineItem(): CustomPlanLineItemReadOnly {
  const line = new CustomPlanLineItemReadOnly();
  line.id = 'line-1';
  line.customPlanModuleId = 'mod-row-1';
  line.metric = 'per_user';
  line.metricLabel = 'Per user';
  line.quantity = 10;
  line.unitPrice = new Decimal('5');
  line.total = new Decimal('50');
  return line;
}

function moduleRow(
  id: string,
  moduleId: string,
  code: string,
  name: string,
  subtotal: string,
  lineItems: CustomPlanLineItemReadOnly[] = [],
): CustomPlanModuleReadOnly {
  const row = new CustomPlanModuleReadOnly();
  row.id = id;
  row.customPlanId = PLAN_ID;
  row.moduleId = moduleId;
  row.moduleCode = code;
  row.moduleName = name;
  row.quantities = { users: 10, farms: 2 };
  row.lineItems = lineItems;
  row.subtotal = new Decimal(subtotal);
  return row;
}

function approvedPlan(overrides: Partial<CustomPlanReadOnly> = {}): CustomPlanReadOnly {
  const plan = new CustomPlanReadOnly();
  return Object.assign(plan, {
    id: PLAN_ID,
    tenantId: TENANT_ID,
    name: 'Negotiated',
    description: null,
    basePlanId: null,
    tier: BillingPlanTier.CUSTOM,
    billingCycle: 'annual',
    status: 'approved',
    modules: [
      moduleRow('mod-row-1', 'a1b2c3d4-0000-4000-8000-00000000000a', 'farm', 'Farm', '300', [
        lineItem(),
      ]),
      moduleRow('mod-row-2', 'a1b2c3d4-0000-4000-8000-00000000000b', 'sensor', 'Sensor', '100'),
    ],
    monthlySubtotal: new Decimal('400'),
    discountPercent: new Decimal('0'),
    discountAmount: new Decimal('33.33'),
    discountReason: null,
    monthlyTotal: new Decimal('366.67'),
    currency: 'USD',
    validFrom: '2026-01-01',
    validTo: null,
    approvedBy: 'approver',
    approvedAt: new Date('2026-01-02T00:00:00Z'),
    rejectionReason: null,
    notes: null,
    subscriptionId: null,
    unpricedModuleCodes: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  });
}

describe('CustomPlanService.activate (ADR-0013 / ADMIN-HIGH-011)', () => {
  let service: CustomPlanService;
  const planRepo = { findOne: jest.fn(), createQueryBuilder: jest.fn() };
  const tenantRepo = { findOne: jest.fn() };
  const billingCommands = {
    provisionTenantSubscription: jest.fn(),
    activateCustomPlan: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    planRepo.findOne.mockResolvedValue(approvedPlan());
    tenantRepo.findOne.mockResolvedValue({ id: TENANT_ID, name: 'Blue Fjord AS' });
    billingCommands.provisionTenantSubscription.mockResolvedValue({
      success: true,
      operationId: 'op',
      tenantId: TENANT_ID,
      subscriptionId: 'sub-1',
      receiptId: 'rcpt-1',
    });
    billingCommands.activateCustomPlan.mockImplementation(
      async (customPlanId: string, subscriptionId: string) => ({
        ...snapshotOf(approvedPlan()),
        id: customPlanId,
        status: 'active',
        subscriptionId,
      }),
    );

    const module = await Test.createTestingModule({
      providers: [
        CustomPlanService,
        { provide: getRepositoryToken(CustomPlanReadOnly), useValue: planRepo },
        { provide: getRepositoryToken(Tenant), useValue: tenantRepo },
        { provide: BillingAdminCommandClientService, useValue: billingCommands },
      ],
    }).compile();
    service = module.get(CustomPlanService);
  });

  it('provisions the subscription, then records it on the plan', async () => {
    const activated = await service.activate(PLAN_ID, 'admin-user');

    expect(billingCommands.provisionTenantSubscription).toHaveBeenCalledTimes(1);
    const command = billingCommands.provisionTenantSubscription.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      tenantId: TENANT_ID,
      tenantName: 'Blue Fjord AS',
      actorId: 'admin-user',
      // CUSTOM is not a billing-command tier: it travels as enterprise plus
      // its own customPlanId.
      tier: 'enterprise',
      billingCycle: 'annual',
      customPlanId: PLAN_ID,
      idempotencyKey: `custom-plan:${PLAN_ID}:activate`,
    });
    expect(billingCommands.activateCustomPlan).toHaveBeenCalledWith(PLAN_ID, 'sub-1', 'admin-user');
    expect(activated.status).toBe('active');
    expect(activated.subscriptionId).toBe('sub-1');
  });

  it('allocates the plan discount across module rows, summing exactly', async () => {
    await service.activate(PLAN_ID, 'admin-user');
    const command = billingCommands.provisionTenantSubscription.mock.calls[0]?.[0];
    const items: Array<{ discountAmount: string; total: string; subtotal: string }> =
      command.moduleItems;

    // 33.33 split 300:100 → 25.00 and the remainder, in USD minor units, and
    // the parts sum to the plan's discount to the cent.
    expect(items.map((item) => item.discountAmount)).toEqual(['25', '8.33']);
    expect(items.map((item) => item.total)).toEqual(['275', '91.67']);
    expect(
      items.reduce((sum, item) => sum.plus(item.discountAmount), new Decimal(0)).toString(),
    ).toBe('33.33');
  });

  it('derives byte-identical identifiers for the same plan, so a retry replays the receipt', async () => {
    await service.activate(PLAN_ID, 'admin-user');
    const first = billingCommands.provisionTenantSubscription.mock.calls[0]?.[0];

    jest.clearAllMocks();
    planRepo.findOne.mockResolvedValue(approvedPlan());
    tenantRepo.findOne.mockResolvedValue({ id: TENANT_ID, name: 'Blue Fjord AS' });
    billingCommands.provisionTenantSubscription.mockResolvedValue({
      success: true,
      operationId: 'op',
      tenantId: TENANT_ID,
      subscriptionId: 'sub-1',
    });
    billingCommands.activateCustomPlan.mockResolvedValue({
      ...snapshotOf(approvedPlan()),
      status: 'active',
      subscriptionId: 'sub-1',
    });
    await service.activate(PLAN_ID, 'admin-user');
    const second = billingCommands.provisionTenantSubscription.mock.calls[0]?.[0];

    expect(second.operationId).toBe(first.operationId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.requestPayloadHash).toBe(first.requestPayloadHash);
    expect(first.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('passes a sellable tier through unchanged', async () => {
    planRepo.findOne.mockResolvedValue(approvedPlan({ tier: BillingPlanTier.PROFESSIONAL }));
    await service.activate(PLAN_ID, 'admin-user');
    expect(billingCommands.provisionTenantSubscription.mock.calls[0]?.[0].tier).toBe(
      'professional',
    );
  });

  it('refuses a plan that is not approved WITHOUT provisioning anything', async () => {
    planRepo.findOne.mockResolvedValue(approvedPlan({ status: 'draft' }));

    await expect(service.activate(PLAN_ID, 'admin-user')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // The provisioning call is irreversible; billing's own guard would only
    // reject the transition after the subscription already existed.
    expect(billingCommands.provisionTenantSubscription).not.toHaveBeenCalled();
    expect(billingCommands.activateCustomPlan).not.toHaveBeenCalled();
  });

  it('refuses when the plan names a tenant that does not exist', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    await expect(service.activate(PLAN_ID, 'admin-user')).rejects.toBeInstanceOf(NotFoundException);
    expect(billingCommands.provisionTenantSubscription).not.toHaveBeenCalled();
  });

  it('does not mark the plan active when billing returns no subscription id', async () => {
    billingCommands.provisionTenantSubscription.mockResolvedValue({
      success: true,
      operationId: 'op',
      tenantId: TENANT_ID,
    });
    await expect(service.activate(PLAN_ID, 'admin-user')).rejects.toThrow(
      /without a subscription id/,
    );
    expect(billingCommands.activateCustomPlan).not.toHaveBeenCalled();
  });
});

/** The snapshot billing would reply with for a given row. */
function snapshotOf(plan: CustomPlanReadOnly): Record<string, unknown> {
  return {
    id: plan.id,
    tenantId: plan.tenantId,
    name: plan.name,
    tier: plan.tier,
    billingCycle: plan.billingCycle,
    modules: [],
    monthlySubtotal: plan.monthlySubtotal.toString(),
    discountPercent: plan.discountPercent.toString(),
    discountAmount: plan.discountAmount.toString(),
    monthlyTotal: plan.monthlyTotal.toString(),
    currency: plan.currency,
    status: plan.status,
    validFrom: plan.validFrom,
    unpricedModuleCodes: [],
    provisioningModuleItems: [],
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}
