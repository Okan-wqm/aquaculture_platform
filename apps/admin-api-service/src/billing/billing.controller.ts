import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type BillingAdminCreateInvoiceInput } from '@platform/event-contracts';
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
  ExtendTrialDto,
  GenerateDiscountCodeDto,
  MarkInvoicePaidDto,
  QuickEstimateDto,
  RejectCustomPlanDto,
  SeedModulePricingDto,
  UpdateModulePricingDto,
  ValidateDiscountCodeDto,
  VoidInvoiceDto,
} from './dto/billing.dto';
import { CustomPlanStatus } from './entities/custom-plan.entity';
import { BillingCycle, PlanTier } from './entities/plan-definition.entity';
import { AggregationPeriod, MeterType } from './entities/usage-aggregation-readonly.entity';
import { BillingAdminCommandClientService } from './services/billing-admin-command-client.service';
import {
  CreateCustomPlanDto,
  CustomPlanFilter,
  CustomPlanService,
  UpdateCustomPlanDto,
} from './services/custom-plan.service';
import {
  CreateDiscountCodeDto,
  DiscountCodeService,
  UpdateDiscountCodeDto,
} from './services/discount-code.service';
import {
  InvoiceFilters,
  InvoiceManagementService,
} from './services/invoice-management.service';
import {
  ModulePricingService,
  SetModulePricingDto,
} from './services/module-pricing.service';
import {
  PaymentFilters,
  PaymentManagementService,
  RecordPaymentDto,
  RefundPaymentDto,
} from './services/payment-management.service';
import {
  CreatePlanDto,
  PlanDefinitionService,
  UpdatePlanDto,
} from './services/plan-definition.service';
import {
  PricingCalculatorService,
  QuoteRequest,
} from './services/pricing-calculator.service';
import {
  PlanChangeRequest,
  SubscriptionFilters,
  SubscriptionManagementService,
  SubscriptionStatus,
} from './services/subscription-management.service';
import { UsageMeteringManagementService } from './services/usage-metering-management.service';

