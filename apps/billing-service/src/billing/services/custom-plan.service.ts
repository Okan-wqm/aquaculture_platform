/**
 * The custom-plan writer — billing is the only one (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * A custom plan is a negotiated price: a module selection, a discount and a
 * validity window that together decide what a subscription costs. It lived in
 * `admin.custom_plans`, priced by a fourth float copy of billing's own
 * arithmetic, with every per-module and per-line amount inside one `jsonb`
 * column. Here the plan is priced by the same `ModulePricingService` that will
 * price its invoice, in `Decimal`, and stored as rows.
 *
 * The lifecycle (draft → pending_approval → approved → active, or rejected)
 * is enforced here rather than in the caller: a transition guard that lives in
 * the UI is not a guard.
 */
import { roundToCurrency } from '@aquaculture/backend-common/monetary';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type {
  BillingCustomPlanInput,
  BillingCustomPlanModuleSelection,
  BillingCustomPlanSnapshot,
  BillingCustomPlanStatus,
  BillingCustomPlanUpdateInput,
  BillingModuleQuote,
  BillingPlanTier as ContractPlanTier,
  BillingProvisioningModuleItem,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { CustomPlan, CustomPlanLineItem, CustomPlanModule } from '../entities/custom-plan.entity';
import { BillingCycle, PlanTier } from '../entities/subscription.entity';

import { ModulePricingService } from './module-pricing.service';

/**
 * The transitions the lifecycle permits. A status not named here is terminal:
 * `active`, `expired` and `rejected` are the end of a plan's editable life.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<BillingCustomPlanStatus, readonly BillingCustomPlanStatus[]>
> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'rejected'],
  approved: ['active'],
  active: ['expired'],
  expired: [],
  rejected: [],
};

/** Statuses whose plan may still be edited. */
const EDITABLE: readonly BillingCustomPlanStatus[] = ['draft', 'pending_approval'];

export interface CustomPlanFilter {
  tenantId?: string;
  status?: BillingCustomPlanStatus;
  tier?: ContractPlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CustomPlanPage {
  items: CustomPlan[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class CustomPlanService {
  private readonly logger = new Logger(CustomPlanService.name);

  constructor(
    @InjectRepository(CustomPlan)
    private readonly plans: Repository<CustomPlan>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly modulePricing: ModulePricingService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  async findById(customPlanId: string): Promise<CustomPlan> {
    const found = await this.plans.findOne({
      where: { id: customPlanId },
      relations: { modules: { lineItems: true } },
    });
    if (!found) throw new NotFoundException(`Custom plan ${customPlanId} not found`);
    return found;
  }

  /**
   * The tenant's plan in force TODAY.
   *
   * The admin version selected on `status = ACTIVE` alone, and nothing ever
   * set a plan to `expired`, so a plan whose `validTo` had passed years ago
   * still came back as the tenant's current price. The window is part of the
   * question, so it is part of the query.
   */
  async findActiveForTenant(tenantId: string, asOf = new Date()): Promise<CustomPlan | null> {
    const today = asOf.toISOString().slice(0, 10);
    return this.plans
      .createQueryBuilder('plan')
      .leftJoinAndSelect('plan.modules', 'module')
      .leftJoinAndSelect('module.lineItems', 'lineItem')
      .where('plan.tenant_id = :tenantId', { tenantId })
      .andWhere('plan.status = :status', { status: 'active' })
      .andWhere('plan.valid_from <= :today', { today })
      .andWhere('(plan.valid_to IS NULL OR plan.valid_to >= :today)', { today })
      .orderBy('plan.created_at', 'DESC')
      .getOne();
  }

  async list(filter: CustomPlanFilter): Promise<CustomPlanPage> {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 20));

    const query = this.plans
      .createQueryBuilder('plan')
      .leftJoinAndSelect('plan.modules', 'module')
      .leftJoinAndSelect('module.lineItems', 'lineItem');

    if (filter.tenantId)
      query.andWhere('plan.tenant_id = :tenantId', { tenantId: filter.tenantId });
    if (filter.status) query.andWhere('plan.status = :status', { status: filter.status });
    if (filter.tier) query.andWhere('plan.tier = :tier', { tier: filter.tier });
    if (filter.search) {
      query.andWhere('(plan.name ILIKE :search OR plan.description ILIKE :search)', {
        search: `%${filter.search}%`,
      });
    }

    const [items, total] = await query
      .orderBy('plan.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  async create(input: BillingCustomPlanInput, actorId: string): Promise<CustomPlan> {
    assertValidity(input.validFrom, input.validTo);
    const discountPercent = assertPercent(input.discountPercent ?? '0');
    const discountAmount = assertAmount(input.discountAmount ?? '0', 'discountAmount');
    const tier = (input.tier ?? PlanTier.CUSTOM) as PlanTier;

    const quote = await this.priceSelection(
      input.modules,
      tier,
      actorId,
      discountPercent,
      discountAmount,
    );
    const subtotal = new Decimal(quote.subtotal);
    // The total comes back FROM the quote: `ModulePricingService` owns the one
    // implementation of the negotiated-discount rule, so the plan's stored
    // total and the builder's preview are the same number from the same code.
    const total = new Decimal(quote.monthlyTotal);

    return this.dataSource.transaction(async (manager) => {
      const plan = manager.create(CustomPlan, {
        tenantId: input.tenantId,
        name: input.name.trim(),
        description: input.description ?? null,
        basePlanId: input.basePlanId ?? null,
        tier,
        billingCycle: (input.billingCycle ?? BillingCycle.MONTHLY) as BillingCycle,
        monthlySubtotal: subtotal,
        discountPercent,
        discountAmount,
        discountReason: input.discountReason ?? null,
        monthlyTotal: total,
        currency: (input.currency ?? quote.currency).toUpperCase(),
        status: 'draft',
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
        approvedBy: null,
        approvedAt: null,
        rejectionReason: null,
        notes: input.notes ?? null,
        subscriptionId: null,
        unpricedModuleCodes: quote.unpricedModuleCodes,
        createdBy: actorId,
        updatedBy: actorId,
      });
      const saved = await manager.save(plan);
      await this.replaceModules(manager, saved.id, input.modules, quote);

      this.logger.log(
        JSON.stringify({
          event: 'custom-plan.created',
          customPlanId: saved.id,
          tenantId: input.tenantId,
          actorId,
        }),
      );
      return this.reload(manager, saved.id);
    });
  }

  async update(
    customPlanId: string,
    input: BillingCustomPlanUpdateInput,
    actorId: string,
  ): Promise<CustomPlan> {
    const existing = await this.findById(customPlanId);
    if (!EDITABLE.includes(existing.status)) {
      throw new BadRequestException(`Cannot modify a plan in status ${existing.status}`);
    }

    const validFrom = input.validFrom ?? existing.validFrom;
    const validTo = input.validTo !== undefined ? input.validTo : existing.validTo;
    assertValidity(validFrom, validTo ?? undefined);

    const discountPercent =
      input.discountPercent !== undefined
        ? assertPercent(input.discountPercent)
        : existing.discountPercent;
    const discountAmount =
      input.discountAmount !== undefined
        ? assertAmount(input.discountAmount, 'discountAmount')
        : existing.discountAmount;

    // A repricing needs the whole selection, so it happens only when the
    // caller sends one; otherwise the stored subtotal stands and only the
    // discount is re-applied to it.
    // A repricing needs the whole selection. When none is sent, the stored
    // selection is re-quoted so a discount change is applied by the same code
    // that applied the original one — never by a second copy of the rule here.
    const selection: BillingCustomPlanModuleSelection[] =
      input.modules ??
      (existing.modules ?? []).map((module) => ({
        moduleId: module.moduleId,
        moduleCode: module.moduleCode,
        moduleName: module.moduleName,
        quantities: module.quantities,
      }));
    const quote = await this.priceSelection(
      selection,
      existing.tier,
      actorId,
      discountPercent,
      discountAmount,
    );
    const subtotal = new Decimal(quote.subtotal);

    return this.dataSource.transaction(async (manager) => {
      if (input.name !== undefined) existing.name = input.name.trim();
      if (input.description !== undefined) existing.description = input.description;
      if (input.billingCycle !== undefined) {
        existing.billingCycle = input.billingCycle as BillingCycle;
      }
      if (input.discountReason !== undefined) existing.discountReason = input.discountReason;
      if (input.currency !== undefined) existing.currency = input.currency.toUpperCase();
      if (input.validFrom !== undefined) existing.validFrom = input.validFrom;
      if (input.validTo !== undefined) existing.validTo = input.validTo ?? null;
      if (input.notes !== undefined) existing.notes = input.notes;

      existing.discountPercent = discountPercent;
      existing.discountAmount = discountAmount;
      existing.monthlySubtotal = subtotal;
      existing.monthlyTotal = new Decimal(quote.monthlyTotal);
      existing.unpricedModuleCodes = quote.unpricedModuleCodes;
      existing.updatedBy = actorId;
      await manager.save(existing);

      if (input.modules) {
        await this.replaceModules(manager, customPlanId, input.modules, quote);
      }

      this.logger.log(JSON.stringify({ event: 'custom-plan.updated', customPlanId, actorId }));
      return this.reload(manager, customPlanId);
    });
  }

  async submitForApproval(customPlanId: string, actorId: string): Promise<CustomPlan> {
    const plan = await this.findById(customPlanId);
    this.assertTransition(plan, 'pending_approval');
    if ((plan.modules ?? []).length === 0) {
      throw new BadRequestException('A custom plan must price at least one module');
    }
    plan.status = 'pending_approval';
    plan.updatedBy = actorId;
    await this.plans.save(plan);
    this.logger.log(JSON.stringify({ event: 'custom-plan.submitted', customPlanId, actorId }));
    return this.findById(customPlanId);
  }

  async approve(customPlanId: string, actorId: string): Promise<CustomPlan> {
    const plan = await this.findById(customPlanId);
    this.assertTransition(plan, 'approved');
    plan.status = 'approved';
    plan.approvedBy = actorId;
    plan.approvedAt = new Date();
    plan.updatedBy = actorId;
    await this.plans.save(plan);
    this.logger.log(JSON.stringify({ event: 'custom-plan.approved', customPlanId, actorId }));
    return this.findById(customPlanId);
  }

  async reject(customPlanId: string, reason: string, actorId: string): Promise<CustomPlan> {
    if (!reason.trim()) throw new BadRequestException('A rejection needs a reason');
    const plan = await this.findById(customPlanId);
    this.assertTransition(plan, 'rejected');
    plan.status = 'rejected';
    plan.rejectionReason = reason.trim();
    plan.updatedBy = actorId;
    await this.plans.save(plan);
    this.logger.log(JSON.stringify({ event: 'custom-plan.rejected', customPlanId, actorId }));
    return this.findById(customPlanId);
  }

  /**
   * Mark the plan live against the subscription it provisioned.
   *
   * The provisioning itself belongs to the subscription path; this records the
   * result and closes the lifecycle. The validity window is checked here
   * because an approved plan whose `validTo` has passed prices nothing — the
   * admin implementation activated it anyway, and `isValid()` existed but was
   * never called from anywhere.
   */
  async activate(
    customPlanId: string,
    subscriptionId: string,
    actorId: string,
    asOf = new Date(),
  ): Promise<CustomPlan> {
    const plan = await this.findById(customPlanId);
    this.assertTransition(plan, 'active');

    const today = asOf.toISOString().slice(0, 10);
    if (plan.validTo !== null && plan.validTo < today) {
      throw new BadRequestException(
        `Custom plan ${customPlanId} expired on ${plan.validTo} and cannot be activated`,
      );
    }

    plan.status = 'active';
    plan.subscriptionId = subscriptionId;
    plan.updatedBy = actorId;
    await this.plans.save(plan);
    this.logger.log(
      JSON.stringify({ event: 'custom-plan.activated', customPlanId, subscriptionId, actorId }),
    );
    return this.findById(customPlanId);
  }

  /**
   * Copy a plan onto another tenant as a fresh draft.
   *
   * Everything that belongs to the SOURCE plan's history is dropped: its
   * approval, its rejection reason, its subscription, and its author. The
   * admin version spread the source row wholesale, so a clone was credited to
   * whoever wrote the original rather than to the operator who cloned it.
   */
  async clone(customPlanId: string, targetTenantId: string, actorId: string): Promise<CustomPlan> {
    const source = await this.findById(customPlanId);

    return this.dataSource.transaction(async (manager) => {
      const clone = manager.create(CustomPlan, {
        tenantId: targetTenantId,
        name: `${source.name} (Copy)`,
        description: source.description,
        basePlanId: source.basePlanId,
        tier: source.tier,
        billingCycle: source.billingCycle,
        monthlySubtotal: source.monthlySubtotal,
        discountPercent: source.discountPercent,
        discountAmount: source.discountAmount,
        discountReason: source.discountReason,
        monthlyTotal: source.monthlyTotal,
        currency: source.currency,
        status: 'draft',
        validFrom: source.validFrom,
        validTo: source.validTo,
        approvedBy: null,
        approvedAt: null,
        rejectionReason: null,
        notes: source.notes,
        subscriptionId: null,
        unpricedModuleCodes: source.unpricedModuleCodes,
        createdBy: actorId,
        updatedBy: actorId,
      });
      const saved = await manager.save(clone);

      for (const module of source.modules ?? []) {
        const copiedModule = await manager.save(
          manager.create(CustomPlanModule, {
            customPlanId: saved.id,
            moduleId: module.moduleId,
            moduleCode: module.moduleCode,
            moduleName: module.moduleName,
            quantities: module.quantities,
            subtotal: module.subtotal,
          }),
        );
        if ((module.lineItems ?? []).length > 0) {
          await manager.save(
            (module.lineItems ?? []).map((line) =>
              manager.create(CustomPlanLineItem, {
                customPlanModuleId: copiedModule.id,
                metric: line.metric,
                metricLabel: line.metricLabel,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                total: line.total,
              }),
            ),
          );
        }
      }

      this.logger.log(
        JSON.stringify({
          event: 'custom-plan.cloned',
          customPlanId,
          cloneId: saved.id,
          targetTenantId,
          actorId,
        }),
      );
      return this.reload(manager, saved.id);
    });
  }

  /** Only a draft can be deleted; anything further along is a record. */
  async remove(customPlanId: string, actorId: string): Promise<void> {
    const plan = await this.findById(customPlanId);
    if (plan.status !== 'draft') {
      throw new BadRequestException('Only draft custom plans can be deleted');
    }
    await this.plans.delete({ id: customPlanId });
    this.logger.log(JSON.stringify({ event: 'custom-plan.deleted', customPlanId, actorId }));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Price the selection with the SAME service that prices an invoice. The
   * admin implementation asked for this over NATS and then re-derived the
   * totals from the reply in floats; here it is one in-process call and the
   * decimals never widen.
   */
  private async priceSelection(
    modules: BillingCustomPlanModuleSelection[],
    tier: PlanTier,
    actorId: string,
    discountPercent: Decimal,
    discountAmount: Decimal,
  ): Promise<BillingModuleQuote> {
    if (modules.length === 0) {
      throw new BadRequestException('A custom plan must select at least one module');
    }
    return this.modulePricing.quote({
      modules: modules.map((module) => ({
        moduleId: module.moduleId,
        moduleCode: module.moduleCode,
        moduleName: module.moduleName,
        quantities: module.quantities,
      })),
      tier,
      billingCycle: BillingCycle.MONTHLY,
      negotiatedDiscountPercent: discountPercent.toString(),
      negotiatedDiscountAmount: discountAmount.toString(),
      actorId,
    });
  }

  /**
   * Replace the priced selection wholesale, in the caller's transaction — the
   * same all-or-nothing rule the plan catalogue uses: no reader observes a
   * plan priced half old and half new.
   */
  private async replaceModules(
    manager: EntityManager,
    customPlanId: string,
    selections: BillingCustomPlanModuleSelection[],
    quote: BillingModuleQuote,
  ): Promise<void> {
    await manager.delete(CustomPlanModule, { customPlanId });

    const byModuleId = new Map(quote.modules.map((breakdown) => [breakdown.moduleId, breakdown]));
    for (const selection of selections) {
      const breakdown = byModuleId.get(selection.moduleId);
      const module = await manager.save(
        manager.create(CustomPlanModule, {
          customPlanId,
          moduleId: selection.moduleId,
          moduleCode: selection.moduleCode,
          moduleName: selection.moduleName,
          quantities: selection.quantities,
          subtotal: new Decimal(breakdown?.subtotal ?? '0'),
        }),
      );
      const lineItems = breakdown?.lineItems ?? [];
      if (lineItems.length > 0) {
        await manager.save(
          lineItems.map((line) =>
            manager.create(CustomPlanLineItem, {
              customPlanModuleId: module.id,
              metric: line.metric,
              metricLabel: line.metricLabel,
              quantity: line.billableQuantity,
              unitPrice: new Decimal(line.unitPrice),
              total: new Decimal(line.total),
            }),
          ),
        );
      }
    }
  }

  private assertTransition(plan: CustomPlan, next: BillingCustomPlanStatus): void {
    if (!ALLOWED_TRANSITIONS[plan.status].includes(next)) {
      throw new BadRequestException(`A custom plan in status ${plan.status} cannot become ${next}`);
    }
  }

  private async reload(manager: EntityManager, customPlanId: string): Promise<CustomPlan> {
    const reloaded = await manager.findOne(CustomPlan, {
      where: { id: customPlanId },
      relations: { modules: { lineItems: true } },
    });
    if (!reloaded) throw new Error('custom plan vanished within its own transaction');
    return reloaded;
  }
}

function assertPercent(value: string): Decimal {
  const percent = new Decimal(value);
  if (percent.isNegative() || percent.greaterThan(100)) {
    throw new BadRequestException('discountPercent must be between 0 and 100');
  }
  return percent;
}

function assertAmount(value: string, field: string): Decimal {
  const amount = new Decimal(value);
  if (amount.isNegative()) throw new BadRequestException(`${field} cannot be negative`);
  return amount;
}

/** `validTo` before `validFrom` is a window that can never contain a day. */
function assertValidity(validFrom: string, validTo?: string | null): void {
  if (!/^\d{4}-\d{2}-\d{2}/.test(validFrom)) {
    throw new BadRequestException('validFrom must be an ISO-8601 date');
  }
  if (validTo !== undefined && validTo !== null) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(validTo)) {
      throw new BadRequestException('validTo must be an ISO-8601 date');
    }
    if (validTo < validFrom) {
      throw new BadRequestException('validTo cannot be earlier than validFrom');
    }
  }
}

/**
 * The plan's modules as provisioning line items, with the plan-level discount
 * allocated across them in proportion to each module's subtotal.
 *
 * Largest-remainder on the LAST row, so the allocated parts sum EXACTLY to the
 * plan's discount — in `Decimal`, where the admin implementation summed floats
 * and rounded each share to two places, so the parts could miss the total by a
 * cent and the subscription be provisioned at a price the plan never named.
 */
export function toProvisioningModuleItems(plan: CustomPlan): BillingProvisioningModuleItem[] {
  const modules = plan.modules ?? [];
  const subtotal = modules.reduce((sum, module) => sum.plus(module.subtotal), new Decimal(0));
  // The plan-level discount is the fixed amount PLUS what the percentage takes
  // off the subtotal: both come off the modules, so both are allocated.
  const discount = plan.monthlySubtotal.minus(plan.monthlyTotal);
  const toAllocate = discount.isNegative() ? new Decimal(0) : discount;

  let allocated = new Decimal(0);
  return modules.map((module, index) => {
    const isLast = index === modules.length - 1;
    const share = subtotal.isZero()
      ? new Decimal(0)
      : isLast
        ? toAllocate.minus(allocated)
        : roundToCurrency(toAllocate.times(module.subtotal).dividedBy(subtotal), plan.currency);
    allocated = allocated.plus(share);
    return {
      moduleId: module.moduleId,
      code: module.moduleCode,
      name: module.moduleName,
      quantities: { moduleId: module.moduleId, ...module.quantities },
      lineItems: (module.lineItems ?? []).map((line) => ({
        metric: line.metric,
        metricLabel: line.metricLabel,
        quantity: line.quantity,
        unitPrice: line.unitPrice.toString(),
        total: line.total.toString(),
      })),
      subtotal: module.subtotal.toString(),
      discountAmount: share.toString(),
      total: module.subtotal.minus(share).toString(),
    };
  });
}

/** The wire shape — the one place a row becomes a snapshot. */
export function toCustomPlanSnapshot(plan: CustomPlan): BillingCustomPlanSnapshot {
  return {
    id: plan.id,
    tenantId: plan.tenantId,
    name: plan.name,
    description: plan.description,
    basePlanId: plan.basePlanId,
    tier: plan.tier,
    billingCycle: plan.billingCycle,
    modules: (plan.modules ?? []).map((module) => ({
      moduleId: module.moduleId,
      moduleCode: module.moduleCode,
      moduleName: module.moduleName,
      quantities: module.quantities,
      lineItems: (module.lineItems ?? []).map((line) => ({
        metric: line.metric,
        metricLabel: line.metricLabel,
        quantity: line.quantity,
        unitPrice: line.unitPrice.toString(),
        total: line.total.toString(),
      })),
      subtotal: module.subtotal.toString(),
    })),
    monthlySubtotal: plan.monthlySubtotal.toString(),
    discountPercent: plan.discountPercent.toString(),
    discountAmount: plan.discountAmount.toString(),
    discountReason: plan.discountReason,
    monthlyTotal: plan.monthlyTotal.toString(),
    currency: plan.currency,
    status: plan.status,
    validFrom: plan.validFrom,
    validTo: plan.validTo,
    approvedBy: plan.approvedBy,
    approvedAt: plan.approvedAt ? plan.approvedAt.toISOString() : null,
    rejectionReason: plan.rejectionReason,
    notes: plan.notes,
    subscriptionId: plan.subscriptionId,
    unpricedModuleCodes: plan.unpricedModuleCodes ?? [],
    provisioningModuleItems: toProvisioningModuleItems(plan),
    createdAt: new Date(plan.createdAt).toISOString(),
    updatedAt: new Date(plan.updatedAt).toISOString(),
    createdBy: plan.createdBy,
    updatedBy: plan.updatedBy,
  };
}
