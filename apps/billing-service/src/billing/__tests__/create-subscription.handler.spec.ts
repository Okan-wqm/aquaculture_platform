/**
 * CreateSubscriptionHandler Unit Tests
 *
 * Tests the CQRS command handler for subscription creation including:
 * - Transaction management (commit / rollback)
 * - Pessimistic locking for duplicate prevention
 * - Pricing validation (D09-F01 minimum prices per tier)
 * - Trial period handling
 * - Redis cache invalidation
 * - NATS event publishing
 */

import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RedisService } from '@aquaculture/backend-common/redis';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateSubscriptionHandler } from '../../billing/handlers/create-subscription.handler';
import { Plan } from '../../billing/entities/plan.entity';
import { CreateSubscriptionCommand } from '../../billing/commands/create-subscription.command';
import { CreateSubscriptionInput } from '../../billing/dto/create-subscription.input';
import { SubscriptionWriterService } from '../../billing/services/subscription-writer.service';
import {
  Subscription,
  SubscriptionStatus,
  BillingCycle,
  PlanTier,
} from '../../billing/entities/subscription.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInput(overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput {
  return {
    planTier: PlanTier.PROFESSIONAL,
    planName: 'Professional Plan',
    billingCycle: BillingCycle.MONTHLY,
    limits: {
      maxFarms: 10,
      maxPonds: 50,
      maxSensors: 200,
      maxUsers: 20,
      dataRetentionDays: 365,
      alertsEnabled: true,
      reportsEnabled: true,
      apiAccessEnabled: true,
      customIntegrationsEnabled: false,
    },
    pricing: {
      basePrice: 199,
      perFarmPrice: 10,
      perSensorPrice: 2,
      perUserPrice: 5,
      currency: 'USD',
    },
    ...overrides,
  } as CreateSubscriptionInput;
}

function buildCommand(
  inputOverrides: Partial<CreateSubscriptionInput> = {},
  tenantId = 'tenant-001',
  userId = 'user-001',
): CreateSubscriptionCommand {
  return new CreateSubscriptionCommand(tenantId, buildInput(inputOverrides), userId);
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data: any) => ({ ...data, id: 'sub-uuid-001' })),
    save: jest.fn((entity: any) => Promise.resolve({ ...entity, id: entity.id || 'sub-uuid-001' })),
    delete: jest.fn(),
  };
}

function createMockQueryRunner(mockRepo: ReturnType<typeof createMockRepository>): jest.Mocked<Partial<QueryRunner>> {
  return {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn().mockReturnValue(mockRepo),
      // ADR-0014: the row write moved into SubscriptionWriterService, which
      // uses the entity-first EntityManager overloads. Both surfaces land on
      // the same fake, so the assertions below still describe the row that is
      // actually written.
      create: jest.fn((_entity: unknown, data: any) => mockRepo.create(data)),
      save: jest.fn((_entity: unknown, data: any) => mockRepo.save(data)),
    } as any,
  };
}