interface CreateInvoiceRequest extends BillingAdminCreateInvoiceInput {
  tenantId: string;
}

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
    private readonly pricingCalculator: PricingCalculatorService,
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
  @Post('plans')
  async createPlan(@Body() dto: CreatePlanDto, @Req() req: Request): Promise<unknown> {
    // SECURITY: Require authenticated user for plan creation — anonymous writes to billing data are forbidden.
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a plan');
    return this.planService.create({ ...dto, createdBy: userId });
  }

  @AuditedOperation({ resource: 'Plan', action: 'UPDATE' })
  @Put('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to update a plan');
    return this.planService.update(id, { ...dto, updatedBy: userId });
  }

  @AuditedOperation({ resource: 'Plan', action: 'DEPRECATE' })
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
  ): Promise<unknown> {
    return this.discountService.findAll({
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      campaignId,
      includeExpired: includeExpired === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('discounts/stats')
  async getDiscountStats(): Promise<unknown> {
    return this.discountService.getStats();
  }

  @Get('discounts/:id')
  async getDiscountById(@Param('id') id: string): Promise<unknown> {
    return this.discountService.findById(id);
  }

  @Get('discounts/code/:code')
  async getDiscountByCode(@Param('code') code: string): Promise<unknown> {
    const discount = await this.discountService.findByCode(code);
    if (!discount) {
      return { found: false };
    }
    return { found: true, discount };
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'CREATE' })
  @Post('discounts')
  async createDiscountCode(@Body() dto: CreateDiscountCodeDto, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a discount code');
    return this.discountService.create({ ...dto, createdBy: userId });
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'UPDATE' })
  @Put('discounts/:id')
  async updateDiscountCode(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountCodeDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to update a discount code');
    return this.discountService.update(id, { ...dto, updatedBy: userId });
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'DEACTIVATE' })
  @Post('discounts/:id/deactivate')
  async deactivateDiscountCode(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to deactivate a discount code');
    return this.discountService.deactivate(id, userId);
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'VALIDATE' })
  @Post('discounts/validate')
  async validateDiscountCode(
    @Body() dto: ValidateDiscountCodeDto,
  ): Promise<unknown> {
    return this.discountService.validateCode(dto.code, dto.tenantId, dto.planId, dto.orderAmount);
  }

  @AuditedOperation({ resource: 'DiscountCode', action: 'APPLY' })
  @Post('discounts/apply')
  async applyDiscountCode(
    @Body() dto: ApplyDiscountCodeDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to apply a discount code');
    return this.discountService.applyDiscount(dto.code, dto.tenantId, dto.originalAmount, {
      subscriptionId: dto.subscriptionId,
      invoiceId: dto.invoiceId,
      planId: dto.planId,
      redeemedBy: userId,
    });
  }

  @Get('discounts/:id/redemptions')
  async getDiscountRedemptions(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    return this.discountService.getRedemptions(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @AuditedOperation({ resource: 'UniqueCode', action: 'GENERATE' })
  @Post('discounts/generate-code')
  async generateUniqueCode(
    @Body() dto: GenerateDiscountCodeDto,
  ): Promise<unknown> {
    const code = await this.discountService.generateUniqueCode(dto.prefix, dto.length);
    return { code };
  }

  @AuditedOperation({ resource: 'CreateDiscountCodes', action: 'BULK' })
  @Post('discounts/bulk-create')
  async bulkCreateDiscountCodes(
    @Body() dto: BulkCreateDiscountCodesDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required for bulk discount creation');
    const safeTemplate = { ...dto.template, createdBy: userId };
    const codes = await this.discountService.bulkCreate(dto.count, safeTemplate, dto.codePrefix);
    return { success: true, count: codes.length, codes };
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Subscription', action: 'CREATE' })
  @Post('subscriptions')
  createSubscription(@Req() req: Request): never {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a subscription');
    throw new ConflictException(
      'Subscription creation is billing-service-owned. Use tenant provisioning or a billing-service command workflow.',
    );
  }

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
  async getSubscriptionByTenant(@Param('tenantId') tenantId: string): Promise<unknown> {
    return this.subscriptionService.getSubscriptionByTenant(tenantId);
  }

  @AuditedOperation({ resource: 'Plan', action: 'CHANGE' })
  @Post('subscriptions/change-plan')
  async changePlan(@Body() request: PlanChangeRequest, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to change a subscription plan');
    const { changedBy: _changedBy, ...safeRequest } = request as PlanChangeRequest & { changedBy?: unknown };
    return this.billingAdminCommands.changeSubscriptionPlan(safeRequest, userId);
  }

  // Fix: H8 -- per-route throttle: subscription cancel is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Subscription', action: 'CANCEL' })
  @Post('subscriptions/tenant/:tenantId/cancel')
  async cancelSubscription(
    @Param('tenantId') tenantId: string,
    @Body() dto: CancelSubscriptionDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to cancel a subscription');
    return this.billingAdminCommands.cancelSubscription(tenantId, dto.reason, dto.cancelImmediately, userId);
  }

  @AuditedOperation({ resource: 'Billing', action: 'REACTIVATE_SUBSCRIPTION' })
  @Post('subscriptions/tenant/:tenantId/reactivate')
  async reactivateSubscription(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to reactivate a subscription');
    return this.billingAdminCommands.reactivateSubscription(tenantId, userId);
  }

  @AuditedOperation({ resource: 'Trial', action: 'EXTEND' })
  @Post('subscriptions/tenant/:tenantId/extend-trial')
  async extendTrial(
    @Param('tenantId') tenantId: string,
    @Body() dto: ExtendTrialDto,
    @Req() req: Request,
  ): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to extend a trial');
    return this.billingAdminCommands.extendSubscriptionTrial(tenantId, dto.additionalDays, userId);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Billing', action: 'PROCESS_RENEWALS' })
  @Post('subscriptions/process-renewals')
  @HttpCode(HttpStatus.OK)
  processRenewals(): never {
    throw new ConflictException(
      'Subscription renewal processing is billing-service-owned and cannot be run through admin-api direct writers.',
    );
  }

  // ============================================================================
  // Tenant Redemptions
  // ============================================================================

  @Get('tenant/:tenantId/redemptions')
  async getTenantRedemptions(
    @Param('tenantId') tenantId: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<unknown> {
    return this.discountService.getTenantRedemptions(tenantId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  // ============================================================================
  // Module Pricing
  // ============================================================================

  @Get('module-pricing')
  async getAllModulePricing(): Promise<unknown> {
    return this.modulePricingService.getAllModulePricings();
  }

  @Get('module-pricing/with-modules')
  async getAllModulePricingWithModules(): Promise<unknown> {
    return this.modulePricingService.getAllModulePricingsWithModuleInfo();
  }

  @Get('module-pricing/:moduleId')
  async getModulePricing(@Param('moduleId') moduleId: string): Promise<unknown> {
    return this.modulePricingService.getModulePricing(moduleId);
  }

  @Get('module-pricing/code/:moduleCode')
  async getModulePricingByCode(@Param('moduleCode') moduleCode: string): Promise<unknown> {
    return this.modulePricingService.getModulePricingByCode(moduleCode);
  }

  @Get('module-pricing/:moduleId/history')
  async getModulePricingHistory(
    @Param('moduleId') moduleId: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<unknown> {
    return this.modulePricingService.getPricingHistory(moduleId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @AuditedOperation({ resource: 'ModulePricing', action: 'SET' })
  @Post('module-pricing')
  async setModulePricing(@Body() dto: SetModulePricingDto): Promise<unknown> {
    return this.modulePricingService.setModulePricing(dto);
  }

  @AuditedOperation({ resource: 'ModulePricing', action: 'UPDATE' })
  @Put('module-pricing/:pricingId')
  async updateModulePricing(
    @Param('pricingId') pricingId: string,
    @Body() dto: UpdateModulePricingDto,
  ): Promise<unknown> {
    return this.modulePricingService.updateModulePricing(pricingId, dto);
  }

  @AuditedOperation({ resource: 'ModulePricing', action: 'DEACTIVATE' })
  @Post('module-pricing/:pricingId/deactivate')
  async deactivateModulePricing(@Param('pricingId') pricingId: string): Promise<unknown> {
    await this.modulePricingService.deactivatePricing(pricingId);
    return { success: true };
  }

  @AuditedOperation({ resource: 'Billing', action: 'SEED_MODULE_PRICING' })
  @Post('module-pricing/seed')
  async seedModulePricing(@Body() dto: SeedModulePricingDto): Promise<unknown> {
    const map = new Map(Object.entries(dto.moduleIdMap));
    const count = await this.modulePricingService.seedDefaultPricing(map);
    return { success: true, seededCount: count };
  }

  // ============================================================================
  // Pricing Calculator / Quotes
  // ============================================================================

  @AuditedOperation({ resource: 'Pricing', action: 'CALCULATE' })
  @Post('pricing/calculate')
  async calculatePricing(@Body() request: QuoteRequest): Promise<unknown> {
    return this.pricingCalculator.calculatePricing(request);
  }

  @AuditedOperation({ resource: 'Billing', action: 'GET_QUICK_ESTIMATE' })
  @Post('pricing/quick-estimate')
  async getQuickEstimate(
    @Body() dto: QuickEstimateDto,
  ): Promise<unknown> {
    return this.pricingCalculator.getQuickEstimate(dto.moduleCodes, dto.tier, dto.quantities);
  }

  @AuditedOperation({ resource: 'Pricing', action: 'COMPARE' })
  @Post('pricing/compare')
  async comparePricing(
    @Body() dto: ComparePricingDto,
  ): Promise<unknown> {
    return this.pricingCalculator.comparePricing(
      dto.config1,
      dto.config2,
    );
  }

  // ============================================================================
  // Custom Plans
  // ============================================================================

  @Get('custom-plans')
  async listCustomPlans(
    @Query('tenantId') tenantId?: string,
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
  async getCustomPlanByTenant(@Param('tenantId') tenantId: string): Promise<unknown> {
    return this.customPlanService.getCustomPlanByTenant(tenantId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'CREATE' })
  @Post('custom-plans')
  async createCustomPlan(@Body() dto: CreateCustomPlanDto, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a custom plan');
    return this.customPlanService.createCustomPlan({ ...dto, createdBy: userId });
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'UPDATE' })
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
  @Post('custom-plans/:planId/submit')
  async submitCustomPlanForApproval(@Param('planId') planId: string): Promise<unknown> {
    return this.customPlanService.submitForApproval(planId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'APPROVE' })
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
  @Post('custom-plans/:planId/activate')
  async activateCustomPlan(@Param('planId') planId: string): Promise<unknown> {
    return this.customPlanService.activatePlan(planId);
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'DELETE' })
  @Delete('custom-plans/:planId')
  async deleteCustomPlan(@Param('planId') planId: string): Promise<unknown> {
    await this.customPlanService.deletePlan(planId);
    return { success: true };
  }

  @AuditedOperation({ resource: 'CustomPlan', action: 'CLONE' })
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
    @Query('tenantId') tenantId?: string,
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
  async getTenantInvoices(@Param('tenantId') tenantId: string): Promise<unknown> {
    return this.invoiceService.getTenantInvoices(tenantId);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Invoice', action: 'CREATE' })
  @Post('invoices')
  async createInvoice(@Body() dto: CreateInvoiceRequest, @Req() req: Request): Promise<unknown> {
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

    return this.billingAdminCommands.createInvoice(dto.tenantId, input, userId);
  }

  // Fix: H8 -- per-route throttle: mark invoice paid is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @AuditedOperation({ resource: 'InvoiceAsPaid', action: 'MARK' })
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

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'OverdueStatus', action: 'UPDATE' })
  @Post('invoices/update-overdue')
  @HttpCode(HttpStatus.OK)
  updateOverdueStatus(): never {
    throw new ConflictException(
      'Invoice overdue reconciliation is billing-service-owned and cannot be run through admin-api direct writers.',
    );
  }

  // ============================================================================
  // Payments
  // ============================================================================

  @Get('payments')
  async getPayments(
    @Query('status') status?: string,
    @Query('invoiceId') invoiceId?: string,
    @Query('tenantId') tenantId?: string,
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
  @Post('payments')
  async recordPayment(@Body() dto: RecordPaymentDto, @Req() req: Request): Promise<unknown> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to record a payment');
    return this.billingAdminCommands.recordPayment(dto, userId);
  }

  @ThrottleSensitive()
  @AuditedOperation({ resource: 'Billing', action: 'REFUND_PAYMENT' })
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
    @Param('tenantId') tenantId: string,
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
    @Query('tenantId') tenantId?: string,
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
