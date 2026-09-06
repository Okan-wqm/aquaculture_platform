import { NotFoundException, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { PlanTier, BillingCycle } from '../../../../billing/entities/plan-definition.entity';
import { ModulePricingService } from '../../../../billing/services/module-pricing.service';
import { AuthTenantProvisioningClientService } from '../../../../tenant/services/auth-tenant-provisioning-client.service';
import { ModuleAssignmentService } from '../module-assignment.service';

/**
 * resolveProvisioningModuleItems is the admin-api side of the billing
 * subscription-break fix (ORPHAN-CRITICAL-393 / ORPHAN-HIGH-394): it resolves
 * module code/name from `auth.modules` — admin's grant — so billing can write
 * module rows directly with no cross-schema query and no invented $0 prices.
 *
 * ADR-0013 changed where the PRICE comes from: billing owns
 * `billing.module_prices` and the arithmetic, so admin ASKS for a quote and
 * passes the exact decimal strings straight through.
 */
describe('ModuleAssignmentService.resolveProvisioningModuleItems', () => {
  const MODULE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MODULE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ACTOR = '33333333-3333-4333-8333-333333333333';

  let service: ModuleAssignmentService;
  let quote: jest.Mock;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const mockDataSource = {
      // getModuleInfoMap → SELECT id, code, name, description, icon FROM auth.modules
      query: jest.fn().mockResolvedValue([
        { id: MODULE_A, code: 'FARM', name: 'Farm Management' },
        { id: MODULE_B, code: 'SENSOR', name: 'Sensors' },
      ]),
    };

    // MODULE_A is priced; MODULE_B has no active sheet, so billing leaves it
    // out of the breakdown and names it in `unpricedModuleCodes`.
    quote = jest.fn().mockResolvedValue({
      modules: [
        {
          moduleId: MODULE_A,
          moduleCode: 'FARM',
          moduleName: 'Farm Management',
          lineItems: [{ metric: 'base_price', total: '100' }],
          subtotal: '100',
          tierDiscount: '10',
          total: '100',
        },
      ],
      subtotal: '100',
      tierDiscount: '10',
      total: '100',
      unpricedModuleCodes: ['SENSOR'],
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModuleAssignmentService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: EventBus, useValue: { publish: jest.fn() } },
        { provide: ModulePricingService, useValue: { quote } },
        { provide: AuthTenantProvisioningClientService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(ModuleAssignmentService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('resolves priced items with real code/name/price and a $0 item for an unpriced module (no throw)', async () => {
    const items = await service.resolveProvisioningModuleItems({
      modules: [
        { moduleId: MODULE_A, quantities: { farms: 2 } },
        { moduleId: MODULE_B, quantities: { sensors: 5 } },
      ],
      tier: PlanTier.STARTER,
      billingCycle: BillingCycle.MONTHLY,
      actorId: ACTOR,
    });

    expect(items).toHaveLength(2);

    const farm = items.find((i) => i.moduleId === MODULE_A);
    expect(farm).toEqual({
      moduleId: MODULE_A,
      code: 'FARM',
      name: 'Farm Management',
      quantities: { moduleId: MODULE_A, farms: 2 },
      lineItems: [{ metric: 'base_price', total: '100' }],
      // ADR-0013: exact decimal strings, straight from billing's own quote.
      subtotal: '100',
      discountAmount: '10',
      total: '100',
    });

    // Unpriced module → $0 row, still resolved (free/core tier), never dropped.
    const sensor = items.find((i) => i.moduleId === MODULE_B);
    expect(sensor).toMatchObject({
      moduleId: MODULE_B,
      code: 'SENSOR',
      name: 'Sensors',
      subtotal: '0',
      discountAmount: '0',
      total: '0',
      lineItems: [],
    });

    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException when a selected module is absent from auth.modules', async () => {
    await expect(
      service.resolveProvisioningModuleItems({
        modules: [{ moduleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
        tier: PlanTier.STARTER,
        billingCycle: BillingCycle.MONTHLY,
        actorId: ACTOR,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
