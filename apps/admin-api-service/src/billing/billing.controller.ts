import { Destructive, RequiresCapability, TenantParam } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type BillingAdminCreateInvoiceInput,
  type BillingDiscountCodeInput,
  type BillingModulePriceInput,
  type BillingModulePriceTierMultiplierInput,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';
import { Request } from 'express';

import { InvoiceStatus } from '../analytics/entities/external/invoice.entity';
import { getAuthUserId } from '../shared/authenticated-request';
import { PaginationQueryDto } from '../shared/pagination-query.dto';

import {
  ApplyDiscountCodeDto,
  BulkCreateDiscountCodesDto,
  CancelSubscriptionDto,
  CloneCustomPlanDto,
  ComparePricingDto,
  ComparePlansDto,
  CreateCustomPlanDto,
  CreateDiscountCodeDto,
  CreateInvoiceDto,
  CreatePlanDto,
  ExtendTrialDto,
  GenerateDiscountCodeDto,
  MarkInvoicePaidDto,
  PlanChangeRequest,
  QuickEstimateDto,
  QuoteRequest,
  RecordPaymentDto,
  RefundPaymentDto,
  RejectCustomPlanDto,
  SeedModulePricingDto,
  SetModulePricingDto,
  TierMultipliersDto,
  UpdateCustomPlanDto,
  UpdateDiscountCodeDto,
  UpdateModulePricingDto,
  UpdatePlanDto,
  ValidateDiscountCodeDto,
  VoidInvoiceDto,
} from './dto/billing.dto';
import {
  ModulePricePageDto,
  ModulePriceResponseDto,
  ModuleQuoteComparisonDto,
  ModuleQuoteResponseDto,
  QuickEstimateResponseDto,
  SeedModulePricesResultDto,
} from './dto/module-price-response.dto';
import {
  BulkCreatedDiscountCodesDto,
  DiscountApplicationResponseDto,
  DiscountCodeLookupDto,
  DiscountCodePageDto,
  DiscountCodeResponseDto,
  DiscountRedemptionPageDto,
  DiscountStatsDto,
  DiscountValidationResponseDto,
  GeneratedDiscountCodeDto,
} from './dto/discount-response.dto';
import { CustomPlanStatus } from './entities/custom-plan.entity';
import { BillingCycle, PlanTier } from './entities/plan-definition.entity';
import { AggregationPeriod, MeterType } from './entities/usage-aggregation-readonly.entity';
import { BillingAdminCommandClientService } from './services/billing-admin-command-client.service';
import { CustomPlanFilter, CustomPlanService } from './services/custom-plan.service';
import { DiscountCodeService } from './services/discount-code.service';
import { ModulePricingService } from './services/module-pricing.service';
import {
  InvoiceFilters,
  InvoiceManagementService,
} from './services/invoice-management.service';
import { PaymentFilters, PaymentManagementService } from './services/payment-management.service';
import { PlanDefinitionService } from './services/plan-definition.service';
import {
  SubscriptionFilters,
  SubscriptionManagementService,
  SubscriptionStatus,
} from './services/subscription-management.service';
import { UsageMeteringManagementService } from './services/usage-metering-management.service';

/**
 * Billing Controller
 * REST API for subscription and billing management
 */
