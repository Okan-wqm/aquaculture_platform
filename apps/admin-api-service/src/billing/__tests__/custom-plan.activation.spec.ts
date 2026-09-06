/**
 * CustomPlanService.activatePlan — billing-service creates the subscription.
 *
 * ADMIN-HIGH-011: activation used to call an admin-api writer that always
 * answered 409, so no custom plan could ever be activated. It now sends the
 * `ProvisionTenantSubscription` command tenant provisioning sends, with
 * identifiers derived from the plan id so a retry replays billing's receipt.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BillingPlanTier } from '@platform/event-contracts';

import { Tenant } from '../../tenant/entities/tenant.entity';
import { CustomPlan, CustomPlanStatus } from '../entities/custom-plan.entity';
import { BillingAdminCommandClientService } from '../services/billing-admin-command-client.service';
import { CustomPlanService } from '../services/custom-plan.service';
import { ModulePricingService } from '../services/module-pricing.service';

const PLAN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const TENANT_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

function approvedPlan(overrides: Partial<CustomPlan> = {}): CustomPlan {
  return Object.assign(new CustomPlan(), {
    id: PLAN_ID,
    tenantId: TENANT_ID,
    name: 'Negotiated',
    tier: BillingPlanTier.CUSTOM,
    billingCycle: 'annual',
    status: CustomPlanStatus.APPROVED,
    modules: [
      {
        moduleId: 'mod-farm',
        moduleCode: 'farm',
        moduleName: 'Farm',
        quantities: { users: 10, farms: 2 },
        lineItems: [
          { metric: 'users', description: '10 users', quantity: 10, unitPrice: 5, total: 50 },
        ],
        subtotal: 300,
      },
      {
        moduleId: 'mod-sensor',
        moduleCode: 'sensor',
        moduleName: 'Sensor',
        quantities: { sensors: 40 },
        lineItems: [],
        subtotal: 100,
      },
    ],
    monthlySubtotal: 400,
    discountPercent: 0,
    discountAmount: 33.33,
    monthlyTotal: 366.67,
    currency: 'USD',
    subscriptionId: null,
    ...overrides,
  });
}

describe('CustomPlanService.activatePlan (ADMIN-HIGH-011)', () => {
  let service: CustomPlanService;
  const planRepo = { findOne: jest.fn(), save: jest.fn() };
  const tenantRepo = { findOne: jest.fn() };
  const billingCommands = { provisionTenantSubscription: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    planRepo.findOne.mockResolvedValue(approvedPlan());
    planRepo.save.mockImplementation(async (plan: CustomPlan) => plan);
    tenantRepo.findOne.mockResolvedValue({ id: TENANT_ID, name: 'Blue Fjord AS' });
    billingCommands.provisionTenantSubscription.mockResolvedValue({
      success: true,
      operationId: 'op',
      tenantId: TENANT_ID,
      subscriptionId: 'sub-1',
      receiptId: 'rcpt-1',
    });
    const module = await Test.createTestingModule({
      providers: [
        CustomPlanService,
        { provide: getRepositoryToken(CustomPlan), useValue: planRepo },
        { provide: getRepositoryToken(Tenant), useValue: tenantRepo },
        { provide: ModulePricingService, useValue: {} },
        { provide: BillingAdminCommandClientService, useValue: billingCommands },
      ],
    }).compile();
    service = module.get(CustomPlanService);
  });

  it('sends the billing provisioning command and records the subscription on the plan', async () => {
    const saved = await service.activatePlan(PLAN_ID, 'admin-user');

    expect(billingCommands.provisionTenantSubscription).toHaveBeenCalledTimes(1);
    const command = billingCommands.provisionTenantSubscription.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      tenantId: TENANT_ID,
      tenantName: 'Blue Fjord AS',
      actorId: 'admin-user',
      tier: 'enterprise',
      billingCycle: 'annual',
      moduleIds: ['mod-farm', 'mod-sensor'],
      customPlanId: PLAN_ID,
      idempotencyKey: `custom-plan:${PLAN_ID}:activate`,
    });
    expect(saved.subscriptionId).toBe('sub-1');
    expect(saved.status).toBe(CustomPlanStatus.ACTIVE);
    expect(planRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub-1' }),
    );
  });

  it('derives byte-identical command identifiers for the same plan, so a retry replays the receipt', () => {
    const first = service.buildProvisioningCommand(approvedPlan(), 'Blue Fjord AS', 'admin-user');
    const second = service.buildProvisioningCommand(approvedPlan(), 'Blue Fjord AS', 'admin-user');
    expect(second.operationId).toBe(first.operationId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.requestPayloadHash).toBe(first.requestPayloadHash);
    expect(first.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('allocates the plan discount across module rows in proportion to subtotal, summing exactly', () => {
    const command = service.buildProvisioningCommand(approvedPlan(), 'Blue Fjord AS', 'admin-user');
    const items = command.moduleItems ?? [];
    // ADR-0013: the provisioning contract carries exact decimal strings, so
    // the allocation is asserted as the text billing receives.
    expect(items.map((item) => item.discountAmount)).toEqual(['25', '8.33']);
    expect(items.map((item) => item.total)).toEqual(['275', '91.67']);
    expect(items.reduce((sum, item) => sum + Number(item.discountAmount), 0)).toBeCloseTo(33.33, 2);
    expect(items[0]).toMatchObject({
      moduleId: 'mod-farm',
      code: 'farm',
      name: 'Farm',
      quantities: { moduleId: 'mod-farm', users: 10, farms: 2 },
      subtotal: '300',
    });
  });

  it('passes a sellable tier through unchanged', () => {
    const command = service.buildProvisioningCommand(
      approvedPlan({ tier: BillingPlanTier.PROFESSIONAL }),
      'Blue Fjord AS',
      'admin-user',
    );
    expect(command.tier).toBe('professional');
  });

  it('refuses a plan that is not approved without touching billing', async () => {
    planRepo.findOne.mockResolvedValue(approvedPlan({ status: CustomPlanStatus.DRAFT }));
    await expect(service.activatePlan(PLAN_ID, 'admin-user')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(billingCommands.provisionTenantSubscription).not.toHaveBeenCalled();
    expect(planRepo.save).not.toHaveBeenCalled();
  });

  it('refuses when the plan names a tenant that does not exist', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    await expect(service.activatePlan(PLAN_ID, 'admin-user')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(billingCommands.provisionTenantSubscription).not.toHaveBeenCalled();
  });

  it('does not mark the plan active when billing returns no subscription id', async () => {
    billingCommands.provisionTenantSubscription.mockResolvedValue({
      success: true,
      operationId: 'op',
      tenantId: TENANT_ID,
    });
    await expect(service.activatePlan(PLAN_ID, 'admin-user')).rejects.toThrow(
      /without a subscription id/,
    );
    expect(planRepo.save).not.toHaveBeenCalled();
  });
});
