import * as crypto from 'crypto';

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type {
  BillingProvisioningModuleItem,
  BillingTenantProvisioningCommand,
} from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { Tenant } from '../../tenant/entities/tenant.entity';
import {
  CustomPlan,
  CustomPlanStatus,
  CustomPlanModule,
  CustomPlanLineItem,
} from '../entities/custom-plan.entity';
import { BillingPlanTier as PlanTier, type BillingCycle } from '@platform/event-contracts';

import { BillingAdminCommandClientService } from './billing-admin-command-client.service';
import { ModulePricingService } from './module-pricing.service';
import type { ModuleQuantities } from './subscription-management.service';

/**
 * DTO for creating a custom plan
 */
export interface CreateCustomPlanDto {
  tenantId: string;
  name: string;
  description?: string;
  basePlanId?: string;
  tier?: PlanTier;
  billingCycle?: BillingCycle;
  modules: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom: Date;
  validTo?: Date;
  notes?: string;
  createdBy?: string;
}

/**
 * DTO for updating custom plan
 */
export interface UpdateCustomPlanDto {
  name?: string;
  description?: string;
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom?: Date;
  validTo?: Date;
  notes?: string;
  updatedBy?: string;
}

/**
 * Filter for listing custom plans
 */
export interface CustomPlanFilter {
  tenantId?: string;
  status?: CustomPlanStatus;
  tier?: PlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Paginated result
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Custom Plan Service
 *
 * Manages tenant-specific custom plans with:
 * - Module selection and pricing
 * - Approval workflow
 * - Activation to subscription
 */
@Injectable()
export class CustomPlanService {
  private readonly logger = new Logger(CustomPlanService.name);

  constructor(
    @InjectRepository(CustomPlan)
    private readonly planRepo: Repository<CustomPlan>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly modulePricingService: ModulePricingService,
    private readonly billingCommands: BillingAdminCommandClientService,
  ) {}

  /**
   * Create a new custom plan
   */
  async createCustomPlan(dto: CreateCustomPlanDto): Promise<CustomPlan> {
    // Calculate pricing for modules
    const { modules, monthlySubtotal, monthlyTotal } = await this.calculatePlanPricing(
      dto.modules,
      dto.tier || PlanTier.CUSTOM,
      dto.createdBy ?? '',
      dto.discountPercent,
      dto.discountAmount,
    );

    const plan = this.planRepo.create({
      tenantId: dto.tenantId,
      name: dto.name,
      description: dto.description,
      basePlanId: dto.basePlanId,
      tier: dto.tier || PlanTier.CUSTOM,
      billingCycle: dto.billingCycle ?? 'monthly',
      modules,
      monthlySubtotal,
      discountPercent: dto.discountPercent || 0,
      discountAmount: dto.discountAmount || 0,
      discountReason: dto.discountReason,
      monthlyTotal,
      currency: 'USD',
      status: CustomPlanStatus.DRAFT,
      validFrom: dto.validFrom,
      validTo: dto.validTo,
      notes: dto.notes,
      createdBy: dto.createdBy,
    });

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Created custom plan ${saved.id} for tenant ${dto.tenantId}`);

    return saved;
  }

  /**
   * Get custom plan by ID
   */
  async getCustomPlan(planId: string): Promise<CustomPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });

    if (!plan) {
      throw new NotFoundException(`Custom plan not found: ${planId}`);
    }

    return plan;
  }

  /**
   * Get custom plan by tenant ID
   */
  async getCustomPlanByTenant(tenantId: string): Promise<CustomPlan | null> {
    return this.planRepo.findOne({
      where: {
        tenantId,
        status: CustomPlanStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * List custom plans with filters
   */
  async listCustomPlans(filter: CustomPlanFilter): Promise<PaginatedResult<CustomPlan>> {
    const { tenantId, status, tier, search, page = 1, limit = 20 } = filter;

    const query = this.planRepo.createQueryBuilder('cp');

    if (tenantId) {
      query.andWhere('cp."tenantId" = :tenantId', { tenantId });
    }

    if (status) {
      query.andWhere('cp.status = :status', { status });
    }

    if (tier) {
      query.andWhere('cp.tier = :tier', { tier });
    }

    if (search) {
      query.andWhere('(cp.name ILIKE :search OR cp.description ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    const [items, total] = await query
      .orderBy('cp."createdAt"', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update custom plan
   */
  async updateCustomPlan(
    planId: string,
    dto: UpdateCustomPlanDto,
  ): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (!plan.canModify()) {
      throw new BadRequestException(
        `Cannot modify plan in status: ${plan.status}`,
      );
    }

    // Recalculate if modules changed
    if (dto.modules) {
      const { modules, monthlySubtotal, monthlyTotal } = await this.calculatePlanPricing(
        dto.modules,
        plan.tier,
        dto.updatedBy ?? plan.createdBy ?? '',
        dto.discountPercent ?? plan.discountPercent,
        dto.discountAmount ?? plan.discountAmount,
      );

      plan.modules = modules;
      plan.monthlySubtotal = monthlySubtotal;
      plan.monthlyTotal = monthlyTotal;
    }

    // Update other fields
    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined) plan.description = dto.description;
    if (dto.discountPercent !== undefined) plan.discountPercent = dto.discountPercent;
    if (dto.discountAmount !== undefined) plan.discountAmount = dto.discountAmount;
    if (dto.discountReason !== undefined) plan.discountReason = dto.discountReason;
    if (dto.validFrom !== undefined) plan.validFrom = dto.validFrom;
    if (dto.validTo !== undefined) plan.validTo = dto.validTo;
    if (dto.notes !== undefined) plan.notes = dto.notes;
    if (dto.updatedBy !== undefined) plan.updatedBy = dto.updatedBy;

    // Recalculate total if discounts changed
    if (dto.discountPercent !== undefined || dto.discountAmount !== undefined) {
      plan.monthlyTotal = this.calculateFinalTotal(
        plan.monthlySubtotal,
        plan.discountPercent,
        plan.discountAmount,
      );
    }

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Updated custom plan ${planId}`);