@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly planService: PlanDefinitionService,
    private readonly discountService: DiscountCodeService,
    private readonly subscriptionService: SubscriptionManagementService,
    private readonly modulePricingService: ModulePricingService,
    private readonly customPlanService: CustomPlanService,
    private readonly invoiceService: InvoiceManagementService,
    private readonly paymentService: PaymentManagementService,
    private readonly billingAdminCommands: BillingAdminCommandClientService,
    private readonly usageMeteringService: UsageMeteringManagementService,
  ) {}

  // ============================================================================
  // Plan Definitions
  // ============================================================================

  @Get('plans')
  async getPlans(@Query('includeInactive') includeInactive?: string): Promise<unknown> {
    return this.planService.findAll(includeInactive === 'true');
  }

  @Get('plans/public')
  async getPublicPlans(): Promise<unknown> {
    return this.planService.findPublicPlans();
  }

  @Get('plans/:id')
  async getPlanById(@Param('id') id: string): Promise<unknown> {
    return this.planService.findById(id);
  }

  @Get('plans/code/:code')
  async getPlanByCode(@Param('code') code: string): Promise<unknown> {
    return this.planService.findByCode(code);
  }

  @Get('plans/tier/:tier')
  async getPlanByTier(@Param('tier') tier: PlanTier): Promise<unknown> {
    return this.planService.findByTier(tier);
  }

  @AuditedOperation({ resource: 'Plan', action: 'CREATE' })
  @RequiresCapability('billing-ops')
  @Post('plans')
  async createPlan(@Body() dto: CreatePlanDto, @Req() req: Request): Promise<unknown> {
    // SECURITY: Require authenticated user for plan creation — anonymous writes to billing data are forbidden.
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a plan');
    return this.planService.create({ ...dto, createdBy: userId });
  }

  @AuditedOperation({ resource: 'Plan', action: 'UPDATE' })
  @RequiresCapability('billing-ops')
  @Put('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to update a plan');
    return this.planService.update(id, { ...dto, updatedBy: userId });
  }

  @AuditedOperation({ resource: 'Plan', action: 'DEPRECATE' })
  @RequiresCapability('billing-ops')
  @Post('plans/:id/deprecate')
  async deprecatePlan(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to deprecate a plan');
    return this.planService.deprecate(id, userId);
  }

  @AuditedOperation({ resource: 'Plans', action: 'COMPARE' })
  @RequiresCapability('billing-ops')
  @Post('plans/compare')
  async comparePlans(
    @Body() dto: ComparePlansDto,
  ): Promise<unknown> {
    return this.planService.comparePlans(dto.currentPlanId, dto.newPlanId);
  }

  @Get('plans/defaults/:tier')
  getDefaultLimits(@Param('tier') tier: PlanTier): unknown {
    return this.planService.getDefaultLimitsForTier(tier);
  }

  @AuditedOperation({ resource: 'Billing', action: 'SEED_PLANS' })
  @RequiresCapability('billing-ops')
  @Post('plans/seed')
  async seedPlans(@Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to seed plans');
    await this.planService.seedDefaultPlans(userId);
    return { success: true, message: 'Default plans seeded successfully' };
  }

  // ============================================================================
  // Discount Codes
  // ============================================================================

  @Get('discounts')
  async getDiscountCodes(
    @Query('isActive') isActive?: string,
    @Query('campaignId') campaignId?: string,
    @Query('includeExpired') includeExpired?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<DiscountCodePageDto> {
    return this.discountService.findAll({
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      campaignId,
      includeExpired: includeExpired === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('discounts/stats')
  async getDiscountStats(): Promise<DiscountStatsDto> {
    return this.discountService.getStats();
  }

  @Get('discounts/code/:code')
  async getDiscountByCode(
    @Param('code') code: string,
  ): Promise<DiscountCodeLookupDto> {
    const discount = await this.discountService.findByCode(code);
    if (!discount) {
      return { found: false };
    }
    return { found: true, discount };
  }

  @Get('discounts/:id')
  async getDiscountById(@Param('id', ParseUUIDPipe) id: string): Promise<DiscountCodeResponseDto> {
    return this.discountService.findById(id);
  }

  @Get('discounts/:id/redemptions')
  async getDiscountRedemptions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<DiscountRedemptionPageDto> {
    return this.discountService.getRedemptions(id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'CREATE' })
  @RequiresCapability('billing-ops')
  @Post('discounts')
  async createDiscountCode(
    @Body() dto: CreateDiscountCodeDto,
    @Req() req: Request,
  ): Promise<DiscountCodeResponseDto> {
    const userId = requireActor(req, 'create a discount code');
    const { code, ...template } = dto;
    return this.discountService.create(code, toDiscountInput(template), userId);
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'UPDATE' })
  @RequiresCapability('billing-ops')
  @Put('discounts/:id')
  async updateDiscountCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDiscountCodeDto,
    @Req() req: Request,
  ): Promise<DiscountCodeResponseDto> {
    const userId = requireActor(req, 'update a discount code');
    return this.discountService.update(
      id,
      {
        name: dto.name,
        description: dto.description,
        isActive: dto.isActive,
        validFrom: dto.validFrom,
        validUntil: dto.validUntil,
        maxRedemptions: dto.maxRedemptions,
        maxRedemptionsPerTenant: dto.maxRedemptionsPerTenant,
        metadata: dto.metadata,
      },
      userId,
    );
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'DEACTIVATE' })
  @RequiresCapability('billing-ops')
  @Post('discounts/:id/deactivate')
  async deactivateDiscountCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<DiscountCodeResponseDto> {
    const userId = requireActor(req, 'deactivate a discount code');
    return this.discountService.deactivate(id, userId);
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'VALIDATE' })
  @RequiresCapability('billing-ops')
  @Post('discounts/validate')
  async validateDiscountCode(
    @TenantParam('body', { allow: 'any' }) tenantId: string,
    @Body() dto: ValidateDiscountCodeDto,
    @Req() req: Request,
  ): Promise<DiscountValidationResponseDto> {
    const userId = requireActor(req, 'validate a discount code');
    return this.discountService.validateCode(dto.code, tenantId, userId, {
      planId: dto.planId,
      subscriptionChange: dto.subscriptionChange,
      orderAmount: dto.orderAmount,
    });
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'APPLY' })
  @RequiresCapability('billing-ops')
  @Post('discounts/apply')
  async applyDiscountCode(
    @TenantParam('body', { allow: 'any' }) tenantId: string,
    @Body() dto: ApplyDiscountCodeDto,
    @Req() req: Request,
  ): Promise<DiscountApplicationResponseDto> {
    const userId = requireActor(req, 'apply a discount code');
    return this.discountService.applyDiscount(dto.code, tenantId, dto.orderAmount, userId, {
      subscriptionId: dto.subscriptionId,
      invoiceId: dto.invoiceId,
      planId: dto.planId,
      subscriptionChange: dto.subscriptionChange,
    });
  }

  @AuditedOperation({ resource: 'UniqueCode', action: 'GENERATE' })
  @RequiresCapability('billing-ops')
  @Post('discounts/generate-code')
  async generateUniqueCode(
    @Body() dto: GenerateDiscountCodeDto,
    @Req() req: Request,
  ): Promise<GeneratedDiscountCodeDto> {
    const userId = requireActor(req, 'generate a discount code');
    const code = await this.discountService.generateUniqueCode(userId, dto.prefix, dto.length);
    return { code };
  }

  @AuditedOperation({ resource: 'CreateDiscountCodes', action: 'BULK' })
  @RequiresCapability('billing-ops')
  @Post('discounts/bulk-create')
  async bulkCreateDiscountCodes(
    @Body() dto: BulkCreateDiscountCodesDto,
    @Req() req: Request,
  ): Promise<BulkCreatedDiscountCodesDto> {
    const userId = requireActor(req, 'bulk-create discount codes');
    const codes = await this.discountService.bulkCreate(
      dto.count,
      toDiscountInput(dto.template),
      userId,
      dto.codePrefix,
    );
    return { success: true, count: codes.length, codes };
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  @Get('subscriptions')
  async getSubscriptions(
    @Query('status') status?: string,
    @Query('planTier') planTier?: string,
    @Query('billingCycle') billingCycle?: string,
    @Query('autoRenew') autoRenew?: string,
    @Query('search') search?: string,
    @Query('expiringWithinDays') expiringWithinDays?: string,
    @Query('pastDueOnly') pastDueOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    const filters: SubscriptionFilters = {
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      expiringWithinDays: expiringWithinDays
        ? parseInt(expiringWithinDays, 10)
        : undefined,
      pastDueOnly: pastDueOnly === 'true',
    };

    if (status) {
      filters.status = status.split(',') as SubscriptionStatus[];
    }
    if (planTier) {
      filters.planTier = planTier.split(',') as PlanTier[];
    }
    if (billingCycle) {
      filters.billingCycle = billingCycle.split(',') as BillingCycle[];
    }
    if (autoRenew !== undefined) {
      filters.autoRenew = autoRenew === 'true';
    }

    return this.subscriptionService.getSubscriptions(filters);
  }

  @Get('subscriptions/stats')
  async getSubscriptionStats(): Promise<unknown> {
    return this.subscriptionService.getStats();
  }

  @Get('subscriptions/reminders')
  async getSubscriptionsForReminders(): Promise<unknown> {
    return this.subscriptionService.getSubscriptionsForReminders();
  }

  @Get('subscriptions/tenant/:tenantId')
  async getSubscriptionByTenant(@TenantParam('param', { allow: 'any' }) tenantId: string): Promise<unknown> {
    return this.subscriptionService.getSubscriptionByTenant(tenantId);
  }

  @AuditedOperation({ resource: 'Plan', action: 'CHANGE' })
  @RequiresCapability('billing-ops')
  @Post('subscriptions/change-plan')
  async changePlan(
    @TenantParam('body', { allow: 'any' }) tenantId: string,
    @Body() request: PlanChangeRequest,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to change a subscription plan');
    return this.billingAdminCommands.changeSubscriptionPlan(
      { ...request, tenantId },
      userId,
    );
  }

  // Fix: H8 -- per-route throttle: subscription cancel is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Subscription', action: 'CANCEL' })
  @RequiresCapability('billing-ops')
  @Post('subscriptions/tenant/:tenantId/cancel')
  async cancelSubscription(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Body() dto: CancelSubscriptionDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to cancel a subscription');
    return this.billingAdminCommands.cancelSubscription(tenantId, dto.reason, dto.cancelImmediately, userId);
  }

  @AuditedOperation({ resource: 'Billing', action: 'REACTIVATE_SUBSCRIPTION' })
  @RequiresCapability('billing-ops')
  @Post('subscriptions/tenant/:tenantId/reactivate')
  async reactivateSubscription(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to reactivate a subscription');
    return this.billingAdminCommands.reactivateSubscription(tenantId, userId);
  }

  @AuditedOperation({ resource: 'Trial', action: 'EXTEND' })
  @RequiresCapability('billing-ops')
  @Post('subscriptions/tenant/:tenantId/extend-trial')
  async extendTrial(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Body() dto: ExtendTrialDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to extend a trial');
    return this.billingAdminCommands.extendSubscriptionTrial(tenantId, dto.additionalDays, userId);
  }

  // ============================================================================
  // Tenant Redemptions
  // ============================================================================

  @Get('tenant/:tenantId/redemptions')
  async getTenantRedemptions(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<DiscountRedemptionPageDto> {
    return this.discountService.getTenantRedemptions(tenantId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  // ============================================================================
  // Module Pricing
  // ============================================================================

  @Get('module-pricing')
  async getAllModulePricing(): Promise<ModulePriceResponseDto[]> {
    return this.modulePricingService.getAllModulePricings();
  }

  @Get('module-pricing/with-modules')
  async getAllModulePricingWithModules(): Promise<ModulePriceResponseDto[]> {
    return this.modulePricingService.getAllModulePricingsWithModuleInfo();
  }

  @Get('module-pricing/code/:moduleCode')
  async getModulePricingByCode(
    @Param('moduleCode') moduleCode: string,
  ): Promise<ModulePriceResponseDto | null> {
    return this.modulePricingService.getModulePricingByCode(moduleCode);
  }

  @Get('module-pricing/:moduleId/history')
  async getModulePricingHistory(
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<ModulePricePageDto> {
    return this.modulePricingService.getPricingHistory(moduleId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @Get('module-pricing/:moduleId')
  async getModulePricing(
    @Param('moduleId', ParseUUIDPipe) moduleId: string,
  ): Promise<ModulePriceResponseDto | null> {
    return this.modulePricingService.getModulePricing(moduleId);
  }

  @AuditedOperation({ resource: 'ModulePricing', action: 'SET' })
  @RequiresCapability('billing-ops')
  @Post('module-pricing')
  async setModulePricing(
    @Body() dto: SetModulePricingDto,
    @Req() req: Request,
  ): Promise<ModulePriceResponseDto> {
    const userId = requireActor(req, 'publish a module price sheet');
    return this.modulePricingService.setModulePricing(toModulePriceInput(dto), userId);
  }

  @AuditedOperation({ resource: 'ModulePricing', action: 'UPDATE' })
  @RequiresCapability('billing-ops')
  @Put('module-pricing/:pricingId')
  async updateModulePricing(
    @Param('pricingId', ParseUUIDPipe) pricingId: string,
    @Body() dto: UpdateModulePricingDto,
    @Req() req: Request,
  ): Promise<ModulePriceResponseDto> {
    const userId = requireActor(req, 'republish a module price sheet');
    return this.modulePricingService.updateModulePricing(pricingId, dto, userId);
  }

  @AuditedOperation({ resource: 'ModulePricing', action: 'DEACTIVATE' })
  @RequiresCapability('billing-ops')
  @Post('module-pricing/:pricingId/deactivate')
  async deactivateModulePricing(
    @Param('pricingId', ParseUUIDPipe) pricingId: string,
    @Req() req: Request,
  ): Promise<ModulePriceResponseDto> {
    const userId = requireActor(req, 'deactivate a module price sheet');
    return this.modulePricingService.deactivatePricing(pricingId, userId);
  }

  @AuditedOperation({ resource: 'Billing', action: 'SEED_MODULE_PRICING' })
  @RequiresCapability('billing-ops')
  @Post('module-pricing/seed')
  async seedModulePricing(
    @Body() dto: SeedModulePricingDto,
    @Req() req: Request,
  ): Promise<SeedModulePricesResultDto> {
    const userId = requireActor(req, 'seed module prices');
    const seeded = await this.modulePricingService.seedDefaultPricing(dto.moduleCodes, userId);
    return { success: true, seeded };
  }

  // ============================================================================
  // Quotes
  //
  // ADR-0013: billing owns the price sheet AND the arithmetic over it. These
  // routes forward to `request.billing.admin.quoteModuleSelection`; admin-api
  // multiplies nothing.
  // ============================================================================

  @AuditedOperation({ resource: 'Pricing', action: 'CALCULATE' })
  @RequiresCapability('billing-ops')
  @Post('pricing/calculate')
  async calculatePricing(
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() request: QuoteRequest,
    @Req() req: Request,
  ): Promise<ModuleQuoteResponseDto> {
    const userId = requireActor(req, 'calculate a quote');
    return this.modulePricingService.quote(toQuoteRequest(request, tenantId), userId);
  }

  @AuditedOperation({ resource: 'Billing', action: 'GET_QUICK_ESTIMATE' })
  @RequiresCapability('billing-ops')
  @Post('pricing/quick-estimate')
  async getQuickEstimate(
    @Body() dto: QuickEstimateDto,
    @Req() req: Request,
  ): Promise<QuickEstimateResponseDto> {
    const userId = requireActor(req, 'estimate a quote');
    const quote = await this.modulePricingService.quote(
      {
        modules: dto.moduleCodes.map((moduleCode) => ({
          moduleId: EMPTY_MODULE_ID,
          moduleCode,
          quantities: dto.quantities ?? { users: 5 },
        })),
        tier: dto.tier,
        billingCycle: BillingCycle.MONTHLY,
      },
      userId,
    );
    return {
      monthlyTotal: quote.monthlyTotal,
      annualTotal: quote.annualTotal,
      currency: quote.currency,
      unpricedModuleCodes: quote.unpricedModuleCodes,
    };
  }

  @AuditedOperation({ resource: 'Pricing', action: 'COMPARE' })
  @RequiresCapability('billing-ops')
  @Post('pricing/compare')
  async comparePricing(
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() dto: ComparePricingDto,
    @Req() req: Request,
  ): Promise<ModuleQuoteComparisonDto> {
    const userId = requireActor(req, 'compare quotes');
    const [config1, config2] = await Promise.all([
      this.modulePricingService.quote(toQuoteRequest(dto.config1, tenantId), userId),
      this.modulePricingService.quote(toQuoteRequest(dto.config2, tenantId), userId),
    ]);
    return compareQuotes(config1, config2);
  }

  // ============================================================================
  // Custom Plans
  // ============================================================================

  @Get('custom-plans')
  async listCustomPlans(
    @TenantParam('query', { optional: true, allow: 'any' }) tenantId?: string,
    @Query('status') status?: CustomPlanStatus,
    @Query('tier') tier?: PlanTier,
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<unknown> {
    const filter: CustomPlanFilter = {
      tenantId,
      status,
      tier,
      search,
      page: pagination?.page,
      limit: pagination?.limit,
    };
    return this.customPlanService.listCustomPlans(filter);
  }

  @Get('custom-plans/:planId')
  async getCustomPlan(@Param('planId') planId: string): Promise<unknown> {
    return this.customPlanService.getCustomPlan(planId);
  }

  @Get('custom-plans/tenant/:tenantId')
  async getCustomPlanByTenant(@TenantParam('param', { allow: 'any' }) tenantId: string): Promise<unknown> {
    return this.customPlanService.getCustomPlanByTenant(tenantId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'CREATE' })
  @RequiresCapability('billing-ops')
  @Post('custom-plans')
  async createCustomPlan(
    @TenantParam('body', { allow: 'any' }) tenantId: string,
    @Body() dto: CreateCustomPlanDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a custom plan');
    return this.customPlanService.createCustomPlan({ ...dto, tenantId, createdBy: userId });
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'UPDATE' })
  @RequiresCapability('billing-ops')
  @Put('custom-plans/:planId')
  async updateCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: UpdateCustomPlanDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to update a custom plan');
    return this.customPlanService.updateCustomPlan(planId, { ...dto, updatedBy: userId });
  }

  @AuditedOperation({ resource: 'CustomPlanForApproval', action: 'SUBMIT' })
  @RequiresCapability('billing-ops')
  @Post('custom-plans/:planId/submit')
  async submitCustomPlanForApproval(@Param('planId') planId: string): Promise<unknown> {
    return this.customPlanService.submitForApproval(planId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'APPROVE' })
  @RequiresCapability('billing-ops')
  @Post('custom-plans/:planId/approve')
  async approveCustomPlan(
    @Param('planId') planId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to approve a custom plan');
    return this.customPlanService.approvePlan(planId, userId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'REJECT' })
  @RequiresCapability('billing-ops')
  @Post('custom-plans/:planId/reject')
  async rejectCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: RejectCustomPlanDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to reject a custom plan');
    return this.customPlanService.rejectPlan(planId, dto.reason, userId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'ACTIVATE' })
  @RequiresCapability('billing-ops')
  @Post('custom-plans/:planId/activate')
  async activateCustomPlan(
    @Param('planId') planId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to activate a custom plan');
    return this.customPlanService.activatePlan(planId, userId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('billing-ops')
  @Delete('custom-plans/:planId')
  async deleteCustomPlan(@Param('planId') planId: string): Promise<unknown> {
    await this.customPlanService.deletePlan(planId);
    return { success: true };
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'CLONE' })
  @RequiresCapability('billing-ops')
  @Post('custom-plans/:planId/clone')
  async cloneCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: CloneCustomPlanDto,
  ): Promise<unknown> {
    return this.customPlanService.clonePlan(planId, dto.newTenantId);
  }

  // ============================================================================
  // Invoices
  // ============================================================================

  @Get('invoices')
  async getInvoices(
    @Query('status') status?: string,
    @TenantParam('query', { optional: true, allow: 'any' }) tenantId?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('minAmount') minAmount?: string,
    @Query('maxAmount') maxAmount?: string,
    @Query('overdueOnly') overdueOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    const filters: InvoiceFilters = {
      tenantId,
      search,
      overdueOnly: overdueOnly === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      minAmount: minAmount ? parseFloat(minAmount) : undefined,
      maxAmount: maxAmount ? parseFloat(maxAmount) : undefined,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
    };

    if (status) {
      filters.status = status.split(',') as InvoiceStatus[];
    }

    return this.invoiceService.getInvoices(filters);
  }

  @Get('invoices/stats')
  async getInvoiceStats(): Promise<unknown> {
    return this.invoiceService.getStats();
  }

  @Get('invoices/overdue')
  async getOverdueInvoices(): Promise<unknown> {
    return this.invoiceService.getOverdueInvoices();
  }

  @Get('invoices/:invoiceId')
  async getInvoiceById(@Param('invoiceId') invoiceId: string): Promise<unknown> {
    return this.invoiceService.getInvoiceById(invoiceId);
  }

  @Get('invoices/tenant/:tenantId')
  async getTenantInvoices(@TenantParam('param', { allow: 'any' }) tenantId: string): Promise<unknown> {
    return this.invoiceService.getTenantInvoices(tenantId);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Invoice', action: 'CREATE' })
  @RequiresCapability('billing-ops')
  @Post('invoices')
  async createInvoice(
    @TenantParam('body', { allow: 'any' }) tenantId: string,
    @Body() dto: CreateInvoiceDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create an invoice');

    const input: BillingAdminCreateInvoiceInput = {
      subscriptionId: dto.subscriptionId,
      billingAddress: dto.billingAddress,
      lineItems: dto.lineItems,
      tax: dto.tax,
      discount: dto.discount,
      discountCode: dto.discountCode,
      currency: dto.currency,
      dueDate: dto.dueDate,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
      notes: dto.notes,
    };

    return this.billingAdminCommands.createInvoice(tenantId, input, userId);
  }

  // Fix: H8 -- per-route throttle: mark invoice paid is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @AuditedOperation({ resource: 'InvoiceAsPaid', action: 'MARK' })
  @RequiresCapability('billing-ops')
  @Post('invoices/:invoiceId/mark-paid')
  async markInvoiceAsPaid(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: MarkInvoicePaidDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to mark an invoice as paid');
    const invoice = await this.billingAdminCommands.markInvoicePaid(invoiceId, dto.amount, userId);
    return { success: true, invoice };
  }

  // Fix: H8 -- per-route throttle: invoice void is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Billing', action: 'VOID_INVOICE' })
  @RequiresCapability('billing-ops')
  @Post('invoices/:invoiceId/void')
  async voidInvoice(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: VoidInvoiceDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to void an invoice');
    const invoice = await this.billingAdminCommands.voidInvoice(invoiceId, dto.reason, userId);
    return { success: true, invoice };
  }

  // ============================================================================
  // Payments
  // ============================================================================

  @Get('payments')
  async getPayments(
    @Query('status') status?: string,
    @Query('invoiceId') invoiceId?: string,
    @TenantParam('query', { optional: true, allow: 'any' }) tenantId?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    const filters: PaymentFilters = {
      invoiceId,
      tenantId,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
    };

    if (status) {
      filters.status = status.split(',');
    }

    return this.paymentService.getPayments(filters);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Payment', action: 'RECORD' })
  @RequiresCapability('billing-ops')
  @Post('payments')
  async recordPayment(@Body() dto: RecordPaymentDto, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to record a payment');
    return this.billingAdminCommands.recordPayment(dto, userId);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Billing', action: 'REFUND_PAYMENT' })
  @RequiresCapability('billing-ops')
  @Post('payments/refund')
  async refundPayment(@Body() dto: RefundPaymentDto, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to refund a payment');
    return this.billingAdminCommands.refundPayment(dto, userId);
  }

  // ============================================================================
  // Usage Metering
  // ============================================================================

  @Get('usage/summary')
  async getUsageSummary(
    @Query('period') period?: AggregationPeriod,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<unknown> {
    return this.usageMeteringService.getUsageSummary(
      period || AggregationPeriod.MONTHLY,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  }

  @Get('usage/tenants')
  async getAllTenantsUsage(
    @Query('period') period?: AggregationPeriod,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    return this.usageMeteringService.getAllTenantsUsage(
      period || AggregationPeriod.MONTHLY,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      offset ? parseInt(offset, 10) : undefined,
    );
  }

  @Get('usage/tenant/:tenantId')
  async getTenantUsageOverview(
    @TenantParam('param', { allow: 'any' }) tenantId: string,
    @Query('period') period?: AggregationPeriod,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<unknown> {
    return this.usageMeteringService.getTenantUsageOverview(
      tenantId,
      period || AggregationPeriod.MONTHLY,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  }

  @Get('usage/trends')
  async getUsageTrends(
    @Query('period') period?: AggregationPeriod,
    @Query('meterType') meterType?: MeterType,
    @TenantParam('query', { optional: true, allow: 'any' }) tenantId?: string,
    @Query('numPeriods') numPeriods?: string,
  ): Promise<unknown> {
    return this.usageMeteringService.getUsageTrends(
      period || AggregationPeriod.DAILY,
      meterType || undefined,
      tenantId || undefined,
      numPeriods ? parseInt(numPeriods, 10) : 30,
    );
  }

  @Get('usage/top-tenants')
  async getTopTenantsByUsage(
    @Query('meterType') meterType: MeterType,
    @Query('period') period?: AggregationPeriod,
    @Query('limit') limit?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<unknown> {
    return this.usageMeteringService.getTopTenantsByUsage(
      meterType || MeterType.API_CALLS,
      period || AggregationPeriod.MONTHLY,
      limit ? parseInt(limit, 10) : 10,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  }
}

/**
 * The actor is the authenticated platform admin, never a value the body
 * claimed (ADMIN-CRITICAL-008). Every discount write names one, because
 * billing records it as `created_by` / `redeemed_by`.
 */
function requireActor(req: Request, action: string): string {
  const userId = getAuthUserId(req);
  if (!userId) throw new UnauthorizedException(`Authentication required to ${action}`);
  return userId;
}

/**
 * The DTO carries the value branch as four optional fields (class-validator
 * cannot type a discriminated union); the contract carries it as a union. This
 * is the one place the two meet, and it is exhaustive over `discountType`, so
 * a new kind is a compile error rather than a code with no value.
 */
function toDiscountInput(
  template: Omit<CreateDiscountCodeDto, 'code'>,
): BillingDiscountCodeInput {
  const attributes = {
    name: template.name,
    description: template.description,
    currency: template.currency,
    appliesTo: template.appliesTo,
    applicablePlanIds: template.applicablePlanIds,
    duration: template.duration,
    durationInMonths: template.durationInMonths,
    validFrom: template.validFrom,
    validUntil: template.validUntil,
    maxRedemptions: template.maxRedemptions,
    maxRedemptionsPerTenant: template.maxRedemptionsPerTenant,
    minimumOrderAmount: template.minimumOrderAmount,
    campaignId: template.campaignId,
    campaignName: template.campaignName,
    isReferralCode: template.isReferralCode,
    referrerId: template.referrerId,
    metadata: template.metadata,
  };

  switch (template.discountType) {
    case 'percentage':
      return { ...attributes, discountType: 'percentage', percentOff: template.percentOff ?? '' };
    case 'fixed_amount':
      return { ...attributes, discountType: 'fixed_amount', amountOff: template.amountOff ?? '' };
    case 'free_months':
      return { ...attributes, discountType: 'free_months', freeMonths: template.freeMonths ?? 0 };
    case 'free_trial_extension':
      return {
        ...attributes,
        discountType: 'free_trial_extension',
        trialExtensionDays: template.trialExtensionDays ?? 0,
      };
  }
}

/** A quick estimate names modules by code only; billing matches on the code. */
const EMPTY_MODULE_ID = '00000000-0000-4000-8000-000000000000';

/** The DTO's flat sheet becomes the contract's metric and multiplier rows. */
function toModulePriceInput(
  dto: SetModulePricingDto,
): BillingModulePriceInput {
  return {
    moduleId: dto.moduleId,
    moduleCode: dto.moduleCode,
    currency: dto.currency,
    effectiveFrom: dto.effectiveFrom,
    effectiveTo: dto.effectiveTo,
    notes: dto.notes,
    metrics: dto.pricingMetrics.map((metric) => ({
      metricType: metric.metricType,
      price: metric.price,
      description: metric.description,
      minQuantity: metric.minQuantity,
      maxQuantity: metric.maxQuantity,
      includedQuantity: metric.includedQuantity,
    })),
    tierMultipliers: toTierMultiplierRows(dto.tierMultipliers),
  };
}

/** `{ starter: '1', enterprise: '0.7' }` becomes one row per named tier. */
export function toTierMultiplierRows(
  multipliers: TierMultipliersDto | undefined,
): BillingModulePriceTierMultiplierInput[] | undefined {
  if (!multipliers) return undefined;
  const rows: BillingModulePriceTierMultiplierInput[] = [];
  for (const tier of Object.values(PlanTier)) {
    const multiplier = multipliers[tier as keyof TierMultipliersDto];
    if (multiplier !== undefined) rows.push({ tier, multiplier });
  }
  return rows;
}

function toQuoteRequest(
  request: QuoteRequest,
  tenantId: string | undefined,
): Parameters<ModulePricingService['quote']>[0] {
  return {
    modules: request.modules.map((module) => ({
      moduleId: module.moduleId,
      moduleCode: module.moduleCode,
      moduleName: module.moduleName,
      quantities: module.quantities,
    })),
    tier: request.tier,
    billingCycle: request.billingCycle,
    tenantId,
    discountCode: request.discountCode,
    taxRate: request.taxRate,
  };
}

/**
 * Two quotes, compared exactly. The old comparison subtracted two floats and
 * divided — the difference between $1,199.99 and $1,200.00 could come out as
 * 0.010000000000047748 and be rendered as such.
 */
function compareQuotes(
  config1: ModuleQuoteResponseDto,
  config2: ModuleQuoteResponseDto,
): ModuleQuoteComparisonDto {
  const first = new Decimal(config1.monthlyTotal);
  const second = new Decimal(config2.monthlyTotal);
  const difference = second.minus(first);
  const percentDifference = first.isZero()
    ? new Decimal(0)
    : difference.dividedBy(first).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  let recommendation = 'Both options are comparable.';
  if (difference.isPositive() && !difference.isZero()) {
    recommendation = `Configuration 2 costs ${difference.toString()} ${config2.currency} more per month (${percentDifference.toString()}% increase).`;
  } else if (difference.isNegative()) {
    recommendation = `Configuration 2 saves ${difference.abs().toString()} ${config2.currency} per month (${percentDifference.abs().toString()}% saving).`;
  }

  return {
    config1,
    config2,
    monthlyDifference: difference.toString(),
    percentDifference: percentDifference.toString(),
    recommendation,
  };
}
