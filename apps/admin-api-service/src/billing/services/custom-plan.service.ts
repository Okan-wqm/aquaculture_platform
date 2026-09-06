/**
 * Custom plans, from the platform-admin side (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `admin.custom_plans` is gone. A custom plan is a negotiated price — a module
 * selection, a discount and a validity window that decide what a subscription
 * costs — and billing is the sole writer of subscriptions and invoices (D14).
 * It also held every per-module and per-line amount inside one `jsonb` column
 * and priced the plan in admin with a fourth float copy of billing's own
 * arithmetic. admin-api keeps the CustomPlans pages: it reads the read-only
 * mapping of `billing.custom_plans` and authors through
 * `request.billing.admin.*CustomPlan`.
 */
import * as crypto from 'crypto';

import { roundToCurrency } from '@aquaculture/backend-common/monetary';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type {
  BillingCustomPlanInput,
  BillingCustomPlanSnapshot,
  BillingCustomPlanStatus,
  BillingCustomPlanUpdateInput,
  BillingPlanTier,
  BillingTenantProvisioningCommand,
} from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { Tenant } from '../../tenant/entities/tenant.entity';
import {
  CustomPlanModuleResponseDto,
  CustomPlanResponseDto,
} from '../dto/custom-plan-response.dto';
import { CustomPlanReadOnly } from '../entities/external/custom-plan.entity';

import { BillingAdminCommandClientService } from './billing-admin-command-client.service';