function createMockDataSource(qr: ReturnType<typeof createMockQueryRunner>): jest.Mocked<Partial<DataSource>> {
  return {
    createQueryRunner: jest.fn().mockReturnValue(qr),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateSubscriptionHandler', () => {
  let handler: CreateSubscriptionHandler;
  let mockRepo: ReturnType<typeof createMockRepository>;
  let mockQR: ReturnType<typeof createMockQueryRunner>;
  let mockDS: ReturnType<typeof createMockDataSource>;
  let mockOutbox: { enqueue: jest.Mock };
  let mockStripe: { createCustomer: jest.Mock; createSubscription: jest.Mock };
  let mockPlanRepo: { findOne: jest.Mock };
  let mockRedisService: { del: jest.Mock };

  beforeEach(async () => {
    mockRepo = createMockRepository();
    mockQR = createMockQueryRunner(mockRepo);
    mockDS = createMockDataSource(mockQR);
    mockOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    mockStripe = {
      createCustomer: jest.fn().mockResolvedValue({ id: 'cus_test', email: null, metadata: {} }),
      createSubscription: jest.fn().mockResolvedValue({
        id: 'sub_test',
        customer: 'cus_test',
        status: 'active',
        currentPeriodStartIso: '2026-01-01T00:00:00.000Z',
        currentPeriodEndIso: '2026-02-01T00:00:00.000Z',
        metadata: {},
      }),
    };
    // Default: no Stripe price configured → local-only path (no Stripe calls).
    mockPlanRepo = { findOne: jest.fn().mockResolvedValue(null) };
    mockRedisService = { del: jest.fn().mockResolvedValue(1) };

    // DI-provided mocks (useValue is untyped) avoid hand-written casts on the
    // handler's DataSource / OutboxPublisher / StripeApiService / Plan-repo deps.
    const moduleRef = await Test.createTestingModule({
      providers: [
        CreateSubscriptionHandler,
        { provide: DataSource, useValue: mockDS },
        { provide: OutboxPublisher, useValue: mockOutbox },
        { provide: StripeApiService, useValue: mockStripe },
        { provide: getRepositoryToken(Plan), useValue: mockPlanRepo },
        { provide: RedisService, useValue: mockRedisService },
        // The REAL writer: this spec asserts the row and the outbox event that
        // actually get written, so mocking it away would test nothing.
        SubscriptionWriterService,
      ],
    }).compile();
    handler = moduleRef.get(CreateSubscriptionHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // SUCCESSFUL CREATION
  // ==========================================================================

  describe('Successful subscription creation', () => {
    it('should create a subscription inside a transaction and commit', async () => {
      // Arrange - no existing subscription
      mockRepo.findOne.mockResolvedValue(null);

      // Act
      const result = await handler.execute(buildCommand());

      // Assert - transaction lifecycle
      expect(mockQR.connect).toHaveBeenCalledTimes(1);
      expect(mockQR.startTransaction).toHaveBeenCalledWith('READ COMMITTED');
      expect(mockQR.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mockQR.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQR.release).toHaveBeenCalledTimes(1);

      // Assert - subscription fields
      expect(result).toBeDefined();
      expect(result.tenantId).toBe('tenant-001');
      expect(result.planTier).toBe(PlanTier.PROFESSIONAL);
      expect(result.status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('should set billing period correctly for MONTHLY cycle', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const startDate = '2026-01-15T00:00:00.000Z';
      const result = await handler.execute(buildCommand({ startDate }));

      const start = new Date(startDate);
      expect(result.currentPeriodStart).toEqual(start);
      // Monthly: 1 month later
      expect(result.currentPeriodEnd.getMonth()).toBe(start.getMonth() + 1);
    });

    it('should set billing period correctly for ANNUAL cycle', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const startDate = '2026-03-01T00:00:00.000Z';
      const result = await handler.execute(
        buildCommand({ billingCycle: BillingCycle.ANNUAL, startDate }),
      );

      expect(result.currentPeriodEnd.getFullYear()).toBe(2027);
      expect(result.currentPeriodEnd.getMonth()).toBe(2); // March
    });

    it('should handle trial period and set TRIAL status', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const startDate = '2026-03-01T00:00:00.000Z';
      const result = await handler.execute(buildCommand({ trialDays: 14, startDate }));

      expect(result.status).toBe(SubscriptionStatus.TRIAL);
      expect(result.trialEndDate).toBeDefined();

      const expectedTrialEnd = new Date(startDate);
      expectedTrialEnd.setDate(expectedTrialEnd.getDate() + 14);
      expect(result.trialEndDate!.toISOString()).toBe(expectedTrialEnd.toISOString());
    });

    it('should default autoRenew to true when not specified', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await handler.execute(buildCommand());

      expect(result.autoRenew).toBe(true);
    });

    it('should default currency to USD when not provided', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await handler.execute(
        buildCommand({ pricing: { basePrice: 199, currency: undefined } as any }),
      );

      expect(result.pricing.currency).toBe('USD');
    });
  });

  // ==========================================================================
  // DUPLICATE SUBSCRIPTION PREVENTION
  // ==========================================================================

  describe('Duplicate subscription prevention', () => {
    it('should reject when an active subscription already exists', async () => {
      mockRepo.findOne.mockResolvedValue({
        id: 'existing-sub',
        tenantId: 'tenant-001',
        status: SubscriptionStatus.ACTIVE,
      });

      await expect(handler.execute(buildCommand())).rejects.toThrow(ConflictException);
      await expect(handler.execute(buildCommand())).rejects.toThrow(
        'Active subscription already exists for tenant tenant-001',
      );

      // Transaction should be rolled back
      expect(mockQR.rollbackTransaction).toHaveBeenCalled();
      expect(mockQR.release).toHaveBeenCalled();
    });

    it('should reject when a TRIAL subscription already exists', async () => {
      mockRepo.findOne.mockResolvedValue({
        id: 'trial-sub',
        tenantId: 'tenant-001',
        status: SubscriptionStatus.TRIAL,
      });

      await expect(handler.execute(buildCommand())).rejects.toThrow(ConflictException);
    });

    it('should allow creating a new subscription after a CANCELLED one (soft-deletes old, preserves history)', async () => {
      // BILLING-MEDIUM-004 cure: pre-cure used hard delete which destroyed
      // the audit trail for invoices+payments tied to the cancelled
      // subscription. Post-cure the row is SOFT-deleted (isDeleted=true,
      // deletedAt set) so it stays for billing reconciliation.
      const cancelledSub = {
        id: 'cancelled-sub',
        tenantId: 'tenant-001',
        status: SubscriptionStatus.CANCELLED,
        isDeleted: false,
        deletedAt: undefined as Date | undefined,
        deletedBy: undefined as string | undefined,
        softDelete(deletedBy?: string): void {
          this.isDeleted = true;
          this.deletedAt = new Date();
          this.deletedBy = deletedBy;
        },
      };
      mockRepo.findOne.mockResolvedValue(cancelledSub);

      const result = await handler.execute(buildCommand());

      // Old cancelled subscription is now SOFT-deleted, not hard-deleted.
      // The hard-delete call must NOT have been made.
      expect(mockRepo.delete).not.toHaveBeenCalled();
      expect(cancelledSub.isDeleted).toBe(true);
      expect(cancelledSub.deletedAt).toBeInstanceOf(Date);
      expect(mockQR.commitTransaction).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
      expect(result.status).toBe(SubscriptionStatus.ACTIVE);
    });
  });

  // ==========================================================================
  // PESSIMISTIC LOCK VERIFICATION
  // ==========================================================================

  describe('Pessimistic locking', () => {
    it('should acquire pessimistic_write lock when checking existing subscription', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await handler.execute(buildCommand());

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { isDeleted: false, tenantId: 'tenant-001' },
        lock: { mode: 'pessimistic_write' },
      });
    });
  });

  // ==========================================================================
  // PRICING VALIDATION (D09-F01)
  // ==========================================================================

  describe('Pricing validation (D09-F01)', () => {
    it('should reject negative base price', async () => {
      await expect(
        handler.execute(buildCommand({ pricing: { basePrice: -10 } as any })),
      ).rejects.toThrow(ConflictException);
      await expect(
        handler.execute(buildCommand({ pricing: { basePrice: -10 } as any })),
      ).rejects.toThrow('Base price cannot be negative');
    });

    it('should reject STARTER tier below $49', async () => {
      await expect(
        handler.execute(
          buildCommand({ planTier: PlanTier.STARTER, pricing: { basePrice: 30 } as any }),
        ),
      ).rejects.toThrow(ConflictException);
      await expect(
        handler.execute(
          buildCommand({ planTier: PlanTier.STARTER, pricing: { basePrice: 30 } as any }),
        ),
      ).rejects.toThrow('Minimum base price for STARTER tier is $49');
    });

    it('should accept STARTER tier at exactly $49', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await handler.execute(
        buildCommand({ planTier: PlanTier.STARTER, pricing: { basePrice: 49, currency: 'USD' } as any }),
      );

      expect(result).toBeDefined();
      expect(mockQR.commitTransaction).toHaveBeenCalled();
    });

    it('should reject PROFESSIONAL tier below $149', async () => {
      await expect(
        handler.execute(
          buildCommand({ planTier: PlanTier.PROFESSIONAL, pricing: { basePrice: 100 } as any }),
        ),
      ).rejects.toThrow('Minimum base price for PROFESSIONAL tier is $149');
    });

    it('should reject ENTERPRISE tier below $499', async () => {
      await expect(
        handler.execute(
          buildCommand({ planTier: PlanTier.ENTERPRISE, pricing: { basePrice: 400 } as any }),
        ),
      ).rejects.toThrow('Minimum base price for ENTERPRISE tier is $499');
    });

    it('should allow CUSTOM tier with any non-negative price (no minimum)', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await handler.execute(
        buildCommand({ planTier: PlanTier.CUSTOM, pricing: { basePrice: 1, currency: 'USD' } as any }),
      );

      expect(result).toBeDefined();
      expect(mockQR.commitTransaction).toHaveBeenCalled();
    });

    it('should perform pricing validation BEFORE acquiring a DB connection', async () => {
      // Negative price should fail without ever calling createQueryRunner
      await expect(
        handler.execute(buildCommand({ pricing: { basePrice: -5 } as any })),
      ).rejects.toThrow(ConflictException);

      expect(mockDS.createQueryRunner).not.toHaveBeenCalled();
    });

    it('should perform tier-minimum validation BEFORE acquiring a DB connection', async () => {
      await expect(
        handler.execute(
          buildCommand({ planTier: PlanTier.STARTER, pricing: { basePrice: 10 } as any }),
        ),
      ).rejects.toThrow(ConflictException);

      expect(mockDS.createQueryRunner).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // TRIAL PERIOD VALIDATION
  // ==========================================================================

  describe('Trial period validation', () => {
    it('should reject trial period exceeding 30 days', async () => {
      await expect(
        handler.execute(buildCommand({ trialDays: 31 })),
      ).rejects.toThrow(ConflictException);
      await expect(
        handler.execute(buildCommand({ trialDays: 31 })),
      ).rejects.toThrow('Trial period cannot exceed 30 days');
    });

    it('should accept trial period of exactly 30 days', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await handler.execute(buildCommand({ trialDays: 30 }));

      expect(result.status).toBe(SubscriptionStatus.TRIAL);
      expect(result.trialEndDate).toBeDefined();
    });

    it('should keep ACTIVE status when trialDays is 0', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await handler.execute(buildCommand({ trialDays: 0 }));

      expect(result.status).toBe(SubscriptionStatus.ACTIVE);
      expect(result.trialEndDate).toBeUndefined();
    });
  });

  // ==========================================================================
  // REDIS CACHE INVALIDATION
  // ==========================================================================

  describe('Redis cache invalidation', () => {
    it('should invalidate subscription cache after successful creation', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await handler.execute(buildCommand());

      expect(mockRedisService.del).toHaveBeenCalledWith('subscription:tenant-001');
    });

    it('should not fail if Redis cache invalidation fails', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRedisService.del.mockRejectedValue(new Error('Redis down'));

      // Should still succeed — redis failure is non-fatal
      const result = await handler.execute(buildCommand());
      expect(result).toBeDefined();
    });

    it('should work when RedisService is not injected', async () => {
      // No RedisService provider → @Optional() injects undefined.
      const moduleRef = await Test.createTestingModule({
        providers: [
          CreateSubscriptionHandler,
          { provide: DataSource, useValue: mockDS },
          { provide: OutboxPublisher, useValue: mockOutbox },
          SubscriptionWriterService,
          { provide: StripeApiService, useValue: mockStripe },
          { provide: getRepositoryToken(Plan), useValue: mockPlanRepo },
        ],
      }).compile();
      const handlerNoRedis = moduleRef.get(CreateSubscriptionHandler);
      mockRepo.findOne.mockResolvedValue(null);

      const result = await handlerNoRedis.execute(buildCommand());
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // NATS EVENT PUBLISHING
  // ==========================================================================

  describe('transactional outbox (BILLING-CRITICAL-001)', () => {
    it('enqueues SubscriptionCreated into the outbox inside the tx (before commit)', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await handler.execute(buildCommand());

      expect(mockOutbox.enqueue).toHaveBeenCalledTimes(1);
      const enqueuedEvent = mockOutbox.enqueue.mock.calls[0][0];
      expect(enqueuedEvent.subscriptionId).toBe('sub-uuid-001');
      expect(enqueuedEvent.tier).toBe(PlanTier.PROFESSIONAL);
      expect(enqueuedEvent.currency).toBe('USD');
      // enqueue happens BEFORE commit — atomic with the subscription write.
      const enqueueOrder = (mockOutbox.enqueue as jest.Mock).mock.invocationCallOrder[0] ?? 0;
      const commitOrder = (mockQR.commitTransaction as jest.Mock).mock.invocationCallOrder[0] ?? Infinity;
      expect(enqueueOrder).toBeLessThan(commitOrder);
    });

    it('rolls back the tx (no commit) when the outbox enqueue fails — atomic, not fire-and-forget', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockOutbox.enqueue.mockRejectedValue(new Error('outbox insert failed'));

      await expect(handler.execute(buildCommand())).rejects.toThrow();
      expect(mockQR.commitTransaction).not.toHaveBeenCalled();
      expect(mockQR.rollbackTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('Stripe-first real billing (SSOT-C-12)', () => {
    it('creates a Stripe subscription and persists the real ids when the plan has a Stripe price', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockPlanRepo.findOne.mockResolvedValue({
        tier: PlanTier.PROFESSIONAL,
        isActive: true,
        stripePriceIds: { monthly: 'price_pro_monthly' },
      });

      await handler.execute(buildCommand());

      expect(mockStripe.createSubscription).toHaveBeenCalledTimes(1);
      const stripeArgs = mockStripe.createSubscription.mock.calls[0][0];
      expect(stripeArgs.priceId).toBe('price_pro_monthly');
      expect(stripeArgs.idempotencyKey).toContain('sub-create:');
      // The persisted row carries the REAL Stripe ids, not the DTO value.
      const saved = (mockRepo.save as jest.Mock).mock.calls[0][0];
      expect(saved.stripeSubscriptionId).toBe('sub_test');
      expect(saved.stripeCustomerId).toBe('cus_test');
    });

    it('skips Stripe (local-only) when the plan has no Stripe price', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      // default mockPlanRepo.findOne → null (no price)

      await handler.execute(buildCommand());

      expect(mockStripe.createSubscription).not.toHaveBeenCalled();
      expect(mockStripe.createCustomer).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // TRANSACTION ERROR HANDLING
  // ==========================================================================

  describe('Transaction error handling', () => {
    it('should rollback and release on unexpected database error', async () => {
      mockRepo.findOne.mockRejectedValue(new Error('Connection lost'));

      await expect(handler.execute(buildCommand())).rejects.toThrow(InternalServerErrorException);

      expect(mockQR.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(mockQR.commitTransaction).not.toHaveBeenCalled();
      expect(mockQR.release).toHaveBeenCalledTimes(1);
    });

    it('should always release query runner even when rollback itself fails', async () => {
      mockRepo.findOne.mockRejectedValue(new Error('DB error'));
      (mockQR.rollbackTransaction as jest.Mock).mockRejectedValue(new Error('rollback fail'));

      await expect(handler.execute(buildCommand())).rejects.toThrow();

      // release is in the finally block — should still be called
      expect(mockQR.release).toHaveBeenCalledTimes(1);
    });

    it('should reject invalid start date', async () => {
      await expect(
        handler.execute(buildCommand({ startDate: 'not-a-date' })),
      ).rejects.toThrow(ConflictException);
      await expect(
        handler.execute(buildCommand({ startDate: 'not-a-date' })),
      ).rejects.toThrow('Invalid start date');
    });
  });

  // ==========================================================================
  // BILLING CYCLE PERIOD CALCULATION
  // ==========================================================================

  describe('Billing cycle period calculation', () => {
    it.each([
      { cycle: BillingCycle.MONTHLY, expectedMonths: 1 },
      { cycle: BillingCycle.QUARTERLY, expectedMonths: 3 },
      { cycle: BillingCycle.SEMI_ANNUAL, expectedMonths: 6 },
      { cycle: BillingCycle.ANNUAL, expectedMonths: 12 },
    ])('should calculate $expectedMonths month(s) for $cycle', async ({ cycle, expectedMonths }) => {
      mockRepo.findOne.mockResolvedValue(null);

      const startDate = '2026-01-01T00:00:00.000Z';
      const result = await handler.execute(buildCommand({ billingCycle: cycle, startDate }));

      const expectedEnd = new Date(startDate);
      expectedEnd.setMonth(expectedEnd.getMonth() + expectedMonths);

      expect(result.currentPeriodEnd.getFullYear()).toBe(expectedEnd.getFullYear());
      expect(result.currentPeriodEnd.getMonth()).toBe(expectedEnd.getMonth());
      expect(result.currentPeriodEnd.getDate()).toBe(expectedEnd.getDate());
    });

    it('should clamp day when target month has fewer days (Jan 31 + 1 month)', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const startDate = '2026-01-31T00:00:00.000Z';
      const result = await handler.execute(
        buildCommand({ billingCycle: BillingCycle.MONTHLY, startDate }),
      );

      // Feb 2026 has 28 days — should clamp to Feb 28, not overflow to March
      expect(result.currentPeriodEnd.getMonth()).toBe(1); // February
      expect(result.currentPeriodEnd.getDate()).toBe(28);
    });
  });
});