    return saved;
  }

  /**
   * Submit plan for approval
   */
  async submitForApproval(planId: string): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (plan.status !== CustomPlanStatus.DRAFT) {
      throw new BadRequestException('Only draft plans can be submitted for approval');
    }

    if (plan.modules.length === 0) {
      throw new BadRequestException('Plan must have at least one module');
    }

    plan.status = CustomPlanStatus.PENDING_APPROVAL;
    const saved = await this.planRepo.save(plan);

    this.logger.log(`Plan ${planId} submitted for approval`);
    return saved;
  }

  /**
   * Approve custom plan
   */
  async approvePlan(planId: string, approverId: string): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (!plan.canApprove()) {
      throw new BadRequestException(
        `Cannot approve plan in status: ${plan.status}`,
      );
    }

    plan.status = CustomPlanStatus.APPROVED;
    plan.approvedBy = approverId;
    plan.approvedAt = new Date();

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Plan ${planId} approved by ${approverId}`);

    return saved;
  }

  /**
   * Reject custom plan
   */
  async rejectPlan(
    planId: string,
    reason: string,
    rejectedBy: string,
  ): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (plan.status !== CustomPlanStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Only pending plans can be rejected');
    }

    plan.status = CustomPlanStatus.REJECTED;
    plan.rejectionReason = reason;
    plan.updatedBy = rejectedBy;

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Plan ${planId} rejected: ${reason}`);

    return saved;
  }

  /**
   * Activate an approved custom plan: billing-service creates the subscription.
   *
   * billing-service is the single writer of `billing.subscriptions` (D14).
   * admin-api sends the same `ProvisionTenantSubscription` command tenant
   * provisioning sends, with the plan's priced modules as `moduleItems` and
   * the plan-level discount allocated across them, and records the returned
   * subscription id on the plan. Both command identifiers derive from the
   * plan id, so a retry after a timeout replays billing's receipt instead of
   * provisioning a second subscription (ADMIN-HIGH-011: the previous
   * implementation called a retired admin-api writer that always answered 409).
   */
  async activatePlan(planId: string, activatedBy: string): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (!plan.canActivate()) {
      throw new BadRequestException(
        `Cannot activate plan in status: ${plan.status}`,
      );
    }

    const tenant = await this.tenantRepo.findOne({
      where: { id: plan.tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${plan.tenantId} for custom plan ${planId} not found`);
    }

    const command = this.buildProvisioningCommand(plan, tenant.name, activatedBy);
    const result = await this.billingCommands.provisionTenantSubscription(command);
    if (!result.subscriptionId) {
      throw new Error(
        `Billing provisioning for custom plan ${planId} completed without a subscription id`,
      );
    }

    plan.subscriptionId = result.subscriptionId;
    plan.status = CustomPlanStatus.ACTIVE;
    const saved = await this.planRepo.save(plan);

    this.logger.log(
      `Plan ${planId} activated with subscription ${result.subscriptionId}` +
        (result.replayed ? ' (billing receipt replayed)' : ''),
    );
    return saved;
  }

  /** The billing command for one plan — pure, so a retry sends byte-identical identifiers. */
  buildProvisioningCommand(
    plan: CustomPlan,
    tenantName: string,
    actorId: string,
  ): BillingTenantProvisioningCommand {
    const moduleItems = this.toProvisioningModuleItems(plan);
    const semantic = {
      tenantId: plan.tenantId,
      tenantName,
      tier: this.toCommandTier(plan.tier),
      billingCycle: plan.billingCycle,
      moduleIds: plan.modules.map((module) => module.moduleId),
      moduleItems,
      customPlanId: plan.id,
    };
    return {
      operationId: this.deterministicUuid(`custom-plan-activation:${plan.id}`),
      idempotencyKey: `custom-plan:${plan.id}:activate`,
      requestPayloadHash: crypto
        .createHash('sha256')
        .update(JSON.stringify(semantic))
        .digest('hex'),
      actorId,
      ...semantic,
    };
  }

  /**
   * The plan's modules as billing module rows. The plan-level discount is
   * allocated across modules in proportion to each module's subtotal (largest
   * remainder on the last row so the parts sum exactly to the plan discount).
   */
  private toProvisioningModuleItems(plan: CustomPlan): BillingProvisioningModuleItem[] {
    const subtotal = plan.modules.reduce((sum, module) => sum + module.subtotal, 0);
    const discount = Math.max(0, Number(plan.discountAmount) || 0);
    let allocated = 0;
    return plan.modules.map((module, index) => {
      const isLast = index === plan.modules.length - 1;
      const share =
        subtotal > 0
          ? isLast
            ? this.round(discount - allocated)
            : this.round((discount * module.subtotal) / subtotal)
          : 0;
      allocated = this.round(allocated + share);
      return {
        moduleId: module.moduleId,
        code: module.moduleCode,
        name: module.moduleName,
        quantities: { moduleId: module.moduleId, ...module.quantities },
        lineItems: module.lineItems,
        // ADR-0013: the provisioning contract carries exact decimal strings.
        // These come back out of the plan's jsonb, so they are stringified at
        // the point they leave admin rather than travelling as doubles.
        subtotal: String(module.subtotal),
        discountAmount: String(share),
        total: String(this.round(module.subtotal - share)),
      };
    });
  }

  /** CUSTOM is not a billing-command tier: a custom plan travels as enterprise + customPlanId. */
  private toCommandTier(tier: PlanTier): BillingTenantProvisioningCommand['tier'] {
    return tier === PlanTier.CUSTOM ? PlanTier.ENTERPRISE : tier;
  }

  private deterministicUuid(seed: string): string {
    const hex = crypto.createHash('sha256').update(seed).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * Delete custom plan (only drafts)
   */
  async deletePlan(planId: string): Promise<void> {
    const plan = await this.getCustomPlan(planId);

    if (plan.status !== CustomPlanStatus.DRAFT) {
      throw new BadRequestException('Only draft plans can be deleted');
    }

    await this.planRepo.remove(plan);
    this.logger.log(`Plan ${planId} deleted`);
  }

  /**
   * Clone an existing plan
   */
  async clonePlan(planId: string, newTenantId: string): Promise<CustomPlan> {
    const sourcePlan = await this.getCustomPlan(planId);

    const clone = this.planRepo.create({
      ...sourcePlan,
      id: undefined,
      tenantId: newTenantId,
      name: `${sourcePlan.name} (Copy)`,
      status: CustomPlanStatus.DRAFT,
      approvedBy: null,
      approvedAt: null,
      subscriptionId: null,
      createdAt: undefined,
      updatedAt: undefined,
    });

    return this.planRepo.save(clone);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Price the plan's modules — by asking billing (ADR-0013).
   *
   * This was a fourth copy of the module arithmetic: it read the price sheet,
   * applied the tier multiplier and summed the line items in floats, beside
   * the same logic in `PricingCalculatorService`, in the browser on
   * CreateTenantPage, and in billing's own provisioning path. billing owns
   * the sheet, so billing does the multiplication, and a custom plan is priced
   * by the same code that will price its invoice.
   *
   * The `number` fields below are the plan's `modules` jsonb column, which is
   * still money-in-jsonb (governed by `.claude/allowlists/money-in-jsonb.yaml`
   * until `custom_plans` itself moves). Billing's exact decimal strings are
   * converted once, here, rather than accumulating float error across the
   * calculation.
   */
  private async calculatePlanPricing(
    moduleInputs: Array<{
      moduleId: string;
      moduleCode: string;
      moduleName: string;
      quantities: ModuleQuantities;
    }>,
    tier: PlanTier,
    actorId: string,
    discountPercent?: number,
    discountAmount?: number,
  ): Promise<{
    modules: CustomPlanModule[];
    monthlySubtotal: number;
    monthlyTotal: number;
  }> {
    if (moduleInputs.length === 0) {
      return { modules: [], monthlySubtotal: 0, monthlyTotal: 0 };
    }

    const quote = await this.modulePricingService.quote(
      {
        modules: moduleInputs.map((input) => ({
          moduleId: input.moduleId,
          moduleCode: input.moduleCode,
          moduleName: input.moduleName,
          quantities: input.quantities,
        })),
        tier,
        billingCycle: 'monthly',
      },
      actorId,
    );

    if (quote.unpricedModuleCodes.length > 0) {
      // A module the operator put on the plan that carries no price is a
      // decision they have to make, not a silent omission from the total.
      this.logger.warn(
        JSON.stringify({
          event: 'custom-plan.unpriced-modules',
          moduleCodes: quote.unpricedModuleCodes,
        }),
      );
    }

    const byModuleId = new Map(quote.modules.map((breakdown) => [breakdown.moduleId, breakdown]));
    const modules: CustomPlanModule[] = moduleInputs.map((input) => {
      const breakdown = byModuleId.get(input.moduleId);
      const lineItems: CustomPlanLineItem[] = (breakdown?.lineItems ?? []).map((line) => ({
        metric: line.metric,
        description: line.metricLabel,
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice),
        total: Number(line.total),
      }));
      return {
        moduleId: input.moduleId,
        moduleCode: input.moduleCode,
        moduleName: input.moduleName,
        quantities: input.quantities,
        lineItems,
        subtotal: Number(breakdown?.subtotal ?? '0'),
      };
    });

    const monthlySubtotal = Number(quote.subtotal);
    const monthlyTotal = this.calculateFinalTotal(
      monthlySubtotal,
      discountPercent,
      discountAmount,
    );

    return { modules, monthlySubtotal, monthlyTotal };
  }

  /**
   * Calculate final total with discounts
   */
  private calculateFinalTotal(
    subtotal: number,
    discountPercent?: number,
    discountAmount?: number,
  ): number {
    let total = subtotal;

    if (discountPercent && discountPercent > 0) {
      total -= total * (discountPercent / 100);
    }

    if (discountAmount && discountAmount > 0) {
      total -= discountAmount;
    }

    return Math.max(0, total);
  }
}
