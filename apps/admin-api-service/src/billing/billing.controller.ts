import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';
import {
  PlanDefinitionService,
  CreatePlanDto,
  UpdatePlanDto,
} from './services/plan-definition.service';
import {
  DiscountCodeService,
  CreateDiscountCodeDto,
  UpdateDiscountCodeDto,
} from './services/discount-code.service';
import {
  SubscriptionManagementService,
  SubscriptionFilters,
  SubscriptionStatus,
  PlanChangeRequest,
  CreateSubscriptionDto,
} from './services/subscription-management.service';
import {
  ModulePricingService,
  SetModulePricingDto,
} from './services/module-pricing.service';
import {
  PricingCalculatorService,
  QuoteRequest,
  ModuleSelection,
} from './services/pricing-calculator.service';
import {
  CustomPlanService,
  CreateCustomPlanDto,
  UpdateCustomPlanDto,
  CustomPlanFilter,
} from './services/custom-plan.service';
import {
  InvoiceManagementService,
  InvoiceFilters,
} from './services/invoice-management.service';
import { InvoiceStatus } from '../analytics/entities/external/invoice.entity';
import { PlanTier, BillingCycle } from './entities/plan-definition.entity';
import { CustomPlanStatus } from './entities/custom-plan.entity';

/**
 * Billing Controller
 * REST API for subscription and billing management
 */
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
  async createPlan(@Body() dto: CreatePlanDto) {
    return this.planService.create(dto);
  }

  @Put('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.planService.update(id, dto);
  }

  @Post('plans/:id/deprecate')
  async deprecatePlan(
    @Param('id') id: string,
    @Body('updatedBy') updatedBy: string,
  ) {
    return this.planService.deprecate(id, updatedBy);
  }

  @Post('plans/compare')
  async comparePlans(
    @Body('currentPlanId') currentPlanId: string,
    @Body('newPlanId') newPlanId: string,
  ) {
    return this.planService.comparePlans(currentPlanId, newPlanId);
  }

  @Get('plans/defaults/:tier')
  async getDefaultLimits(@Param('tier') tier: PlanTier) {
    return this.planService.getDefaultLimitsForTier(tier);
  }

  @Post('plans/seed')
  async seedPlans(@Body('createdBy') createdBy: string) {
    await this.planService.seedDefaultPlans(createdBy);
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
  ) {
    return this.discountService.findAll({
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      campaignId,
      includeExpired: includeExpired === 'true',
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
  async createDiscountCode(@Body() dto: CreateDiscountCodeDto) {
    return this.discountService.create(dto);
  }

  @Put('discounts/:id')
  async updateDiscountCode(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountCodeDto,
  ) {
    return this.discountService.update(id, dto);
  }

  @Post('discounts/:id/deactivate')
  async deactivateDiscountCode(
    @Param('id') id: string,
    @Body('updatedBy') updatedBy: string,
  ) {
    return this.discountService.deactivate(id, updatedBy);
  }

  @Post('discounts/validate')
  async validateDiscountCode(
    @Body('code') code: string,
    @Body('tenantId') tenantId: string,
    @Body('planId') planId?: string,
    @Body('orderAmount') orderAmount?: number,
  ) {
    return this.discountService.validateCode(code, tenantId, planId, orderAmount);
  }

  @Post('discounts/apply')
  async applyDiscountCode(
    @Body('code') code: string,
    @Body('tenantId') tenantId: string,
    @Body('originalAmount') originalAmount: number,
    @Body('subscriptionId') subscriptionId?: string,
    @Body('invoiceId') invoiceId?: string,
    @Body('planId') planId?: string,
    @Body('redeemedBy') redeemedBy?: string,
  ) {
    return this.discountService.applyDiscount(code, tenantId, originalAmount, {
      subscriptionId,
      invoiceId,
      planId,
      redeemedBy,
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
    @Body('prefix') prefix?: string,
    @Body('length') length?: number,
  ) {
    const code = await this.discountService.generateUniqueCode(prefix, length);
    return { code };
  }

  @Post('discounts/bulk-create')
  async bulkCreateDiscountCodes(
    @Body('count') count: number,
    @Body('template') template: Omit<CreateDiscountCodeDto, 'code'>,
    @Body('codePrefix') codePrefix?: string,
  ) {
    const codes = await this.discountService.bulkCreate(count, template, codePrefix);
    return { success: true, count: codes.length, codes };
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  @Post('subscriptions')
  async createSubscription(@Body() dto: CreateSubscriptionDto) {
    return this.subscriptionService.createSubscription(dto);
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
  async changePlan(@Body() request: PlanChangeRequest) {
    return this.subscriptionService.changePlan(request);
  }

  @Post('subscriptions/tenant/:tenantId/cancel')
  async cancelSubscription(
    @Param('tenantId') tenantId: string,
    @Body('reason') reason: string,
    @Body('cancelledBy') cancelledBy: string,
    @Body('cancelImmediately') cancelImmediately?: boolean,
  ) {
    return this.subscriptionService.cancelSubscription(
      tenantId,
      reason,
      cancelledBy,
      cancelImmediately,
    );
  }

  @Post('subscriptions/tenant/:tenantId/reactivate')
  async reactivateSubscription(
    @Param('tenantId') tenantId: string,
    @Body('reactivatedBy') reactivatedBy: string,
  ) {
    return this.subscriptionService.reactivateSubscription(tenantId, reactivatedBy);
  }

  @Post('subscriptions/tenant/:tenantId/extend-trial')
  async extendTrial(
    @Param('tenantId') tenantId: string,
    @Body('additionalDays') additionalDays: number,
    @Body('extendedBy') extendedBy: string,
  ) {
    return this.subscriptionService.extendTrial(tenantId, additionalDays, extendedBy);
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
  async getTenantRedemptions(@Param('tenantId') tenantId: string) {
    return this.discountService.getTenantRedemptions(tenantId);
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
  async getModulePricingHistory(@Param('moduleId') moduleId: string) {
    return this.modulePricingService.getPricingHistory(moduleId);
  }

  @Post('module-pricing')
  async setModulePricing(@Body() dto: SetModulePricingDto) {
    return this.modulePricingService.setModulePricing(dto);
  }

  @Put('module-pricing/:pricingId')
  async updateModulePricing(
    @Param('pricingId') pricingId: string,
    @Body() dto: Partial<SetModulePricingDto>,
  ) {
    return this.modulePricingService.updateModulePricing(pricingId, dto);
  }

  @Post('module-pricing/:pricingId/deactivate')
  async deactivateModulePricing(@Param('pricingId') pricingId: string) {
    await this.modulePricingService.deactivatePricing(pricingId);
    return { success: true };
  }

  @Post('module-pricing/seed')
  async seedModulePricing(@Body('moduleIdMap') moduleIdMap: Record<string, string>) {
    const map = new Map(Object.entries(moduleIdMap));
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
    @Body('moduleCodes') moduleCodes: string[],
    @Body('tier') tier: PlanTier,
    @Body('quantities') quantities?: {
      users?: number;
      farms?: number;
      ponds?: number;
      sensors?: number;
    },
  ) {
    return this.pricingCalculator.getQuickEstimate(moduleCodes, tier, quantities);
  }

  @Post('pricing/compare')
  async comparePricing(
    @Body('config1') config1: QuoteRequest,
    @Body('config2') config2: QuoteRequest,
  ) {
    return this.pricingCalculator.comparePricing(config1, config2);
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
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const filter: CustomPlanFilter = {
      tenantId,
      status,
      tier,
      search,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
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
  async createCustomPlan(@Body() dto: CreateCustomPlanDto) {
    return this.customPlanService.createCustomPlan(dto);
  }

  @Put('custom-plans/:planId')
  async updateCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: UpdateCustomPlanDto,
  ) {
    return this.customPlanService.updateCustomPlan(planId, dto);
  }

  @Post('custom-plans/:planId/submit')
  async submitCustomPlanForApproval(@Param('planId') planId: string) {
    return this.customPlanService.submitForApproval(planId);
  }

  @Post('custom-plans/:planId/approve')
  async approveCustomPlan(
    @Param('planId') planId: string,
    @Body('approverId') approverId: string,
  ) {
    return this.customPlanService.approvePlan(planId, approverId);
  }

  @Post('custom-plans/:planId/reject')
  async rejectCustomPlan(
    @Param('planId') planId: string,
    @Body('reason') reason: string,
    @Body('rejectedBy') rejectedBy: string,
  ) {
    return this.customPlanService.rejectPlan(planId, reason, rejectedBy);
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
    @Body('newTenantId') newTenantId: string,
  ) {
    return this.customPlanService.clonePlan(planId, newTenantId);
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

  @Post('invoices/:invoiceId/mark-paid')
  async markInvoiceAsPaid(
    @Param('invoiceId') invoiceId: string,
    @Body('amount') amount: number,
    @Body('markedBy') markedBy: string,
  ) {
    return this.invoiceService.markAsPaid(invoiceId, amount, markedBy);
  }

  @Post('invoices/:invoiceId/void')
  async voidInvoice(
    @Param('invoiceId') invoiceId: string,
    @Body('reason') reason: string,
    @Body('voidedBy') voidedBy: string,
  ) {
    return this.invoiceService.voidInvoice(invoiceId, reason, voidedBy);
  }

  @Post('invoices/update-overdue')
  @HttpCode(HttpStatus.OK)
  async updateOverdueStatus() {
    return this.invoiceService.updateOverdueStatus();
  }
}
