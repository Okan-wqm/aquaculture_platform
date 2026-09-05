/**
 * BillingController Security Tests
 *
 * Enterprise-grade tests for billing system security controls.
 * Validates Sprint 4 security fixes:
 *   C6  - JWT-based identity override on all mutating endpoints
 *   H8  - Per-route throttle on sensitive billing operations
 *
 * Tests verify that createdBy/updatedBy/changedBy fields are ALWAYS
 * sourced from the verified JWT token (req.user.id), never from
 * client-supplied headers or DTO body fields.
 *
 * Uses NestJS TestingModule with mocked services.
 */

import { TENANT_ACTIVE_CHECK } from '@aquaculture/backend-common/middleware';
import { TenantStatus } from '@platform/event-contracts';
import {
  ConflictException,
  ExecutionContext,
  HttpStatus,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { BillingController } from '../billing.controller';
import { BillingAdminCommandClientService } from '../services/billing-admin-command-client.service';
import { CustomPlanService } from '../services/custom-plan.service';
import { DiscountCodeService } from '../services/discount-code.service';
import { InvoiceManagementService } from '../services/invoice-management.service';
import { ModulePricingService } from '../services/module-pricing.service';
import { PaymentManagementService } from '../services/payment-management.service';
import { PlanDefinitionService } from '../services/plan-definition.service';
import { PricingCalculatorService } from '../services/pricing-calculator.service';
import { SubscriptionManagementService } from '../services/subscription-management.service';
import { UsageMeteringManagementService } from '../services/usage-metering-management.service';

// ============================================================================
// Mock Definitions
// ============================================================================

const mockPlanService = {
  findAll: jest.fn().mockResolvedValue([]),
  findPublicPlans: jest.fn().mockResolvedValue([]),
  findById: jest.fn().mockResolvedValue({ id: 'plan-1' }),
  findByCode: jest.fn().mockResolvedValue({ id: 'plan-1' }),
  findByTier: jest.fn().mockResolvedValue({ id: 'plan-1' }),
  create: jest.fn().mockResolvedValue({ id: 'plan-new' }),
  update: jest.fn().mockResolvedValue({ id: 'plan-1' }),
  deprecate: jest.fn().mockResolvedValue({ id: 'plan-1' }),
  comparePlans: jest.fn().mockResolvedValue({ isUpgrade: true }),
  getDefaultLimitsForTier: jest.fn().mockResolvedValue({}),
  seedDefaultPlans: jest.fn().mockResolvedValue(undefined),
};

const mockDiscountService = {
  findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getStats: jest.fn().mockResolvedValue({}),
  findById: jest.fn().mockResolvedValue({ id: 'disc-1' }),
  findByCode: jest.fn().mockResolvedValue({ id: 'disc-1' }),
  create: jest.fn().mockResolvedValue({ id: 'disc-new' }),
  update: jest.fn().mockResolvedValue({ id: 'disc-1' }),
  deactivate: jest.fn().mockResolvedValue({ id: 'disc-1' }),
  validateCode: jest.fn().mockResolvedValue({ valid: true }),
  applyDiscount: jest.fn().mockResolvedValue({ success: true }),
  getRedemptions: jest.fn().mockResolvedValue([]),
  generateUniqueCode: jest.fn().mockResolvedValue('DISC-ABC'),
  bulkCreate: jest.fn().mockResolvedValue([{ code: 'BULK-1' }]),
  getTenantRedemptions: jest.fn().mockResolvedValue([]),
};

const mockSubscriptionService = {
  getSubscriptions: jest.fn().mockResolvedValue({ subscriptions: [], total: 0 }),
  getStats: jest.fn().mockResolvedValue({}),
  getSubscriptionsForReminders: jest.fn().mockResolvedValue([]),
  getSubscriptionByTenant: jest.fn().mockResolvedValue(null),
};

const mockModulePricingService = {
  getAllModulePricings: jest.fn().mockResolvedValue([]),
  getAllModulePricingsWithModuleInfo: jest.fn().mockResolvedValue([]),
  getModulePricing: jest.fn().mockResolvedValue({}),
  getModulePricingByCode: jest.fn().mockResolvedValue({}),
  getPricingHistory: jest.fn().mockResolvedValue([]),
  setModulePricing: jest.fn().mockResolvedValue({}),
  updateModulePricing: jest.fn().mockResolvedValue({}),
  deactivatePricing: jest.fn().mockResolvedValue(undefined),
  seedDefaultPricing: jest.fn().mockResolvedValue(5),
};

const mockPricingCalculator = {
  calculatePricing: jest.fn().mockResolvedValue({}),
  getQuickEstimate: jest.fn().mockResolvedValue({}),
  comparePricing: jest.fn().mockResolvedValue({}),
};

const mockCustomPlanService = {
  listCustomPlans: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getCustomPlan: jest.fn().mockResolvedValue({}),
  getCustomPlanByTenant: jest.fn().mockResolvedValue({}),
  createCustomPlan: jest.fn().mockResolvedValue({ id: 'cp-new' }),
  updateCustomPlan: jest.fn().mockResolvedValue({ id: 'cp-1' }),
  submitForApproval: jest.fn().mockResolvedValue({}),
  approvePlan: jest.fn().mockResolvedValue({}),
  rejectPlan: jest.fn().mockResolvedValue({}),
  activatePlan: jest.fn().mockResolvedValue({}),
  deletePlan: jest.fn().mockResolvedValue(undefined),
  clonePlan: jest.fn().mockResolvedValue({}),
};

const mockInvoiceService = {
  getInvoices: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getStats: jest.fn().mockResolvedValue({}),
  getOverdueInvoices: jest.fn().mockResolvedValue([]),
  getInvoiceById: jest.fn().mockResolvedValue({}),
  getTenantInvoices: jest.fn().mockResolvedValue([]),
};

const mockPaymentService = {
  getPayments: jest.fn().mockResolvedValue({ data: [], total: 0 }),
};

const mockBillingAdminCommands = {
  changeSubscriptionPlan: jest.fn().mockResolvedValue({ success: true }),
  cancelSubscription: jest.fn().mockResolvedValue({ cancelled: true }),
  reactivateSubscription: jest.fn().mockResolvedValue({ reactivated: true }),
  extendSubscriptionTrial: jest.fn().mockResolvedValue({ extended: true }),
  createInvoice: jest.fn().mockResolvedValue({ id: 'inv-new' }),
  markInvoicePaid: jest.fn().mockResolvedValue({ id: 'inv-1', status: 'paid' }),
  voidInvoice: jest.fn().mockResolvedValue({ id: 'inv-1', status: 'void' }),
  recordPayment: jest.fn().mockResolvedValue({ id: 'payment-new' }),
  refundPayment: jest.fn().mockResolvedValue({ id: 'refund-new' }),
};

const mockUsageMeteringService = {
  getUsageMetrics: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getUsageAggregations: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  recordUsage: jest.fn().mockResolvedValue({}),
};

// ============================================================================
// Test Suite
// ============================================================================

describe('BillingController', () => {
  let app: INestApplication;

  type TestApp = Parameters<typeof request>[0];

  const authenticatedUser = {
    id: 'jwt-admin-uuid-5678',
    email: 'billing-admin@platform.com',
    roles: ['SUPER_ADMIN'],
  };

  type AuthenticatedBillingRequest = {
    user?: typeof authenticatedUser;
  };

  type ThrottleConfigMetadata = {
    limit?: number;
    ttl?: number;
  };

  function allowAuthenticatedBillingRequest(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedBillingRequest>();
    req.user = { ...authenticatedUser };
    return true;
  }

  function httpServer(): TestApp {
    return app.getHttpServer() as TestApp;
  }

  function throttleConfigMetadata(target: object): ThrottleConfigMetadata | undefined {
    return Reflect.getMetadata('THROTTLE_CONFIG', target) as ThrottleConfigMetadata | undefined;
  }

  function firstChangePlanRequest(): Record<string, unknown> {
    const calls = mockBillingAdminCommands.changeSubscriptionPlan.mock.calls as Array<
      [Record<string, unknown>, string]
    >;
    const payload = calls[0]?.[0];
    if (!payload) {
      throw new Error('Expected changeSubscriptionPlan to be called with a request payload');
    }
    return payload;
  }

  const mockGuard = {
    canActivate: jest.fn(allowAuthenticatedBillingRequest),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        // ADMIN-CRITICAL-009: @TenantParam resolves ids through the kernel
        // port; these suites exercise the controllers, not the lookup.
        {
          provide: TENANT_ACTIVE_CHECK,
          useValue: { lookupTenant: () => Promise.resolve({ status: TenantStatus.ACTIVE }) },
        },
        { provide: PlanDefinitionService, useValue: mockPlanService },
        { provide: DiscountCodeService, useValue: mockDiscountService },
        { provide: SubscriptionManagementService, useValue: mockSubscriptionService },
        { provide: ModulePricingService, useValue: mockModulePricingService },
        { provide: PricingCalculatorService, useValue: mockPricingCalculator },
        { provide: CustomPlanService, useValue: mockCustomPlanService },
        { provide: InvoiceManagementService, useValue: mockInvoiceService },
        { provide: PaymentManagementService, useValue: mockPaymentService },
        { provide: BillingAdminCommandClientService, useValue: mockBillingAdminCommands },
        { provide: UsageMeteringManagementService, useValue: mockUsageMeteringService },
      ],
    })
      .overrideGuard(PlatformAdminGuard)
      .useValue(mockGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalGuards(mockGuard);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGuard.canActivate.mockImplementation(allowAuthenticatedBillingRequest);
  });

  // ==========================================================================
  // 1. Guard Application
  // ==========================================================================

  describe('PlatformAdminGuard enforcement', () => {
    it('should rely on the application-level PlatformAdminGuard', () => {
      const guards = Reflect.getMetadata('__guards__', BillingController) as unknown;
      expect(guards).toBeUndefined();
    });

    it('should invoke guard on every request', async () => {
      await request(httpServer()).get('/billing/plans');

      expect(mockGuard.canActivate).toHaveBeenCalled();
    });

    it('should reject when guard denies access', async () => {
      mockGuard.canActivate.mockReturnValueOnce(false);

      const res = await request(httpServer()).get('/billing/plans');

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  // ==========================================================================
  // 2. createPlan -- JWT identity override (C6 fix)
  // ==========================================================================

  describe('POST /billing/plans (createPlan)', () => {
    const validPlanDto = {
      code: 'starter',
      name: 'Starter Plan',
      tier: 'starter',
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
      pricing: {
        monthly: { basePrice: 29, perUserPrice: 5, perFarmPrice: 10, perModulePrice: 4 },
        quarterly: {
          basePrice: 82,
          perUserPrice: 5,
          perFarmPrice: 10,
          perModulePrice: 4,
          discountPercent: 5,
        },
        semiAnnual: {
          basePrice: 160,
          perUserPrice: 5,
          perFarmPrice: 10,
          perModulePrice: 4,
          discountPercent: 8,
        },
        annual: {
          basePrice: 300,
          perUserPrice: 5,
          perFarmPrice: 10,
          perModulePrice: 4,
          discountPercent: 14,
        },
        currency: 'USD',
      },
      features: {
        coreFeatures: ['dashboard'],
        advancedFeatures: [],
        premiumFeatures: [],
        addOns: [],
      },
    };

    it('refuses a body that claims an actor instead of quietly overriding it', async () => {
      const res = await request(httpServer())
        .post('/billing/plans')
        .send({ ...validPlanDto, createdBy: 'attacker-id' });

      // CONTRACT-CRITICAL-003: the DTO is a class now, so `forbidNonWhitelisted`
      // rejects an undeclared `createdBy` outright. The old interface let it
      // through to be overwritten, which only worked as long as every handler
      // remembered to overwrite it.
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockPlanService.create).not.toHaveBeenCalled();
    });

    it('refuses a body whose plan shape is wrong', async () => {
      const res = await request(httpServer())
        .post('/billing/plans')
        .send({ ...validPlanDto, tier: 'PLATINUM', limits: { maxUsers: 5 } });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockPlanService.create).not.toHaveBeenCalled();
    });

    it('uses the JWT user.id as createdBy', async () => {
      await request(httpServer()).post('/billing/plans').send(validPlanDto);

      expect(mockPlanService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: authenticatedUser.id,
        }),
      );
    });

    it('should ignore x-admin-id header for createdBy', async () => {
      await request(httpServer())
        .post('/billing/plans')
        .set('x-admin-id', 'header-injected-id')
        .send(validPlanDto);

      expect(mockPlanService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: authenticatedUser.id,
        }),
      );
    });
  });

  // ==========================================================================
  // 3. updatePlan -- JWT identity override (C6 fix)
  // ==========================================================================

  describe('PUT /billing/plans/:id (updatePlan)', () => {
    it('refuses a body that claims an actor', async () => {
      const res = await request(httpServer())
        .put('/billing/plans/plan-1')
        .send({ name: 'Updated Plan', updatedBy: 'attacker-id' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockPlanService.update).not.toHaveBeenCalled();
    });

    it('should use JWT user.id even when updatedBy is absent', async () => {
      await request(httpServer())
        .put('/billing/plans/plan-1')
        .send({ name: 'Updated Plan' });

      expect(mockPlanService.update).toHaveBeenCalledWith(
        'plan-1',
        expect.objectContaining({
          updatedBy: authenticatedUser.id,
        }),
      );
    });
  });

  // ==========================================================================
  // 4. cancelSubscription -- JWT identity (C6 fix) + DTO validation
  // ==========================================================================

  describe('POST /billing/subscriptions/tenant/:tenantId/cancel', () => {
    it('should use JWT user.id as cancelledBy', async () => {
      await request(httpServer())
        .post('/billing/subscriptions/tenant/11111111-1111-4111-8111-111111111111/cancel')
        .send({ reason: 'No longer needed' });

      expect(mockBillingAdminCommands.cancelSubscription).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        'No longer needed',
        undefined,
        authenticatedUser.id,
      );
    });

    it('should reject client-supplied cancelledBy in body', async () => {
      const res = await request(httpServer())
        .post('/billing/subscriptions/tenant/11111111-1111-4111-8111-111111111111/cancel')
        .send({
          reason: 'Closing account',
          cancelledBy: 'attacker-injected',
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockBillingAdminCommands.cancelSubscription).not.toHaveBeenCalled();
    });

    it('should pass cancelImmediately flag to service', async () => {
      await request(httpServer())
        .post('/billing/subscriptions/tenant/11111111-1111-4111-8111-111111111111/cancel')
        .send({ reason: 'Test', cancelImmediately: true });

      expect(mockBillingAdminCommands.cancelSubscription).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        'Test',
        true,
        authenticatedUser.id,
      );
    });
  });

  // ==========================================================================
  // 5. bulkCreateDiscountCodes -- createdBy JWT override (review fix)
  // ==========================================================================

  describe('POST /billing/discounts/bulk-create', () => {
    it('refuses a template that claims an actor, nested one level down', async () => {
      const res = await request(httpServer())
        .post('/billing/discounts/bulk-create')
        .send({
          count: 5,
          template: {
            name: 'Bulk Discount',
            discountType: 'percentage',
            discountValue: 10,
            createdBy: 'attacker-id',
          },
          codePrefix: 'BLK',
        });

      // @ValidateNested reaches the template, so the whitelist applies at every
      // level rather than only at the envelope (CONTRACT-CRITICAL-003).
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockDiscountService.bulkCreate).not.toHaveBeenCalled();
    });

    it('should set createdBy from JWT even when not in template', async () => {
      await request(httpServer())
        .post('/billing/discounts/bulk-create')
        .send({
          count: 3,
          template: {
            name: 'Test Discount',
            discountType: 'fixed_amount',
            discountValue: 5,
          },
        });

      expect(mockDiscountService.bulkCreate).toHaveBeenCalledWith(
        3,
        expect.objectContaining({
          createdBy: authenticatedUser.id,
        }),
        undefined,
      );
    });
  });

  // ==========================================================================
  // 7. createDiscountCode -- JWT identity (C6 fix)
  // ==========================================================================

  describe('POST /billing/discounts (createDiscountCode)', () => {
    it('refuses a body that claims an actor', async () => {
      const res = await request(httpServer())
        .post('/billing/discounts')
        .send({
          code: 'SPRING2026',
          name: 'Spring Sale',
          discountType: 'percentage',
          discountValue: 15,
          createdBy: 'attacker-id',
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockDiscountService.create).not.toHaveBeenCalled();
    });

    it('should use JWT user.id as createdBy', async () => {
      await request(httpServer())
        .post('/billing/discounts')
        .send({
          code: 'SPRING2026',
          name: 'Spring Sale',
          discountType: 'percentage',
          discountValue: 15,
        });

      expect(mockDiscountService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: authenticatedUser.id,
        }),
      );
    });
  });

  // ==========================================================================
  // 8. updateDiscountCode -- JWT identity (C6 fix)
  // ==========================================================================

  describe('PUT /billing/discounts/:id (updateDiscountCode)', () => {
    it('refuses a body that claims an actor', async () => {
      const res = await request(httpServer())
        .put('/billing/discounts/disc-1')
        .send({
          name: 'Updated Discount',
          updatedBy: 'attacker-id',
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockDiscountService.update).not.toHaveBeenCalled();
    });

    it('should use JWT user.id as updatedBy', async () => {
      await request(httpServer()).put('/billing/discounts/disc-1').send({
        name: 'Updated Discount',
      });

      expect(mockDiscountService.update).toHaveBeenCalledWith(
        'disc-1',
        expect.objectContaining({
          updatedBy: authenticatedUser.id,
        }),
      );
    });
  });

  // ==========================================================================
  // 9. deprecatePlan, seedPlans -- JWT identity
  // ==========================================================================

  describe('POST /billing/plans/:id/deprecate', () => {
    it('should use JWT user.id for deprecation', async () => {
      await request(httpServer())
        .post('/billing/plans/plan-old/deprecate');

      expect(mockPlanService.deprecate).toHaveBeenCalledWith(
        'plan-old',
        authenticatedUser.id,
      );
    });
  });

  describe('POST /billing/plans/seed', () => {
    it('should use JWT user.id for seed operation', async () => {
      await request(httpServer())
        .post('/billing/plans/seed');

      expect(mockPlanService.seedDefaultPlans).toHaveBeenCalledWith(
        authenticatedUser.id,
      );
    });
  });

  // ==========================================================================
  // 10. changePlan -- JWT identity (C6 fix)
  // ==========================================================================

  describe('POST /billing/subscriptions/change-plan', () => {
    const validChangePlanDto = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      currentPlanId: '22222222-2222-4222-8222-222222222222',
      newPlanId: '33333333-3333-4333-8333-333333333333',
    };

    it('refuses a body that claims an actor', async () => {
      const res = await request(httpServer())
        .post('/billing/subscriptions/change-plan')
        .send({ ...validChangePlanDto, changedBy: 'attacker-id' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockBillingAdminCommands.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('passes the verified tenant and the JWT user.id, and no actor from the body', async () => {
      await request(httpServer())
        .post('/billing/subscriptions/change-plan')
        .send(validChangePlanDto);

      expect(mockBillingAdminCommands.changeSubscriptionPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: validChangePlanDto.tenantId,
          newPlanId: validChangePlanDto.newPlanId,
        }),
        authenticatedUser.id,
      );
      expect(firstChangePlanRequest()).not.toHaveProperty('changedBy');
    });
  });

  // ==========================================================================
  // 11. Invoice operations -- JWT identity (C6 fix)
  // ==========================================================================

  describe('POST /billing/invoices/:invoiceId/mark-paid', () => {
    it('should use JWT user.id as paidBy', async () => {
      await request(httpServer())
        .post('/billing/invoices/inv-1/mark-paid')
        .send({ amount: 99.99 });

      expect(mockBillingAdminCommands.markInvoicePaid).toHaveBeenCalledWith(
        'inv-1',
        99.99,
        authenticatedUser.id,
      );
    });
  });

  describe('POST /billing/invoices/:invoiceId/void', () => {
    it('should use JWT user.id as voidedBy', async () => {
      await request(httpServer())
        .post('/billing/invoices/inv-1/void')
        .send({ reason: 'Duplicate invoice' });

      expect(mockBillingAdminCommands.voidInvoice).toHaveBeenCalledWith(
        'inv-1',
        'Duplicate invoice',
        authenticatedUser.id,
      );
    });
  });

  // ==========================================================================
  // 12. Custom Plans -- JWT identity (C6 fix)
  // ==========================================================================

  describe('Custom plan JWT identity overrides', () => {
    const validCustomPlanDto = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      name: 'Enterprise Custom',
      modules: [
        {
          moduleId: '44444444-4444-4444-8444-444444444444',
          moduleCode: 'farm',
          moduleName: 'Farm',
          quantities: { users: 10, farms: 2 },
        },
      ],
      validFrom: '2026-09-05T00:00:00.000Z',
    };

    it('POST /billing/custom-plans refuses a body that claims an actor', async () => {
      const res = await request(httpServer())
        .post('/billing/custom-plans')
        .send({ ...validCustomPlanDto, createdBy: 'attacker-id' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockCustomPlanService.createCustomPlan).not.toHaveBeenCalled();
    });

    it('POST /billing/custom-plans should use JWT createdBy', async () => {
      await request(httpServer()).post('/billing/custom-plans').send(validCustomPlanDto);

      expect(mockCustomPlanService.createCustomPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: validCustomPlanDto.tenantId,
          createdBy: authenticatedUser.id,
        }),
      );
    });

    it('PUT /billing/custom-plans/:planId should use JWT updatedBy', async () => {
      await request(httpServer())
        .put('/billing/custom-plans/cp-1')
        .send({ name: 'Updated Custom' });

      expect(mockCustomPlanService.updateCustomPlan).toHaveBeenCalledWith(
        'cp-1',
        expect.objectContaining({
          updatedBy: authenticatedUser.id,
        }),
      );
    });

    it('POST /billing/custom-plans/:planId/approve should use JWT approvedBy', async () => {
      await request(httpServer())
        .post('/billing/custom-plans/cp-1/approve');

      expect(mockCustomPlanService.approvePlan).toHaveBeenCalledWith(
        'cp-1',
        authenticatedUser.id,
      );
    });

    it('POST /billing/custom-plans/:planId/reject should use JWT rejectedBy', async () => {
      await request(httpServer())
        .post('/billing/custom-plans/cp-1/reject')
        .send({ reason: 'Pricing too low' });

      expect(mockCustomPlanService.rejectPlan).toHaveBeenCalledWith(
        'cp-1',
        'Pricing too low',
        authenticatedUser.id,
      );
    });
  });

  // ==========================================================================
  // 13. deactivateDiscountCode -- JWT identity
  // ==========================================================================

  describe('POST /billing/discounts/:id/deactivate', () => {
    it('should use JWT user.id for deactivation', async () => {
      await request(httpServer())
        .post('/billing/discounts/disc-1/deactivate');

      expect(mockDiscountService.deactivate).toHaveBeenCalledWith(
        'disc-1',
        authenticatedUser.id,
      );
    });
  });

  // ==========================================================================
  // 14. applyDiscount -- JWT identity
  // ==========================================================================

  describe('POST /billing/discounts/apply', () => {
    it('should use JWT user.id as redeemedBy', async () => {
      await request(httpServer())
        .post('/billing/discounts/apply')
        .send({
          code: 'SPRING2026',
          tenantId: 'd4e5f6a7-b8c9-4d0e-af1a-2b3c4d5e6f7a',
          originalAmount: 100,
        });

      expect(mockDiscountService.applyDiscount).toHaveBeenCalledWith(
        'SPRING2026',
        'd4e5f6a7-b8c9-4d0e-af1a-2b3c4d5e6f7a',
        100,
        expect.objectContaining({
          redeemedBy: authenticatedUser.id,
        }),
      );
    });
  });

  // ==========================================================================
  // 15. ThrottleSensitive decorator metadata
  // ==========================================================================

  describe('ThrottleSensitive decorator metadata', () => {
    it('should have THROTTLE_CONFIG on cancelSubscription', () => {
      const metadata = throttleConfigMetadata(BillingController.prototype.cancelSubscription);
      expect(metadata).toBeDefined();
      expect(metadata?.limit).toBe(3);
      expect(metadata?.ttl).toBe(300);
    });

    it('should have THROTTLE_CONFIG on markInvoiceAsPaid', () => {
      const metadata = throttleConfigMetadata(BillingController.prototype.markInvoiceAsPaid);
      expect(metadata).toBeDefined();
      expect(metadata?.limit).toBe(3);
    });

    it('should have THROTTLE_CONFIG on voidInvoice', () => {
      const metadata = throttleConfigMetadata(BillingController.prototype.voidInvoice);
      expect(metadata).toBeDefined();
      expect(metadata?.limit).toBe(3);
    });
  });

  // ==========================================================================
  // 16. Subscription auxiliary endpoints -- JWT identity
  // ==========================================================================

  describe('Subscription auxiliary JWT identity', () => {
    it('POST reactivateSubscription should use JWT user.id', async () => {
      await request(httpServer())
        .post('/billing/subscriptions/tenant/11111111-1111-4111-8111-111111111111/reactivate');

      expect(mockBillingAdminCommands.reactivateSubscription).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        authenticatedUser.id,
      );
    });

    it('POST extendTrial should use JWT user.id', async () => {
      await request(httpServer())
        .post('/billing/subscriptions/tenant/11111111-1111-4111-8111-111111111111/extend-trial')
        .send({ additionalDays: 14 });

      expect(mockBillingAdminCommands.extendSubscriptionTrial).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        14,
        authenticatedUser.id,
      );
    });
  });

  // ==========================================================================
  // 17. Error handling
  // ==========================================================================

  describe('Error handling', () => {
    it('should propagate NotFoundException from plan service', async () => {
      mockPlanService.findById.mockRejectedValueOnce(
        new NotFoundException('Plan not found'),
      );

      const res = await request(httpServer()).get('/billing/plans/non-existent');

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('should propagate ConflictException from discount service', async () => {
      mockDiscountService.create.mockRejectedValueOnce(
        new ConflictException('Discount code already exists'),
      );

      const res = await request(httpServer())
        .post('/billing/discounts')
        .send({ code: 'DUP', name: 'Dup', discountType: 'fixed_amount', discountValue: 5 });

      expect(res.status).toBe(HttpStatus.CONFLICT);
    });
  });
});
