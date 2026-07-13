import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';

import { Plan } from '../../entities/plan.entity';
import { PlanTier } from '../../entities/subscription.entity';
import { PlanSeedService } from '../plan-seed.service';

/**
 * Billing Revival Faz B (D4): the plan seed must include a permanent $0 FREE
 * catalog row. The provisioning handler resolves the catalog plan by tier+cycle,
 * so without a FREE billing.plans row a FREE tenant's provisioning throws
 * "No active billing catalog plan for tier=free".
 */
describe('PlanSeedService — FREE $0 plan (Faz B)', () => {
  const createdPlans: Array<Partial<Plan>> = [];

  const mockRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((data: Partial<Plan>) => {
      createdPlans.push(data);
      return data;
    }),
    save: jest.fn((plan: Partial<Plan>) => Promise.resolve(plan)),
  };

  const mockDataSource = {
    getRepository: jest.fn().mockReturnValue(mockRepo),
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
});
