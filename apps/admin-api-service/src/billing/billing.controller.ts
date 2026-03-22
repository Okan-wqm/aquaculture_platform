import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

// Fix: H8 -- per-route throttle for sensitive billing operations
import { ThrottleSensitive } from '@aquaculture/backend-common';
import { InvoiceStatus } from '../analytics/entities/external/invoice.entity';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';
import { PaginationQueryDto } from '../shared/pagination-query.dto';

import { CustomPlanStatus } from './entities/custom-plan.entity';
import { PlanTier, BillingCycle } from './entities/plan-definition.entity';
import {
  CustomPlanService,
  CreateCustomPlanDto,
  UpdateCustomPlanDto,
  CustomPlanFilter,
} from './services/custom-plan.service';
import {
  DiscountCodeService,
  CreateDiscountCodeDto,
  UpdateDiscountCodeDto,
} from './services/discount-code.service';
import {
  InvoiceManagementService,
  InvoiceFilters,
} from './services/invoice-management.service';
import {
  PaymentManagementService,
  PaymentFilters,
  RecordPaymentDto,
  RefundPaymentDto,
} from './services/payment-management.service';
import {
  ModulePricingService,
  SetModulePricingDto,
} from './services/module-pricing.service';
import {
  UpdateModulePricingDto,
  SeedModulePricingDto,
  ComparePlansDto,
  ValidateDiscountCodeDto,
  ApplyDiscountCodeDto,
  GenerateDiscountCodeDto,
  BulkCreateDiscountCodesDto,
  CancelSubscriptionDto,
  ExtendTrialDto,
  QuickEstimateDto,
  ComparePricingDto,
  RejectCustomPlanDto,
  CloneCustomPlanDto,
  MarkInvoicePaidDto,
  VoidInvoiceDto,
} from './dto/billing.dto';
import {
  UsageMeteringManagementService,
} from './services/usage-metering-management.service';
import {
  AggregationPeriod,
  MeterType,
} from './entities/usage-aggregation-readonly.entity';
import {
  UsagePeriodType,
} from './entities/tenant-usage-metrics-readonly.entity';
import {
  PlanDefinitionService,
  CreatePlanDto,
  UpdatePlanDto,
} from './services/plan-definition.service';
import {
  PricingCalculatorService,
  QuoteRequest,
  ModuleSelection,
} from './services/pricing-calculator.service';
import {
  SubscriptionManagementService,
  SubscriptionFilters,
  SubscriptionStatus,
  PlanChangeRequest,
  CreateSubscriptionDto,
} from './services/subscription-management.service';

/**
 * Billing Controller
 * REST API for subscription and billing management
 */
