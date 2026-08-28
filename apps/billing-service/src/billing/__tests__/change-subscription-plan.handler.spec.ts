import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { OutboxPublisher } from '@platform/outbox';
import { ChangeSubscriptionPlanHandler } from '../handlers/change-subscription-plan.handler';
import { ChangeSubscriptionPlanCommand } from '../commands/change-subscription-plan.command';
import { Subscription, SubscriptionStatus, PlanTier, BillingCycle } from '../entities/subscription.entity';
import { Plan } from '../entities/plan.entity';
import { ScheduledPlanChange } from '../entities/scheduled-plan-change.entity';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

describe('ChangeSubscriptionPlanHandler', () => {
  // SEC-MEDIUM-089: assertion handle onto the scheduled-change repo mock
  // biome-ignore lint: reassigned inside beforeEach
  let mockScheduledChangeRepoForAssertions: {
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let handler: ChangeSubscriptionPlanHandler;
  let mockDataSource: Partial<DataSource>;
  let mockSubscriptionRepo: Partial<Repository<Subscription>>;
  let mockPlanRepo: Partial<Repository<Plan>>;
  let mockManager: Partial<EntityManager>;
  let mockOutbox: { enqueue: jest.Mock };
  let mockStripe: { updateSubscription: jest.Mock };

  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const userId = 'user-123';
  const now = new Date('2026-03-14T12:00:00Z');

  const createMockSubscription = (overrides: Partial<Subscription> = {}): Subscription => ({
    id: 'sub-001',
    tenantId,
    planTier: PlanTier.STARTER,
    planName: 'Starter',
    status: SubscriptionStatus.ACTIVE,
    billingCycle: BillingCycle.MONTHLY,
    limits: {
      maxFarms: 3,
      maxPonds: 30,
      maxSensors: 20,
      maxUsers: 5,
      dataRetentionDays: 90,
      alertsEnabled: true,
      reportsEnabled: false,
      apiAccessEnabled: false,
      customIntegrationsEnabled: false,
    },
    pricing: {
      basePrice: 49,
      perFarmPrice: 10,
      perSensorPrice: 2,
      perUserPrice: 5,
      currency: 'USD',
    },
    startDate: new Date('2026-03-01T00:00:00Z'),
    currentPeriodStart: new Date('2026-03-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-03-31T00:00:00Z'),
    autoRenew: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    sanitize: jest.fn(),
    ...overrides,
  } as unknown as Subscription);

  const createMockPlan = (overrides: Partial<Plan> = {}): Plan => ({
    id: 'plan-pro-001',
    name: 'Professional',
    tier: PlanTier.PROFESSIONAL,
    basePrice: 149,
    currency: 'USD',
    billingCycle: BillingCycle.MONTHLY,
    limits: {
      maxFarms: 10,
      maxPonds: 100,
      maxSensors: 100,
      maxUsers: 25,
      dataRetentionDays: 365,
      alertsEnabled: true,
      reportsEnabled: true,
      apiAccessEnabled: true,
      customIntegrationsEnabled: false,
    },
    pricing: {
      basePrice: 149,
      perFarmPrice: 15,
      perSensorPrice: 3,
      perUserPrice: 8,
      currency: 'USD',
    },
    features: ['reports', 'api_access'],
    isActive: true,
    isPublic: true,
    sortOrder: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    sanitize: jest.fn(),
    ...overrides,
  } as unknown as Plan);

  beforeEach(async () => {
    mockSubscriptionRepo = {
      // create + save mirror the underlying TypeORM Repository surface that
      // TenantScopedRepository.save delegates to (create() then save()).
      create: jest.fn().mockImplementation((entity) => entity),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((sub) => Promise.resolve({ ...sub, version: (sub.version || 0) + 1 })),
    };

    mockPlanRepo = {
      findOne: jest.fn(),
    };

    // ScheduledPlanChange repo — the downgrade path supersedes any pending change
    // (update) then creates + saves a new one.
    const mockScheduledChangeRepo = {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn().mockImplementation((entity) => entity),
      save: jest.fn().mockImplementation((c) => Promise.resolve({ ...c, id: 'spc-001' })),
    };
    // Expose the same mock for cross-test assertions without re-fetching
    // it through the transaction manager.
    mockScheduledChangeRepoForAssertions = mockScheduledChangeRepo;

    mockManager = {
      getRepository: jest.fn().mockImplementation((entity) => {
        if (entity === Subscription) return mockSubscriptionRepo;
        if (entity === Plan) return mockPlanRepo;
        if (entity === ScheduledPlanChange) return mockScheduledChangeRepo;
        return {};
      }),
    };

    mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
    };

    mockOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    mockStripe = {
      updateSubscription: jest.fn().mockResolvedValue({ id: 'sub_test', status: 'active' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChangeSubscriptionPlanHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: mockOutbox },
        { provide: StripeApiService, useValue: mockStripe },
      ],
    }).compile();

    handler = module.get<ChangeSubscriptionPlanHandler>(ChangeSubscriptionPlanHandler);

    // Mock Date.now for consistent pro-rata calculations
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should upgrade from Starter to Professional immediately', async () => {
    const subscription = createMockSubscription();
    const plan = createMockPlan();

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    const result = await handler.execute(
      new ChangeSubscriptionPlanCommand(tenantId, {
        newPlanId: plan.id,
      }, userId),
    );

    expect(result.planTier).toBe(PlanTier.PROFESSIONAL);
    expect(result.planName).toBe('Professional');
    expect(result.limits.maxFarms).toBe(10);
    expect(result.pricing.basePrice).toBe(149);
    expect(result.updatedBy).toBe(userId);
  });


  // SEC-MEDIUM-089 (2026-08-23 scan №34): the pro-rata credit must be DURABLE.
  it('immediate change journals an APPLIED saga row carrying the pro-rata credit', async () => {
    const subscription = createMockSubscription();
    const plan = createMockPlan();
    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    await handler.execute(
      new ChangeSubscriptionPlanCommand(tenantId, { newPlanId: plan.id }, userId),
    );

    // The scheduled-change repository mock the transaction manager hands
    // back — assert on it directly rather than re-fetching it.
    const saved = mockScheduledChangeRepoForAssertions.save.mock.calls
      .map((call) => call[0])
      .find((row) => (row as { status?: string })?.status === 'APPLIED');
    expect(saved).toBeDefined();
    const saga = saved as { proRataCredit: number; isUpgrade: boolean; expectedSubscriptionVersion: number };
    expect(saga.proRataCredit).toBeGreaterThan(0);
    expect(saga.isUpgrade).toBe(true);
    expect(saga.expectedSubscriptionVersion).toBe(subscription.version);
  });

  it('syncs the Stripe subscription price on an immediate change (SSOT-C-12)', async () => {
    const subscription = createMockSubscription({
      stripeSubscriptionId: 'sub_live_1',
      billingCycle: BillingCycle.MONTHLY,
    });
    const plan = createMockPlan({ stripePriceIds: { [BillingCycle.MONTHLY]: 'price_pro_monthly' } });

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    await handler.execute(
      new ChangeSubscriptionPlanCommand(tenantId, { newPlanId: plan.id }, userId),
    );

    expect(mockStripe.updateSubscription).toHaveBeenCalledTimes(1);
    const args = mockStripe.updateSubscription.mock.calls[0][0];
    expect(args.subscriptionId).toBe('sub_live_1');
    expect(args.priceId).toBe('price_pro_monthly');
  });

  it('skips the Stripe price sync when the subscription has no Stripe id', async () => {
    const subscription = createMockSubscription(); // no stripeSubscriptionId
    const plan = createMockPlan({ stripePriceIds: { [BillingCycle.MONTHLY]: 'price_x' } });

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    await handler.execute(
      new ChangeSubscriptionPlanCommand(tenantId, { newPlanId: plan.id }, userId),
    );

    expect(mockStripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('should throw NotFoundException when subscription not found', async () => {
    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(null);

    await expect(
      handler.execute(
        new ChangeSubscriptionPlanCommand(tenantId, {
          newPlanId: 'plan-001',
        }, userId),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('should throw NotFoundException when plan not found', async () => {
    const subscription = createMockSubscription();
    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(null);

    await expect(
      handler.execute(
        new ChangeSubscriptionPlanCommand(tenantId, {
          newPlanId: 'nonexistent-plan',
        }, userId),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('should throw BadRequestException when plan is deactivated', async () => {
    const subscription = createMockSubscription();
    const plan = createMockPlan({ isActive: false });

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    await expect(
      handler.execute(
        new ChangeSubscriptionPlanCommand(tenantId, {
          newPlanId: plan.id,
        }, userId),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException for cancelled subscription', async () => {
    const subscription = createMockSubscription({
      status: SubscriptionStatus.CANCELLED,
    });

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);

    await expect(
      handler.execute(
        new ChangeSubscriptionPlanCommand(tenantId, {
          newPlanId: 'plan-001',
        }, userId),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw ConflictException when changing to the same plan', async () => {
    const subscription = createMockSubscription({
      planTier: PlanTier.PROFESSIONAL,
      planName: 'Professional',
    });
    const plan = createMockPlan();

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    await expect(
      handler.execute(
        new ChangeSubscriptionPlanCommand(tenantId, {
          newPlanId: plan.id,
        }, userId),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('should handle downgrade from Enterprise to Professional', async () => {
    const subscription = createMockSubscription({
      planTier: PlanTier.ENTERPRISE,
      planName: 'Enterprise',
      pricing: {
        basePrice: 499,
        perFarmPrice: 20,
        perSensorPrice: 5,
        perUserPrice: 10,
        currency: 'USD',
      },
    });
    const plan = createMockPlan(); // Professional

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    const result = await handler.execute(
      new ChangeSubscriptionPlanCommand(tenantId, {
        newPlanId: plan.id,
      }, userId),
    );

    // A downgrade with no `immediate` flag is SCHEDULED for period end — the
    // subscription stays on the current (Enterprise) plan until then (immediate
    // revocation would strip paid-for features mid-period; see the handler's
    // IP-2 note). A pending ScheduledPlanChange to Professional is created.
    expect(result.planTier).toBe(PlanTier.ENTERPRISE);
    expect(result.planName).toBe('Enterprise');
  });

  it('should allow trial subscriptions to change plans', async () => {
    const subscription = createMockSubscription({
      status: SubscriptionStatus.TRIAL,
    });
    const plan = createMockPlan();

    (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
    (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

    const result = await handler.execute(
      new ChangeSubscriptionPlanCommand(tenantId, {
        newPlanId: plan.id,
      }, userId),
    );

    expect(result.planTier).toBe(PlanTier.PROFESSIONAL);
  });

  describe('Transactional outbox publishing', () => {
    it('should enqueue SubscriptionUpdated and TenantSubscriptionChanged on the transactional manager', async () => {
      const subscription = createMockSubscription();
      const plan = createMockPlan();

      (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);

      await handler.execute(
        new ChangeSubscriptionPlanCommand(tenantId, { newPlanId: plan.id }, userId),
      );

      // Both the primary event and the auth.tenants projection must be enqueued
      // into the outbox on the SAME transactional manager so they commit
      // atomically with the subscription write — no fire-and-forget publish.
      expect(mockOutbox.enqueue).toHaveBeenCalledTimes(2);

      const [updatedEvent, updatedMgr] = mockOutbox.enqueue.mock.calls[0];
      expect(updatedEvent.eventType).toBe('SubscriptionUpdated');
      expect(updatedEvent.tier).toBe(PlanTier.PROFESSIONAL);
      expect(updatedMgr).toBe(mockManager);

      const [projectionEvent, projectionMgr] = mockOutbox.enqueue.mock.calls[1];
      expect(projectionEvent.eventType).toBe('TenantSubscriptionChanged');
      expect(projectionEvent.newPlan).toBe(PlanTier.PROFESSIONAL);
      expect(projectionMgr).toBe(mockManager);
    });

    it('should propagate enqueue failure so the plan change rolls back', async () => {
      const subscription = createMockSubscription();
      const plan = createMockPlan();

      (mockSubscriptionRepo.findOne as jest.Mock).mockResolvedValue(subscription);
      (mockPlanRepo.findOne as jest.Mock).mockResolvedValue(plan);
      mockOutbox.enqueue.mockRejectedValue(new Error('outbox down'));

      await expect(
        handler.execute(
          new ChangeSubscriptionPlanCommand(tenantId, { newPlanId: plan.id }, userId),
        ),
      ).rejects.toThrow('outbox down');
    });
  });
});
