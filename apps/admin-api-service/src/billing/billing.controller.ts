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
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type BillingAdminCreateInvoiceInput } from '@platform/event-contracts';
import { Request } from 'express';

import { InvoiceStatus } from '../analytics/entities/external/invoice.entity';
import { getAuthUserId } from '../shared/authenticated-request';
import { PaginationQueryDto } from '../shared/pagination-query.dto';
import type {
  ChangeSubscriptionPlanRequest,
  CreateDiscountCodeRequest,
  CreatePlanRequest,
  UpdateDiscountCodeRequest,
  UpdatePlanRequest,
} from './contracts/admin-http-request.contract';

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
import { DiscountCodeService } from './services/discount-code.service';
import { InvoiceFilters, InvoiceManagementService } from './services/invoice-management.service';
import { ModulePricingService, SetModulePricingDto } from './services/module-pricing.service';
import {
  PaymentFilters,
  PaymentManagementService,
  RecordPaymentDto,
  RefundPaymentDto,
} from './services/payment-management.service';
import { PlanDefinitionService } from './services/plan-definition.service';
import { PricingCalculatorService, QuoteRequest } from './services/pricing-calculator.service';
import {
  SubscriptionFilters,
  SubscriptionManagementService,
  SubscriptionStatus,
} from './services/subscription-management.service';
import { UsageMeteringManagementService } from './services/usage-metering-management.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  AdminQueryEncoding,
  AdminResponseContract,
} from '../shared/admin-response-contract.decorator';
import {
  billingPlanDefinitionArrayContract,
  type BillingPlanDefinitionDto,
  billingPlanDefinitionContract,
  billingGetPlanByTierResponseContract,
  type BillingGetPlanByTierResponseDto,
  billingComparePlansResponseContract,
  type BillingComparePlansResponseDto,
  billingPlanLimitsContract,
  type BillingPlanLimitsDto,
  billingSeedPlansResponseContract,
  type BillingSeedPlansResponseDto,
  billingDiscountCodePageContract,
  type BillingDiscountCodeDto,
  billingDiscountStatsContract,
  type BillingDiscountStatsDto,
  billingDiscountCodeContract,
  billingGetDiscountByCodeResponseContract,
  type BillingGetDiscountByCodeResponseDto,
  billingValidateDiscountCodeResponseContract,
  type BillingValidateDiscountCodeResponseDto,
  billingApplyDiscountCodeResponseContract,
  type BillingApplyDiscountCodeResponseDto,
  billingGetDiscountRedemptionsResponseContract,
  type BillingGetDiscountRedemptionsResponseDto,
  billingGenerateUniqueCodeResponseContract,
  type BillingGenerateUniqueCodeResponseDto,
  billingBulkCreateDiscountCodesResponseContract,
  type BillingBulkCreateDiscountCodesResponseDto,
  neverResponseContract,
  type NeverResponseDto,
  billingGetSubscriptionsResponseContract,
  type BillingGetSubscriptionsResponseDto,
  billingSubscriptionStatsContract,
  type BillingSubscriptionStatsDto,
  billingGetSubscriptionsForRemindersResponseContract,
  type BillingGetSubscriptionsForRemindersResponseDto,
  billingGetSubscriptionByTenantResponseContract,
  type BillingGetSubscriptionByTenantResponseDto,
  billingChangePlanResponseContract,
  type BillingChangePlanResponseDto,
  billingCancelSubscriptionResponseContract,
  type BillingCancelSubscriptionResponseDto,
  billingReactivateSubscriptionResponseContract,
  type BillingReactivateSubscriptionResponseDto,
  billingExtendTrialResponseContract,
  type BillingExtendTrialResponseDto,
  billingDiscountRedemptionPageContract,
  type BillingDiscountRedemptionDto,
  billingModulePricingArrayContract,
  type BillingModulePricingDto,
  billingModulePricingWithModuleArrayContract,
  type BillingModulePricingWithModuleDto,
  billingGetModulePricingResponseContract,
  type BillingGetModulePricingResponseDto,
  billingGetModulePricingByCodeResponseContract,
  type BillingGetModulePricingByCodeResponseDto,
  billingModulePricingPageContract,
  billingModulePricingContract,
  billingDeactivateModulePricingResponseContract,
  type BillingDeactivateModulePricingResponseDto,
  billingSeedModulePricingResponseContract,
  type BillingSeedModulePricingResponseDto,
  billingPricingCalculationContract,
  type BillingPricingCalculationDto,
  billingGetQuickEstimateResponseContract,
  type BillingGetQuickEstimateResponseDto,
  billingPricingComparisonResultContract,
  type BillingPricingComparisonResultDto,
  billingPaginatedCustomPlansContract,
  type BillingPaginatedCustomPlansDto,
  billingCustomPlanContract,
  type BillingCustomPlanDto,
  billingGetCustomPlanByTenantResponseContract,
  type BillingGetCustomPlanByTenantResponseDto,
  billingDeleteCustomPlanResponseContract,
  type BillingDeleteCustomPlanResponseDto,
  billingGetInvoicesResponseContract,
  type BillingGetInvoicesResponseDto,
  billingInvoiceStatsContract,
  type BillingInvoiceStatsDto,
  billingInvoiceOverviewArrayContract,
  type BillingInvoiceOverviewDto,
  billingInvoiceOverviewContract,
  billingBillingAdminInvoiceResultContract,
  type BillingBillingAdminInvoiceResultDto,
  billingMarkInvoiceAsPaidResponseContract,
  type BillingMarkInvoiceAsPaidResponseDto,
  billingVoidInvoiceResponseContract,
  type BillingVoidInvoiceResponseDto,
  billingGetPaymentsResponseContract,
  type BillingGetPaymentsResponseDto,
  billingBillingAdminPaymentResultContract,
  type BillingBillingAdminPaymentResultDto,
  billingUsageSummaryStatsContract,
  type BillingUsageSummaryStatsDto,
  billingGetAllTenantsUsageResponseContract,
  type BillingGetAllTenantsUsageResponseDto,
  billingTenantUsageOverviewContract,
  type BillingTenantUsageOverviewDto,
  billingUsageTrendPointArrayContract,
  type BillingUsageTrendPointDto,
  billingTopTenantUsageArrayContract,
  type BillingTopTenantUsageDto,
} from './contracts/admin-http-response.contract';

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

  @AdminResponseContract(billingPlanDefinitionArrayContract)
  @Get('plans')
  async getPlans(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<BillingPlanDefinitionDto[]> {
    return this.planService.findAll(includeInactive === 'true');
  }

  @AdminResponseContract(billingPlanDefinitionArrayContract)
  @Get('plans/public')
  async getPublicPlans(): Promise<BillingPlanDefinitionDto[]> {
    return this.planService.findPublicPlans();
  }

  @AdminResponseContract(billingPlanDefinitionContract)
  @Get('plans/:id')
  async getPlanById(@Param('id') id: string): Promise<BillingPlanDefinitionDto> {
    return this.planService.findById(id);
  }

  @AdminResponseContract(billingPlanDefinitionContract)
  @Get('plans/code/:code')
  async getPlanByCode(@Param('code') code: string): Promise<BillingPlanDefinitionDto> {
    return this.planService.findByCode(code);
  }

  @AdminResponseContract(billingGetPlanByTierResponseContract)
  @Get('plans/tier/:tier')
  async getPlanByTier(@Param('tier') tier: PlanTier): Promise<BillingGetPlanByTierResponseDto> {
    return this.planService.findByTier(tier);
  }

  @AdminResponseContract(billingPlanDefinitionContract)
  @Post('plans')
  async createPlan(
    @Body() dto: CreatePlanRequest,
    @Req() req: Request,
  ): Promise<BillingPlanDefinitionDto> {
    // SECURITY: Require authenticated user for plan creation — anonymous writes to billing data are forbidden.
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a plan');
    return this.planService.create({ ...dto, createdBy: userId });
  }

  @AdminResponseContract(billingPlanDefinitionContract)
  @Put('plans/:id')
  async updatePlan(
    @Param('id') id: string,
    @Body() dto: UpdatePlanRequest,
    @Req() req: Request,
  ): Promise<BillingPlanDefinitionDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to update a plan');
    return this.planService.update(id, { ...dto, updatedBy: userId });
  }

  @AdminResponseContract(billingPlanDefinitionContract)
  @Post('plans/:id/deprecate')
  async deprecatePlan(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<BillingPlanDefinitionDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to deprecate a plan');
    return this.planService.deprecate(id, userId);
  }

  @AdminResponseContract(billingComparePlansResponseContract)
  @Post('plans/compare')
  async comparePlans(@Body() dto: ComparePlansDto): Promise<BillingComparePlansResponseDto> {
    return this.planService.comparePlans(dto.currentPlanId, dto.newPlanId);
  }

  @AdminResponseContract(billingPlanLimitsContract)
  @Get('plans/defaults/:tier')
  getDefaultLimits(@Param('tier') tier: PlanTier): BillingPlanLimitsDto {
    return this.planService.getDefaultLimitsForTier(tier);
  }

  @AdminResponseContract(billingSeedPlansResponseContract)
  @Post('plans/seed')
  async seedPlans(@Req() req: Request): Promise<BillingSeedPlansResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to seed plans');
    await this.planService.seedDefaultPlans(userId);
    return { success: true };
  }

  // ============================================================================
  // Discount Codes
  // ============================================================================

  @AdminResponseContract(billingDiscountCodePageContract)
  @Get('discounts')
  async getDiscountCodes(
    @Query('isActive') isActive?: string,
    @Query('campaignId') campaignId?: string,
    @Query('includeExpired') includeExpired?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<IStandardPaginatedResult<BillingDiscountCodeDto>> {
    return this.discountService.findAll({
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      campaignId,
      includeExpired: includeExpired === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @AdminResponseContract(billingDiscountStatsContract)
  @Get('discounts/stats')
  async getDiscountStats(): Promise<BillingDiscountStatsDto> {
    return this.discountService.getStats();
  }

  @AdminResponseContract(billingDiscountCodeContract)
  @Get('discounts/:id')
  async getDiscountById(@Param('id') id: string): Promise<BillingDiscountCodeDto> {
    return this.discountService.findById(id);
  }

  @AdminResponseContract(billingGetDiscountByCodeResponseContract)
  @Get('discounts/lookup/code/:code')
  async getDiscountByCode(
    @Param('code') code: string,
  ): Promise<BillingGetDiscountByCodeResponseDto> {
    const discount = await this.discountService.findByCode(code);
    if (!discount) {
      return { found: false };
    }
    return { found: true, discount };
  }

  @AdminResponseContract(billingDiscountCodeContract)
  @Post('discounts')
  async createDiscountCode(
    @Body() dto: CreateDiscountCodeRequest,
    @Req() req: Request,
  ): Promise<BillingDiscountCodeDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to create a discount code');
    return this.discountService.create({ ...dto, createdBy: userId });
  }

  @AdminResponseContract(billingDiscountCodeContract)
  @Put('discounts/:id')
  async updateDiscountCode(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountCodeRequest,
    @Req() req: Request,
  ): Promise<BillingDiscountCodeDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to update a discount code');
    return this.discountService.update(id, { ...dto, updatedBy: userId });
  }

  @AdminResponseContract(billingDiscountCodeContract)
  @Post('discounts/:id/deactivate')
  async deactivateDiscountCode(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<BillingDiscountCodeDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to deactivate a discount code');
    return this.discountService.deactivate(id, userId);
  }

  @AdminResponseContract(billingValidateDiscountCodeResponseContract)
  @Post('discounts/validate')
  async validateDiscountCode(
    @Body() dto: ValidateDiscountCodeDto,
  ): Promise<BillingValidateDiscountCodeResponseDto> {
    return this.discountService.validateCode(dto.code, dto.tenantId, dto.planId, dto.orderAmount);
  }

  @AdminResponseContract(billingApplyDiscountCodeResponseContract)
  @Post('discounts/apply')
  async applyDiscountCode(
    @Body() dto: ApplyDiscountCodeDto,
    @Req() req: Request,
  ): Promise<BillingApplyDiscountCodeResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to apply a discount code');
    return this.discountService.applyDiscount(dto.code, dto.tenantId, dto.originalAmount, {
      subscriptionId: dto.subscriptionId,
      invoiceId: dto.invoiceId,
      planId: dto.planId,
      redeemedBy: userId,
    });
  }

  @AdminResponseContract(billingGetDiscountRedemptionsResponseContract)
  @Get('discounts/:id/redemptions')
  async getDiscountRedemptions(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<BillingGetDiscountRedemptionsResponseDto> {
    return this.discountService.getRedemptions(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @AdminResponseContract(billingGenerateUniqueCodeResponseContract)
  @Post('discounts/generate-code')
  async generateUniqueCode(
    @Body() dto: GenerateDiscountCodeDto,
  ): Promise<BillingGenerateUniqueCodeResponseDto> {
    const code = await this.discountService.generateUniqueCode(dto.prefix, dto.length);
    return { code };
  }

  @AdminResponseContract(billingBulkCreateDiscountCodesResponseContract)
  @Post('discounts/bulk-create')
  async bulkCreateDiscountCodes(
    @Body() dto: BulkCreateDiscountCodesDto,
    @Req() req: Request,
  ): Promise<BillingBulkCreateDiscountCodesResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required for bulk discount creation');
    const safeTemplate = { ...dto.template, createdBy: userId };
    const codes = await this.discountService.bulkCreate(dto.count, safeTemplate, dto.codePrefix);
    return { success: true, count: codes.length, codes };
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  @AdminResponseContract(neverResponseContract)
  @ThrottleSensitive()
  @Post('subscriptions')
  createSubscription(@Req() req: Request): never {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to create a subscription');
    throw new ConflictException(
      'Subscription creation is billing-service-owned. Use tenant provisioning or a billing-service command workflow.',
    );
  }

  @AdminResponseContract(billingGetSubscriptionsResponseContract)
  @AdminQueryEncoding({
    billingCycle: 'comma-separated',
    planTier: 'comma-separated',
    status: 'comma-separated',
  })
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
  ): Promise<BillingGetSubscriptionsResponseDto> {
    const filters: SubscriptionFilters = {
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      expiringWithinDays: expiringWithinDays ? parseInt(expiringWithinDays, 10) : undefined,
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

  @AdminResponseContract(billingSubscriptionStatsContract)
  @Get('subscriptions/stats')
  async getSubscriptionStats(): Promise<BillingSubscriptionStatsDto> {
    return this.subscriptionService.getStats();
  }

  @AdminResponseContract(billingGetSubscriptionsForRemindersResponseContract)
  @Get('subscriptions/reminders')
  async getSubscriptionsForReminders(): Promise<BillingGetSubscriptionsForRemindersResponseDto> {
    return this.subscriptionService.getSubscriptionsForReminders();
  }

  @AdminResponseContract(billingGetSubscriptionByTenantResponseContract)
  @Get('subscriptions/tenant/:tenantId')
  async getSubscriptionByTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<BillingGetSubscriptionByTenantResponseDto> {
    return this.subscriptionService.getSubscriptionByTenant(tenantId);
  }

  @AdminResponseContract(billingChangePlanResponseContract)
  @Post('subscriptions/change-plan')
  async changePlan(
    @Body() request: ChangeSubscriptionPlanRequest,
    @Req() req: Request,
  ): Promise<BillingChangePlanResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to change a subscription plan');
    return this.billingAdminCommands.changeSubscriptionPlan(request, userId);
  }

  // Fix: H8 -- per-route throttle: subscription cancel is sensitive (3 req / 5 min)
  @AdminResponseContract(billingCancelSubscriptionResponseContract)
  @ThrottleSensitive()
  @Post('subscriptions/tenant/:tenantId/cancel')
  async cancelSubscription(
    @Param('tenantId') tenantId: string,
    @Body() dto: CancelSubscriptionDto,
    @Req() req: Request,
  ): Promise<BillingCancelSubscriptionResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to cancel a subscription');
    return this.billingAdminCommands.cancelSubscription(
      tenantId,
      dto.reason,
      dto.cancelImmediately,
      userId,
    );
  }

  @AdminResponseContract(billingReactivateSubscriptionResponseContract)
  @Post('subscriptions/tenant/:tenantId/reactivate')
  async reactivateSubscription(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<BillingReactivateSubscriptionResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to reactivate a subscription');
    return this.billingAdminCommands.reactivateSubscription(tenantId, userId);
  }

  @AdminResponseContract(billingExtendTrialResponseContract)
  @Post('subscriptions/tenant/:tenantId/extend-trial')
  async extendTrial(
    @Param('tenantId') tenantId: string,
    @Body() dto: ExtendTrialDto,
    @Req() req: Request,
  ): Promise<BillingExtendTrialResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to extend a trial');
    return this.billingAdminCommands.extendSubscriptionTrial(tenantId, dto.additionalDays, userId);
  }

  @AdminResponseContract(neverResponseContract)
  @ThrottleSensitive()
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

  @AdminResponseContract(billingDiscountRedemptionPageContract)
  @Get('tenant/:tenantId/redemptions')
  async getTenantRedemptions(
    @Param('tenantId') tenantId: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<BillingDiscountRedemptionDto>> {
    return this.discountService.getTenantRedemptions(tenantId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  // ============================================================================
  // Module Pricing
  // ============================================================================

  @AdminResponseContract(billingModulePricingArrayContract)
  @Get('module-pricing')
  async getAllModulePricing(): Promise<BillingModulePricingDto[]> {
    return this.modulePricingService.getAllModulePricings();
  }

  @AdminResponseContract(billingModulePricingWithModuleArrayContract)
  @Get('module-pricing/with-modules')
  async getAllModulePricingWithModules(): Promise<BillingModulePricingWithModuleDto[]> {
    return this.modulePricingService.getAllModulePricingsWithModuleInfo();
  }

  @AdminResponseContract(billingGetModulePricingResponseContract)
  @Get('module-pricing/:moduleId')
  async getModulePricing(
    @Param('moduleId') moduleId: string,
  ): Promise<BillingGetModulePricingResponseDto> {
    return this.modulePricingService.getModulePricing(moduleId);
  }

  @AdminResponseContract(billingGetModulePricingByCodeResponseContract)
  @Get('module-pricing/lookup/code/:moduleCode')
  async getModulePricingByCode(
    @Param('moduleCode') moduleCode: string,
  ): Promise<BillingGetModulePricingByCodeResponseDto> {
    return this.modulePricingService.getModulePricingByCode(moduleCode);
  }

  @AdminResponseContract(billingModulePricingPageContract)
  @Get('module-pricing/:moduleId/history')
  async getModulePricingHistory(
    @Param('moduleId') moduleId: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<BillingModulePricingDto>> {
    return this.modulePricingService.getPricingHistory(moduleId, {
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @AdminResponseContract(billingModulePricingContract)
  @Post('module-pricing')
  async setModulePricing(@Body() dto: SetModulePricingDto): Promise<BillingModulePricingDto> {
    return this.modulePricingService.setModulePricing(dto);
  }

  @AdminResponseContract(billingModulePricingContract)
  @Put('module-pricing/:pricingId')
  async updateModulePricing(
    @Param('pricingId') pricingId: string,
    @Body() dto: UpdateModulePricingDto,
  ): Promise<BillingModulePricingDto> {
    return this.modulePricingService.updateModulePricing(pricingId, dto);
  }

  @AdminResponseContract(billingDeactivateModulePricingResponseContract)
  @Post('module-pricing/:pricingId/deactivate')
  async deactivateModulePricing(
    @Param('pricingId') pricingId: string,
  ): Promise<BillingDeactivateModulePricingResponseDto> {
    await this.modulePricingService.deactivatePricing(pricingId);
    return { success: true };
  }

  @AdminResponseContract(billingSeedModulePricingResponseContract)
  @Post('module-pricing/seed')
  async seedModulePricing(
    @Body() dto: SeedModulePricingDto,
  ): Promise<BillingSeedModulePricingResponseDto> {
    const map = new Map(Object.entries(dto.moduleIdMap));
    const count = await this.modulePricingService.seedDefaultPricing(map);
    return { success: true, seededCount: count };
  }

  // ============================================================================
  // Pricing Calculator / Quotes
  // ============================================================================

  @AdminResponseContract(billingPricingCalculationContract)
  @Post('pricing/calculate')
  async calculatePricing(@Body() request: QuoteRequest): Promise<BillingPricingCalculationDto> {
    return this.pricingCalculator.calculatePricing(request);
  }

  @AdminResponseContract(billingGetQuickEstimateResponseContract)
  @Post('pricing/quick-estimate')
  async getQuickEstimate(
    @Body() dto: QuickEstimateDto,
  ): Promise<BillingGetQuickEstimateResponseDto> {
    return this.pricingCalculator.getQuickEstimate(dto.moduleCodes, dto.tier, dto.quantities);
  }

  @AdminResponseContract(billingPricingComparisonResultContract)
  @Post('pricing/compare')
  async comparePricing(@Body() dto: ComparePricingDto): Promise<BillingPricingComparisonResultDto> {
    return this.pricingCalculator.comparePricing(dto.config1, dto.config2);
  }

  // ============================================================================
  // Custom Plans
  // ============================================================================

  @AdminResponseContract(billingPaginatedCustomPlansContract)
  @Get('custom-plans')
  async listCustomPlans(
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: CustomPlanStatus,
    @Query('tier') tier?: PlanTier,
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<BillingPaginatedCustomPlansDto> {
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

  @AdminResponseContract(billingCustomPlanContract)
  @Get('custom-plans/:planId')
  async getCustomPlan(@Param('planId') planId: string): Promise<BillingCustomPlanDto> {
    return this.customPlanService.getCustomPlan(planId);
  }

  @AdminResponseContract(billingGetCustomPlanByTenantResponseContract)
  @Get('custom-plans/tenant/:tenantId')
  async getCustomPlanByTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<BillingGetCustomPlanByTenantResponseDto> {
    return this.customPlanService.getCustomPlanByTenant(tenantId);
  }

  @AdminResponseContract(billingCustomPlanContract)
  @Post('custom-plans')
  async createCustomPlan(
    @Body() dto: CreateCustomPlanDto,
    @Req() req: Request,
  ): Promise<BillingCustomPlanDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to create a custom plan');
    return this.customPlanService.createCustomPlan({ ...dto, createdBy: userId });
  }

  @AdminResponseContract(billingCustomPlanContract)
  @Put('custom-plans/:planId')
  async updateCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: UpdateCustomPlanDto,
    @Req() req: Request,
  ): Promise<BillingCustomPlanDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to update a custom plan');
    return this.customPlanService.updateCustomPlan(planId, { ...dto, updatedBy: userId });
  }

  @AdminResponseContract(billingCustomPlanContract)
  @Post('custom-plans/:planId/submit')
  async submitCustomPlanForApproval(
    @Param('planId') planId: string,
  ): Promise<BillingCustomPlanDto> {
    return this.customPlanService.submitForApproval(planId);
  }

  @AdminResponseContract(billingCustomPlanContract)
  @Post('custom-plans/:planId/approve')
  async approveCustomPlan(
    @Param('planId') planId: string,
    @Req() req: Request,
  ): Promise<BillingCustomPlanDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to approve a custom plan');
    return this.customPlanService.approvePlan(planId, userId);
  }

  @AdminResponseContract(billingCustomPlanContract)
  @Post('custom-plans/:planId/reject')
  async rejectCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: RejectCustomPlanDto,
    @Req() req: Request,
  ): Promise<BillingCustomPlanDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to reject a custom plan');
    return this.customPlanService.rejectPlan(planId, dto.reason, userId);
  }

  @AdminResponseContract(billingCustomPlanContract)
  @Post('custom-plans/:planId/activate')
  async activateCustomPlan(@Param('planId') planId: string): Promise<BillingCustomPlanDto> {
    return this.customPlanService.activatePlan(planId);
  }

  @AdminResponseContract(billingDeleteCustomPlanResponseContract)
  @Delete('custom-plans/:planId')
  async deleteCustomPlan(
    @Param('planId') planId: string,
  ): Promise<BillingDeleteCustomPlanResponseDto> {
    await this.customPlanService.deletePlan(planId);
    return { success: true };
  }

  @AdminResponseContract(billingCustomPlanContract)
  @Post('custom-plans/:planId/clone')
  async cloneCustomPlan(
    @Param('planId') planId: string,
    @Body() dto: CloneCustomPlanDto,
  ): Promise<BillingCustomPlanDto> {
    return this.customPlanService.clonePlan(planId, dto.newTenantId);
  }

  // ============================================================================
  // Invoices
  // ============================================================================

  @AdminResponseContract(billingGetInvoicesResponseContract)
  @AdminQueryEncoding({ status: 'comma-separated' })
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
  ): Promise<BillingGetInvoicesResponseDto> {
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

  @AdminResponseContract(billingInvoiceStatsContract)
  @Get('invoices/stats')
  async getInvoiceStats(): Promise<BillingInvoiceStatsDto> {
    return this.invoiceService.getStats();
  }

  @AdminResponseContract(billingInvoiceOverviewArrayContract)
  @Get('invoices/overdue')
  async getOverdueInvoices(): Promise<BillingInvoiceOverviewDto[]> {
    return this.invoiceService.getOverdueInvoices();
  }

  @AdminResponseContract(billingInvoiceOverviewContract)
  @Get('invoices/:invoiceId')
  async getInvoiceById(@Param('invoiceId') invoiceId: string): Promise<BillingInvoiceOverviewDto> {
    const invoice = await this.invoiceService.getInvoiceById(invoiceId);
    if (invoice === null) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }
    return invoice;
  }

  @AdminResponseContract(billingInvoiceOverviewArrayContract)
  @Get('invoices/tenant/:tenantId')
  async getTenantInvoices(
    @Param('tenantId') tenantId: string,
  ): Promise<BillingInvoiceOverviewDto[]> {
    return this.invoiceService.getTenantInvoices(tenantId);
  }

  @AdminResponseContract(billingBillingAdminInvoiceResultContract)
  @ThrottleSensitive()
  @Post('invoices')
  async createInvoice(
    @Body() dto: CreateInvoiceRequest,
    @Req() req: Request,
  ): Promise<BillingBillingAdminInvoiceResultDto> {
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
  @AdminResponseContract(billingMarkInvoiceAsPaidResponseContract)
  @ThrottleSensitive()
  @Post('invoices/:invoiceId/mark-paid')
  async markInvoiceAsPaid(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: MarkInvoicePaidDto,
    @Req() req: Request,
  ): Promise<BillingMarkInvoiceAsPaidResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId)
      throw new UnauthorizedException('Authentication required to mark an invoice as paid');
    const invoice = await this.billingAdminCommands.markInvoicePaid(invoiceId, dto.amount, userId);
    return { success: true, invoice };
  }

  // Fix: H8 -- per-route throttle: invoice void is sensitive (3 req / 5 min)
  @AdminResponseContract(billingVoidInvoiceResponseContract)
  @ThrottleSensitive()
  @Post('invoices/:invoiceId/void')
  async voidInvoice(
    @Param('invoiceId') invoiceId: string,
    @Body() dto: VoidInvoiceDto,
    @Req() req: Request,
  ): Promise<BillingVoidInvoiceResponseDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to void an invoice');
    await this.billingAdminCommands.voidInvoice(invoiceId, dto.reason, userId);
    return { success: true };
  }

  @AdminResponseContract(neverResponseContract)
  @ThrottleSensitive()
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

  @AdminResponseContract(billingGetPaymentsResponseContract)
  @AdminQueryEncoding({ status: 'comma-separated' })
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
  ): Promise<BillingGetPaymentsResponseDto> {
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

  @AdminResponseContract(billingBillingAdminPaymentResultContract)
  @ThrottleSensitive()
  @Post('payments')
  async recordPayment(
    @Body() dto: RecordPaymentDto,
    @Req() req: Request,
  ): Promise<BillingBillingAdminPaymentResultDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to record a payment');
    return this.billingAdminCommands.recordPayment(dto, userId);
  }

  @AdminResponseContract(billingBillingAdminPaymentResultContract)
  @ThrottleSensitive()
  @Post('payments/refund')
  async refundPayment(
    @Body() dto: RefundPaymentDto,
    @Req() req: Request,
  ): Promise<BillingBillingAdminPaymentResultDto> {
    const userId = getAuthUserId(req);
    if (!userId) throw new UnauthorizedException('Authentication required to refund a payment');
    return this.billingAdminCommands.refundPayment(dto, userId);
  }

  // ============================================================================
  // Usage Metering
  // ============================================================================

  @AdminResponseContract(billingUsageSummaryStatsContract)
  @Get('usage/summary')
  async getUsageSummary(
    @Query('period') period?: AggregationPeriod,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<BillingUsageSummaryStatsDto> {
    return this.usageMeteringService.getUsageSummary(
      period || AggregationPeriod.MONTHLY,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  }

  @AdminResponseContract(billingGetAllTenantsUsageResponseContract)
  @Get('usage/tenants')
  async getAllTenantsUsage(
    @Query('period') period?: AggregationPeriod,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<BillingGetAllTenantsUsageResponseDto> {
    return this.usageMeteringService.getAllTenantsUsage(
      period || AggregationPeriod.MONTHLY,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      offset ? parseInt(offset, 10) : undefined,
    );
  }

  @AdminResponseContract(billingTenantUsageOverviewContract)
  @Get('usage/tenant/:tenantId')
  async getTenantUsageOverview(
    @Param('tenantId') tenantId: string,
    @Query('period') period?: AggregationPeriod,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<BillingTenantUsageOverviewDto> {
    return this.usageMeteringService.getTenantUsageOverview(
      tenantId,
      period || AggregationPeriod.MONTHLY,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  }

  @AdminResponseContract(billingUsageTrendPointArrayContract)
  @Get('usage/trends')
  async getUsageTrends(
    @Query('period') period?: AggregationPeriod,
    @Query('meterType') meterType?: MeterType,
    @Query('tenantId') tenantId?: string,
    @Query('numPeriods') numPeriods?: string,
  ): Promise<BillingUsageTrendPointDto[]> {
    return this.usageMeteringService.getUsageTrends(
      period || AggregationPeriod.DAILY,
      meterType || undefined,
      tenantId || undefined,
      numPeriods ? parseInt(numPeriods, 10) : 30,
    );
  }

  @AdminResponseContract(billingTopTenantUsageArrayContract)
  @Get('usage/top-tenants')
  async getTopTenantsByUsage(
    @Query('meterType') meterType: MeterType,
    @Query('period') period?: AggregationPeriod,
    @Query('limit') limit?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<BillingTopTenantUsageDto[]> {
    return this.usageMeteringService.getTopTenantsByUsage(
      meterType || MeterType.API_CALLS,
      period || AggregationPeriod.MONTHLY,
      limit ? parseInt(limit, 10) : 10,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  }
}