@ApiTags('Billing')
@Controller('billing')
@UseGuards(PlatformAdminGuard)
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
    private readonly usageMeteringService: UsageMeteringManagementService,
  ) {}

  // ============================================================================
  // Plan Definitions
  // ============================================================================

  @Get('plans')
  async getPlans(@Query('includeInactive') includeInactive?: string) {
    return this.planService.findAll(includeInactive === 'true');
  }

  @Get('plans/public')
  async getPublicPlans() {
    return this.planService.findPublicPlans();
  }

  @Get('plans/:id')
  async getPlanById(@Param('id') id: string) {
    return this.planService.findById(id);
  }

  @Get('plans/code/:code')
  async getPlanByCode(@Param('code') code: string) {
    return this.planService.findByCode(code);
  }

  @Get('plans/tier/:tier')
  async getPlanByTier(@Param('tier') tier: PlanTier) {
    return this.planService.findByTier(tier);
  }

  @Post('plans')
  async createPlan(@Body() dto: CreatePlanDto, @Req() req: Request) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.planService.create({ ...dto, createdBy: userId });
  }

  @Put('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto, @Req() req: Request) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.planService.update(id, { ...dto, updatedBy: userId });
  }

  @Post('plans/:id/deprecate')
  async deprecatePlan(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.planService.deprecate(id, userId);
  }

  @Post('plans/compare')
  async comparePlans(
    @Body() dto: ComparePlansDto,
  ) {
    return this.planService.comparePlans(dto.currentPlanId, dto.newPlanId);
  }

  @Get('plans/defaults/:tier')
  async getDefaultLimits(@Param('tier') tier: PlanTier) {
    return this.planService.getDefaultLimitsForTier(tier);
  }

  @Post('plans/seed')
  async seedPlans(@Req() req: Request) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
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
  ) {
    return this.discountService.findAll({
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      campaignId,
      includeExpired: includeExpired === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('discounts/stats')
  async getDiscountStats() {
    return this.discountService.getStats();
  }

  @Get('discounts/:id')
  async getDiscountById(@Param('id') id: string) {
    return this.discountService.findById(id);
  }

  @Get('discounts/code/:code')
  async getDiscountByCode(@Param('code') code: string) {
    const discount = await this.discountService.findByCode(code);
    if (!discount) {
      return { found: false };
    }
    return { found: true, discount };
  }

  @Post('discounts')
  async createDiscountCode(@Body() dto: CreateDiscountCodeDto, @Req() req: Request) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.discountService.create({ ...dto, createdBy: userId });
  }

  @Put('discounts/:id')
  async updateDiscountCode(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountCodeDto,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.discountService.update(id, { ...dto, updatedBy: userId });
  }

  @Post('discounts/:id/deactivate')
  async deactivateDiscountCode(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.discountService.deactivate(id, userId);
  }

  @Post('discounts/validate')
  async validateDiscountCode(
    @Body() dto: ValidateDiscountCodeDto,
  ) {
    return this.discountService.validateCode(dto.code, dto.tenantId, dto.planId, dto.orderAmount);
  }

  @Post('discounts/apply')
  async applyDiscountCode(
    @Body() dto: ApplyDiscountCodeDto,
    @Req() req?: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
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
  ) {
    return this.discountService.getRedemptions(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Post('discounts/generate-code')
  async generateUniqueCode(
    @Body() dto: GenerateDiscountCodeDto,
  ) {
    const code = await this.discountService.generateUniqueCode(dto.prefix, dto.length);
    return { code };
  }

  @Post('discounts/bulk-create')
  async bulkCreateDiscountCodes(
    @Body() dto: BulkCreateDiscountCodesDto,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity, review feedback ile eklendi
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    const safeTemplate = { ...dto.template, createdBy: userId };
    const codes = await this.discountService.bulkCreate(dto.count, safeTemplate, dto.codePrefix);
    return { success: true, count: codes.length, codes };
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  @Post('subscriptions')
  async createSubscription(@Body() dto: CreateSubscriptionDto, @Req() req: Request) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.subscriptionService.createSubscription({ ...dto, createdBy: userId });
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
  ) {
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
  async getSubscriptionStats() {
    return this.subscriptionService.getStats();
  }

  @Get('subscriptions/reminders')
  async getSubscriptionsForReminders() {
    return this.subscriptionService.getSubscriptionsForReminders();
  }

  @Get('subscriptions/tenant/:tenantId')
  async getSubscriptionByTenant(@Param('tenantId') tenantId: string) {
    return this.subscriptionService.getSubscriptionByTenant(tenantId);
  }

  @Post('subscriptions/change-plan')
  async changePlan(@Body() request: PlanChangeRequest, @Req() req: Request) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.subscriptionService.changePlan({ ...request, changedBy: userId });
  }

  // Fix: H8 -- per-route throttle: subscription cancel is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Post('subscriptions/tenant/:tenantId/cancel')
  async cancelSubscription(
    @Param('tenantId') tenantId: string,
    @Body() dto: CancelSubscriptionDto,
    @Req() req?: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.subscriptionService.cancelSubscription(
      tenantId,
      dto.reason,
      userId,
      dto.cancelImmediately,
    );
  }

  @Post('subscriptions/tenant/:tenantId/reactivate')
  async reactivateSubscription(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.subscriptionService.reactivateSubscription(tenantId, userId);
  }

  @Post('subscriptions/tenant/:tenantId/extend-trial')
  async extendTrial(
    @Param('tenantId') tenantId: string,
    @Body() dto: ExtendTrialDto,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.subscriptionService.extendTrial(tenantId, dto.additionalDays, userId);
  }

  @Post('subscriptions/process-renewals')
  @HttpCode(HttpStatus.OK)
  async processRenewals() {
    return this.subscriptionService.processRenewals();
  }

  // ============================================================================
  // Tenant Redemptions
  // ============================================================================

  @Get('tenant/:tenantId/redemptions')
  async getTenantRedemptions(
    @Param('tenantId') tenantId: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    return this.discountService.getTenantRedemptions(tenantId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  // ============================================================================
  // Module Pricing
  // ============================================================================

  @Get('module-pricing')
  async getAllModulePricing() {
    return this.modulePricingService.getAllModulePricings();
  }

  @Get('module-pricing/with-modules')
  async getAllModulePricingWithModules() {
    return this.modulePricingService.getAllModulePricingsWithModuleInfo();
  }

  @Get('module-pricing/:moduleId')
  async getModulePricing(@Param('moduleId') moduleId: string) {
    return this.modulePricingService.getModulePricing(moduleId);
  }

  @Get('module-pricing/code/:moduleCode')
  async getModulePricingByCode(@Param('moduleCode') moduleCode: string) {
    return this.modulePricingService.getModulePricingByCode(moduleCode);
  }

  @Get('module-pricing/:moduleId/history')
  async getModulePricingHistory(
    @Param('moduleId') moduleId: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    return this.modulePricingService.getPricingHistory(moduleId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @Post('module-pricing')
  async setModulePricing(@Body() dto: SetModulePricingDto) {
    return this.modulePricingService.setModulePricing(dto);
  }

  @Put('module-pricing/:pricingId')
  async updateModulePricing(
    @Param('pricingId') pricingId: string,
    @Body() dto: UpdateModulePricingDto,
  ) {
    return this.modulePricingService.updateModulePricing(pricingId, dto);
  }

  @Post('module-pricing/:pricingId/deactivate')
  async deactivateModulePricing(@Param('pricingId') pricingId: string) {
    await this.modulePricingService.deactivatePricing(pricingId);
    return { success: true };
  }

  @Post('module-pricing/seed')
  async seedModulePricing(@Body() dto: SeedModulePricingDto) {
    const map = new Map(Object.entries(dto.moduleIdMap));
    const count = await this.modulePricingService.seedDefaultPricing(map);
    return { success: true, seededCount: count };
  }

  // ============================================================================
  // Pricing Calculator / Quotes
  // ============================================================================

  @Post('pricing/calculate')
  async calculatePricing(@Body() request: QuoteRequest) {
    return this.pricingCalculator.calculatePricing(request);
  }

  @Post('pricing/quick-estimate')
  async getQuickEstimate(
    @Body() dto: QuickEstimateDto,
  ) {
    return this.pricingCalculator.getQuickEstimate(dto.moduleCodes, dto.tier, dto.quantities);
  }

  @Post('pricing/compare')
  async comparePricing(
    @Body() dto: ComparePricingDto,
  ) {
    return this.pricingCalculator.comparePricing(
      dto.config1 as QuoteRequest,
      dto.config2 as QuoteRequest,
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
  ) {
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
  async getCustomPlan(@Param('planId') planId: string) {
    return this.customPlanService.getCustomPlan(planId);
  }

  @Get('custom-plans/tenant/:tenantId')
  async getCustomPlanByTenant(@Param('tenantId') tenantId: string) {
    return this.customPlanService.getCustomPlanByTenant(tenantId);
  }

  @Post('custom-plans')
  async createCustomPlan(@Body() dto: CreateCustomPlanDto, @Req() req: Request) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.customPlanService.createCustomPlan({ ...dto, createdBy: userId });
  }

  @Put('custom-plans/:planId')
  async updateCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: UpdateCustomPlanDto,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.customPlanService.updateCustomPlan(planId, { ...dto, updatedBy: userId });
  }

  @Post('custom-plans/:planId/submit')
  async submitCustomPlanForApproval(@Param('planId') planId: string) {
    return this.customPlanService.submitForApproval(planId);
  }

  @Post('custom-plans/:planId/approve')
  async approveCustomPlan(
    @Param('planId') planId: string,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.customPlanService.approvePlan(planId, userId);
  }

  @Post('custom-plans/:planId/reject')
  async rejectCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: RejectCustomPlanDto,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.customPlanService.rejectPlan(planId, dto.reason, userId);
  }

  @Post('custom-plans/:planId/activate')
  async activateCustomPlan(@Param('planId') planId: string) {
    return this.customPlanService.activatePlan(planId);
  }

  @Delete('custom-plans/:planId')
  async deleteCustomPlan(@Param('planId') planId: string) {
    await this.customPlanService.deletePlan(planId);
    return { success: true };
  }

  @Post('custom-plans/:planId/clone')
  async cloneCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: CloneCustomPlanDto,
  ) {
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
  ) {
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
  async getInvoiceStats() {
    return this.invoiceService.getStats();
  }

  @Get('invoices/overdue')
  async getOverdueInvoices() {
    return this.invoiceService.getOverdueInvoices();
  }

  @Get('invoices/:invoiceId')
  async getInvoiceById(@Param('invoiceId') invoiceId: string) {
    return this.invoiceService.getInvoiceById(invoiceId);
  }

  @Get('invoices/tenant/:tenantId')
  async getTenantInvoices(@Param('tenantId') tenantId: string) {
    return this.invoiceService.getTenantInvoices(tenantId);
  }

  // Fix: H8 -- per-route throttle: mark invoice paid is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Post('invoices/:invoiceId/mark-paid')
  async markInvoiceAsPaid(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: MarkInvoicePaidDto,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.invoiceService.markAsPaid(invoiceId, dto.amount, userId);
  }

  // Fix: H8 -- per-route throttle: invoice void is sensitive (3 req / 5 min)
  @ThrottleSensitive()
  @Post('invoices/:invoiceId/void')
  async voidInvoice(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: VoidInvoiceDto,
    @Req() req: Request,
  ) {
    // Fix: C6 -- JWT-based identity
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.invoiceService.voidInvoice(invoiceId, dto.reason, userId);
  }

  @Post('invoices/update-overdue')
  @HttpCode(HttpStatus.OK)
  async updateOverdueStatus() {
    return this.invoiceService.updateOverdueStatus();
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
  ) {
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
  @Post('payments')
  async recordPayment(@Body() dto: RecordPaymentDto, @Req() req: Request) {
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.paymentService.recordPayment(dto, userId);
  }

  @ThrottleSensitive()
  @Post('payments/refund')
  async refundPayment(@Body() dto: RefundPaymentDto, @Req() req: Request) {
    const userId: string = (req as unknown as { user?: { id?: string } }).user?.id ?? '';
    return this.paymentService.refundPayment(dto, userId);
  }

  // ============================================================================
  // Usage Metering
  // ============================================================================

  @Get('usage/summary')
  async getUsageSummary(
    @Query('period') period?: AggregationPeriod,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
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
  ) {
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
  ) {
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
  ) {
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
  ) {
    return this.usageMeteringService.getTopTenantsByUsage(
      meterType || MeterType.API_CALLS,
      period || AggregationPeriod.MONTHLY,
      limit ? parseInt(limit, 10) : 10,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  }

  @Get('usage/tenant/:tenantId/metrics')
  async getTenantUsageMetrics(
    @Param('tenantId') tenantId: string,
    @Query('periodType') periodType?: UsagePeriodType,
    @Query('limit') limit?: string,
  ) {
    return this.usageMeteringService.getTenantUsageMetrics(
      tenantId,
      periodType || UsagePeriodType.MONTHLY,
      limit ? parseInt(limit, 10) : 12,
    );
  }
}
