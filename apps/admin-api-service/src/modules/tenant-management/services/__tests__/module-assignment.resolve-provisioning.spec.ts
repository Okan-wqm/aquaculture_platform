import { NotFoundException, Logger } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { PlanTier, BillingCycle } from '../../../../billing/entities/plan-definition.entity';
import { PricingCalculatorService } from '../../../../billing/services/pricing-calculator.service';
import { AuthTenantProvisioningClientService } from '../../../../tenant/services/auth-tenant-provisioning-client.service';
import { ModuleAssignmentService } from '../module-assignment.service';

/**
 * resolveProvisioningModuleItems is the admin-api side of the billing
 * subscription-break fix (ORPHAN-CRITICAL-393 / ORPHAN-HIGH-394): it resolves
 * module code/name (auth.modules) + real price (admin.module_pricing via
 * PricingCalculatorService) so billing can write module rows directly with no
 * cross-schema query and no invented $0 prices.
 */
describe('ModuleAssignmentService.resolveProvisioningModuleItems', () => {
  const MODULE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MODULE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  let service: ModuleAssignmentService;
  let calculatePricing: jest.Mock;

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

    // MODULE_A is priced; MODULE_B has no admin.module_pricing entry so the
    // calculator drops it from the breakdown (free/core tier).
    calculatePricing = jest.fn().mockResolvedValue({
      modules: [
        {
          moduleId: MODULE_A,
          moduleCode: 'FARM',
          moduleName: 'Farm Management',
          lineItems: [{ metric: 'base_price', total: 100 }],
          subtotal: 100,
          tierDiscount: 10,
          total: 100,
        },
      ],
      subtotal: 100,
      tierDiscount: 10,
      total: 100,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModuleAssignmentService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: EventBus, useValue: { publish: jest.fn() } },
        { provide: PricingCalculatorService, useValue: { calculatePricing } },
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
    });

    expect(items).toHaveLength(2);

    const farm = items.find((i) => i.moduleId === MODULE_A);
    expect(farm).toEqual({
      moduleId: MODULE_A,
      code: 'FARM',
      name: 'Farm Management',
      quantities: { moduleId: MODULE_A, farms: 2 },
      lineItems: [{ metric: 'base_price', total: 100 }],
      subtotal: 100,
      discountAmount: 10,
      total: 100,
    });

    // Unpriced module → $0 row, still resolved (free/core tier), never dropped.
    const sensor = items.find((i) => i.moduleId === MODULE_B);
    expect(sensor).toMatchObject({
      moduleId: MODULE_B,
      code: 'SENSOR',
      name: 'Sensors',
      subtotal: 0,
      discountAmount: 0,
      total: 0,
      lineItems: [],
    });

    expect(calculatePricing).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException when a selected module is absent from auth.modules', async () => {
    await expect(
      service.resolveProvisioningModuleItems({
        modules: [{ moduleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
        tier: PlanTier.STARTER,
        billingCycle: BillingCycle.MONTHLY,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