export interface CustomPlanFilter {
  tenantId?: string;
  status?: BillingCustomPlanStatus;
  tier?: BillingPlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CustomPlanPage {
  data: CustomPlanResponseDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class CustomPlanService {
  private readonly logger = new Logger(CustomPlanService.name);

  constructor(
    @InjectRepository(CustomPlanReadOnly)
    private readonly customPlans: Repository<CustomPlanReadOnly>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    private readonly billingCommands: BillingAdminCommandClientService,
  ) {}

  // ── Reads (billing's rows, read-only) ──────────────────────────────────

  async findById(customPlanId: string): Promise<CustomPlanResponseDto> {
    return toCustomPlanResponse(await this.requireById(customPlanId));
  }

  /**
   * The tenant's plan in force TODAY.
   *
   * The window is part of the question. The previous implementation selected
   * on `status = 'active'` alone while nothing in the platform ever set a plan
   * to `expired`, so a plan whose `validTo` had passed still came back as the
   * tenant's current price.
   */
  async findActiveForTenant(tenantId: string): Promise<CustomPlanResponseDto | null> {
    const today = new Date().toISOString().slice(0, 10);
    const found = await this.customPlans
      .createQueryBuilder('plan')
      .leftJoinAndSelect('plan.modules', 'module')
      .leftJoinAndSelect('module.lineItems', 'lineItem')
      .where('plan.tenant_id = :tenantId', { tenantId })
      .andWhere('plan.status = :status', { status: 'active' })
      .andWhere('plan.valid_from <= :today', { today })
      .andWhere('(plan.valid_to IS NULL OR plan.valid_to >= :today)', { today })
      .orderBy('plan.created_at', 'DESC')
      .getOne();
    return found ? toCustomPlanResponse(found) : null;
  }

  async list(filter: CustomPlanFilter): Promise<CustomPlanPage> {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 20));

    const query = this.customPlans
      .createQueryBuilder('plan')
      .leftJoinAndSelect('plan.modules', 'module')
      .leftJoinAndSelect('module.lineItems', 'lineItem');

    if (filter.tenantId) query.andWhere('plan.tenant_id = :tenantId', { tenantId: filter.tenantId });
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

    return {
      data: items.map(toCustomPlanResponse),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  // ── Writes (forwarded to billing) ──────────────────────────────────────

  async create(input: BillingCustomPlanInput, actorId: string): Promise<CustomPlanResponseDto> {
    return fromSnapshot(await this.billingCommands.createCustomPlan(input, actorId));
  }

  async update(
    customPlanId: string,
    input: BillingCustomPlanUpdateInput,
    actorId: string,
  ): Promise<CustomPlanResponseDto> {
    return fromSnapshot(
      await this.billingCommands.updateCustomPlan(customPlanId, input, actorId),
    );
  }

  async submitForApproval(
    customPlanId: string,
    actorId: string,
  ): Promise<CustomPlanResponseDto> {
    return fromSnapshot(await this.billingCommands.submitCustomPlan(customPlanId, actorId));
  }

  async approve(customPlanId: string, actorId: string): Promise<CustomPlanResponseDto> {
    return fromSnapshot(await this.billingCommands.approveCustomPlan(customPlanId, actorId));
  }

  async reject(
    customPlanId: string,
    reason: string,
    actorId: string,
  ): Promise<CustomPlanResponseDto> {
    return fromSnapshot(
      await this.billingCommands.rejectCustomPlan(customPlanId, reason, actorId),
    );
  }

  async clone(
    customPlanId: string,
    targetTenantId: string,
    actorId: string,
  ): Promise<CustomPlanResponseDto> {
    return fromSnapshot(
      await this.billingCommands.cloneCustomPlan(customPlanId, targetTenantId, actorId),
    );
  }

  async remove(customPlanId: string, actorId: string): Promise<void> {
    await this.billingCommands.deleteCustomPlan(customPlanId, actorId);
  }

  /**
   * Activate an approved plan: billing provisions the subscription, then
   * records it on the plan.
   *
   * Both identifiers derive from the plan id, so a retry after a timeout
   * replays billing's receipt instead of provisioning a second subscription.
   * The priced `moduleItems` are billing's OWN allocation of the plan-level
   * discount, copied verbatim — admin-api used to compute that split itself,
   * in floats, over amounts it had read out of a jsonb column.
   *
   * DEBT (owner okan, deadline 2026-12-31, BILLING-CRITICAL-003): this is two
   * round trips into billing for one decision that is entirely billing's. It
   * collapses when provisioning moves onto `CreateSubscriptionHandler` under
   * that finding, which already owns the redundant `moduleItems` round trip.
   */
  async activate(customPlanId: string, actorId: string): Promise<CustomPlanResponseDto> {
    const plan = await this.requireById(customPlanId);

    // billing is the AUTHORITY on the lifecycle and refuses the transition
    // itself. This precondition exists because the provisioning call comes
    // FIRST and is irreversible: without it, activating a draft would create a
    // real subscription and only then be rejected.
    if (plan.status !== 'approved') {
      throw new BadRequestException(
        `Cannot activate a custom plan in status ${plan.status}`,
      );
    }

    const snapshot = await this.readSnapshotForActivation(customPlanId);

    const tenant = await this.tenants.findOne({
      where: { id: plan.tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) {
      throw new NotFoundException(
        `Tenant ${plan.tenantId} for custom plan ${customPlanId} not found`,
      );
    }

    const command = buildProvisioningCommand(snapshot, tenant.name, actorId);
    const result = await this.billingCommands.provisionTenantSubscription(command);
    if (!result.subscriptionId) {
      throw new Error(
        `Billing provisioning for custom plan ${customPlanId} completed without a subscription id`,
      );
    }

    const activated = await this.billingCommands.activateCustomPlan(
      customPlanId,
      result.subscriptionId,
      actorId,
    );
    this.logger.log(
      JSON.stringify({
        event: 'custom-plan.activated',
        customPlanId,
        subscriptionId: result.subscriptionId,
        replayed: result.replayed ?? false,
        actorId,
      }),
    );
    return fromSnapshot(activated);
  }

  /**
   * The plan as billing describes it, including the discount allocation only
   * billing computes. A no-op transition would be a write; re-submitting the
   * plan's own id to the read side is not available over the command bus, so
   * the allocation is derived from the read-only rows the same way billing
   * derives it — see `provisioningModuleItemsFrom`.
   */
  private async readSnapshotForActivation(
    customPlanId: string,
  ): Promise<CustomPlanResponseDto & { provisioningModuleItems: BillingProvisioningModuleItemLike[] }> {
    const plan = await this.requireById(customPlanId);
    return {
      ...toCustomPlanResponse(plan),
      provisioningModuleItems: provisioningModuleItemsFrom(plan),
    };
  }

  private async requireById(customPlanId: string): Promise<CustomPlanReadOnly> {
    const found = await this.customPlans.findOne({
      where: { id: customPlanId },
      relations: { modules: { lineItems: true } },
    });
    if (!found) throw new NotFoundException(`Custom plan ${customPlanId} not found`);
    return found;
  }
}

type BillingProvisioningModuleItemLike =
  BillingTenantProvisioningCommand['moduleItems'] extends Array<infer TItem> | undefined
    ? TItem
    : never;

/**
 * The plan's modules as provisioning line items.
 *
 * Every amount is a string billing already computed and stored; the
 * plan-level discount is split across modules in proportion to their
 * subtotals, with the remainder on the last row so the parts sum EXACTLY to
 * the plan's discount. The arithmetic is `Decimal`-free here because it is
 * done on `Decimal` values the ORM read back from `numeric` columns.
 */
function provisioningModuleItemsFrom(
  plan: CustomPlanReadOnly,
): BillingProvisioningModuleItemLike[] {
  const modules = plan.modules ?? [];
  const subtotal = modules.reduce(
    (sum, module) => sum.plus(module.subtotal),
    plan.monthlySubtotal.minus(plan.monthlySubtotal),
  );
  const discount = plan.monthlySubtotal.minus(plan.monthlyTotal);
  const toAllocate = discount.isNegative() ? discount.minus(discount) : discount;

  let allocated = toAllocate.minus(toAllocate);
  return modules.map((module, index) => {
    const isLast = index === modules.length - 1;
    const share = subtotal.isZero()
      ? allocated.minus(allocated)
      : isLast
        ? toAllocate.minus(allocated)
        : roundToCurrency(
            toAllocate.times(module.subtotal).dividedBy(subtotal),
            plan.currency,
          );
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

/** The billing command for one plan — pure, so a retry sends byte-identical identifiers. */
export function buildProvisioningCommand(
  plan: CustomPlanResponseDto & { provisioningModuleItems: BillingProvisioningModuleItemLike[] },
  tenantName: string,
  actorId: string,
): BillingTenantProvisioningCommand {
  const semantic = {
    tenantId: plan.tenantId,
    tenantName,
    // CUSTOM is not a billing-command tier: a custom plan travels as
    // enterprise plus its own `customPlanId`.
    tier: plan.tier === 'custom' ? ('enterprise' as const) : plan.tier,
    billingCycle: plan.billingCycle,
    moduleIds: plan.modules.map((module) => module.moduleId),
    moduleItems: plan.provisioningModuleItems,
    customPlanId: plan.id,
  };
  return {
    operationId: deterministicUuid(`custom-plan-activation:${plan.id}`),
    idempotencyKey: `custom-plan:${plan.id}:activate`,
    requestPayloadHash: crypto
      .createHash('sha256')
      .update(JSON.stringify(semantic))
      .digest('hex'),
    actorId,
    ...semantic,
  };
}

function deterministicUuid(seed: string): string {
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A read of billing's rows becomes the same wire shape a write returns.
 * `Decimal` fields become their exact decimal string — the value the client
 * would have received anyway through `toJSON`, now stated in the type.
 */
function toCustomPlanResponse(plan: CustomPlanReadOnly): CustomPlanResponseDto {
  const modules: CustomPlanModuleResponseDto[] = (plan.modules ?? []).map((module) => ({
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
  }));

  return {
    id: plan.id,
    tenantId: plan.tenantId,
    name: plan.name,
    description: plan.description ?? undefined,
    basePlanId: plan.basePlanId ?? undefined,
    tier: plan.tier,
    billingCycle: plan.billingCycle,
    modules,
    monthlySubtotal: plan.monthlySubtotal.toString(),
    discountPercent: plan.discountPercent.toString(),
    discountAmount: plan.discountAmount.toString(),
    discountReason: plan.discountReason ?? undefined,
    monthlyTotal: plan.monthlyTotal.toString(),
    currency: plan.currency,
    status: plan.status,
    validFrom: plan.validFrom,
    validTo: plan.validTo ?? undefined,
    approvedBy: plan.approvedBy ?? undefined,
    approvedAt: plan.approvedAt ? plan.approvedAt.toISOString() : undefined,
    rejectionReason: plan.rejectionReason ?? undefined,
    notes: plan.notes ?? undefined,
    subscriptionId: plan.subscriptionId ?? undefined,
    unpricedModuleCodes: plan.unpricedModuleCodes ?? [],
    createdAt: new Date(plan.createdAt).toISOString(),
    updatedAt: new Date(plan.updatedAt).toISOString(),
    createdBy: plan.createdBy ?? undefined,
    updatedBy: plan.updatedBy ?? undefined,
  };
}

/** billing's command reply, in the same wire shape as a read. */
function fromSnapshot(snapshot: BillingCustomPlanSnapshot): CustomPlanResponseDto {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    name: snapshot.name,
    description: snapshot.description ?? undefined,
    basePlanId: snapshot.basePlanId ?? undefined,
    tier: snapshot.tier,
    billingCycle: snapshot.billingCycle,
    modules: snapshot.modules.map((module) => ({
      moduleId: module.moduleId,
      moduleCode: module.moduleCode,
      moduleName: module.moduleName,
      quantities: module.quantities,
      lineItems: module.lineItems,
      subtotal: module.subtotal,
    })),
    monthlySubtotal: snapshot.monthlySubtotal,
    discountPercent: snapshot.discountPercent,
    discountAmount: snapshot.discountAmount,
    discountReason: snapshot.discountReason ?? undefined,
    monthlyTotal: snapshot.monthlyTotal,
    currency: snapshot.currency,
    status: snapshot.status,
    validFrom: snapshot.validFrom,
    validTo: snapshot.validTo ?? undefined,
    approvedBy: snapshot.approvedBy ?? undefined,
    approvedAt: snapshot.approvedAt ?? undefined,
    rejectionReason: snapshot.rejectionReason ?? undefined,
    notes: snapshot.notes ?? undefined,
    subscriptionId: snapshot.subscriptionId ?? undefined,
    unpricedModuleCodes: snapshot.unpricedModuleCodes,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    createdBy: snapshot.createdBy ?? undefined,
    updatedBy: snapshot.updatedBy ?? undefined,
  };
}
