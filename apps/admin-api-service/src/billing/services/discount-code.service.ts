/**
 * Discount codes, from the platform-admin side (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * admin-api owns the operator experience; billing owns the rows. Every read
 * here is a query against the read-only mapping of `billing.discount_codes` /
 * `billing.discount_redemptions`, and every write is a
 * `request.billing.admin.*Discount*` command answered by billing.
 *
 * There is no local repository to write through and no second copy of the
 * eligibility rules: a refusal (`valid: false` with a reason) is billing's
 * answer, rendered here, so the message an operator reads and the money
 * actually taken off can no longer disagree.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type {
  BillingAdminApplyDiscountCodeResult,
  BillingAdminUpdateDiscountCodeInput,
  BillingAdminValidateDiscountCodeResult,
  BillingDiscountCodeInput,
  BillingDiscountCodeSnapshot,
  BillingDiscountSubscriptionChange,
} from '@platform/event-contracts';
import { LessThanOrEqual, Repository } from 'typeorm';

import {
  DiscountApplicationResponseDto,
  DiscountCodePageDto,
  DiscountCodeResponseDto,
  DiscountRedemptionPageDto,
  DiscountRedemptionResponseDto,
  DiscountStatsDto,
  DiscountValidationResponseDto,
} from '../dto/discount-response.dto';
import {
  DiscountCodeReadOnly,
  DiscountRedemptionReadOnly,
} from '../entities/external/discount-code.entity';

import { BillingAdminCommandClientService } from './billing-admin-command-client.service';

@Injectable()
export class DiscountCodeService {
  private readonly logger = new Logger(DiscountCodeService.name);

  constructor(
    @InjectRepository(DiscountCodeReadOnly)
    private readonly discountCodes: Repository<DiscountCodeReadOnly>,
    @InjectRepository(DiscountRedemptionReadOnly)
    private readonly redemptions: Repository<DiscountRedemptionReadOnly>,
    private readonly billingCommands: BillingAdminCommandClientService,
  ) {}

  // ── Reads (billing's rows, read-only) ──────────────────────────────────

  async findAll(options?: {
    isActive?: boolean;
    campaignId?: string;
    includeExpired?: boolean;
    page?: number;
    limit?: number;
  }): Promise<DiscountCodePageDto> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 50;
    const query = this.discountCodes.createQueryBuilder('dc');

    if (options?.isActive !== undefined) {
      query.andWhere('dc.isActive = :isActive', { isActive: options.isActive });
    }
    if (options?.campaignId) {
      query.andWhere('dc.campaignId = :campaignId', { campaignId: options.campaignId });
    }
    if (!options?.includeExpired) {
      query.andWhere('(dc.validUntil IS NULL OR dc.validUntil > :now)', { now: new Date() });
    }

    const [data, total] = await query
      .orderBy('dc.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data: data.map(toCodeResponse), total, page, limit };
  }

  async findById(id: string): Promise<DiscountCodeResponseDto> {
    const found = await this.discountCodes.findOne({ where: { id } });
    if (!found) throw new NotFoundException(`Discount code with ID ${id} not found`);
    return toCodeResponse(found);
  }

  async findByCode(code: string): Promise<DiscountCodeResponseDto | null> {
    const found = await this.discountCodes.findOne({ where: { code: code.toUpperCase() } });
    return found ? toCodeResponse(found) : null;
  }

  async getRedemptions(
    discountCodeId: string,
    options?: { page?: number; limit?: number },
  ): Promise<DiscountRedemptionPageDto> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 50;
    const [data, total] = await this.redemptions.findAndCount({
      where: { discountCodeId },
      order: { redeemedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: data.map(toRedemptionResponse), total, page, limit };
  }

  async getTenantRedemptions(
    tenantId: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<DiscountRedemptionPageDto> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const [data, total] = await this.redemptions.findAndCount({
      where: { tenantId },
      order: { redeemedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data: data.map(toRedemptionResponse), total, page, limit };
  }

  async getStats(): Promise<DiscountStatsDto> {
    const now = new Date();
    const [totalCodes, activeCodes, expiredCodes] = await Promise.all([
      this.discountCodes.count(),
      this.discountCodes.count({ where: { isActive: true } }),
      this.discountCodes.count({ where: { validUntil: LessThanOrEqual(now) } }),
    ]);

    // COUNT and SUM come back as strings from `numeric`/`bigint`; the sum stays
    // a string all the way to the client so a total of money is never widened
    // through a double.
    const totals = await this.redemptions
      .createQueryBuilder('r')
      .select('COUNT(*)::text', 'totalRedemptions')
      .addSelect('COALESCE(SUM(r.discount_amount), 0)::text', 'totalDiscountAmount')
      .getRawOne<{ totalRedemptions: string; totalDiscountAmount: string }>();

    const topCodes = await this.redemptions
      .createQueryBuilder('r')
      .innerJoin(DiscountCodeReadOnly, 'dc', 'dc.id = r.discount_code_id')
      .select('dc.code', 'code')
      .addSelect('COUNT(*)::text', 'redemptions')
      .addSelect('COALESCE(SUM(r.discount_amount), 0)::text', 'totalDiscount')
      .groupBy('dc.code')
      .orderBy('COUNT(*)', 'DESC')
      .limit(10)
      .getRawMany<{ code: string; redemptions: string; totalDiscount: string }>();

    return {
      totalCodes,
      activeCodes,
      expiredCodes,
      totalRedemptions: Number.parseInt(totals?.totalRedemptions ?? '0', 10),
      totalDiscountAmount: totals?.totalDiscountAmount ?? '0',
      topCodes: topCodes.map((row) => ({
        code: row.code,
        redemptions: Number.parseInt(row.redemptions, 10),
        totalDiscount: row.totalDiscount,
      })),
    };
  }

  // ── Writes (forwarded to billing) ──────────────────────────────────────

  async create(
    code: string,
    input: BillingDiscountCodeInput,
    actorId: string,
  ): Promise<DiscountCodeResponseDto> {
    return fromSnapshot(await this.billingCommands.createDiscountCode(code, input, actorId));
  }

  async update(
    discountCodeId: string,
    input: BillingAdminUpdateDiscountCodeInput,
    actorId: string,
  ): Promise<DiscountCodeResponseDto> {
    return fromSnapshot(
      await this.billingCommands.updateDiscountCode(discountCodeId, input, actorId),
    );
  }

  async deactivate(
    discountCodeId: string,
    actorId: string,
  ): Promise<DiscountCodeResponseDto> {
    return fromSnapshot(await this.billingCommands.deactivateDiscountCode(discountCodeId, actorId));
  }

  async generateUniqueCode(actorId: string, prefix?: string, length?: number): Promise<string> {
    return this.billingCommands.generateDiscountCode(actorId, prefix, length);
  }

  async bulkCreate(
    count: number,
    template: BillingDiscountCodeInput,
    actorId: string,
    codePrefix?: string,
  ): Promise<DiscountCodeResponseDto[]> {
    const created = await this.billingCommands.bulkCreateDiscountCodes(
      count,
      template,
      actorId,
      codePrefix,
    );
    return created.map(fromSnapshot);
  }

  async validateCode(
    code: string,
    tenantId: string,
    actorId: string,
    context: {
      planId?: string;
      subscriptionChange?: BillingDiscountSubscriptionChange;
      orderAmount?: string;
    } = {},
  ): Promise<DiscountValidationResponseDto> {
    const result = await this.billingCommands.validateDiscountCode(
      code,
      tenantId,
      actorId,
      context,
    );
    return {
      valid: result.valid,
      reason: result.reason,
      message: result.message,
      discountAmount: result.discountAmount,
      discountCode: result.discountCode ? fromSnapshot(result.discountCode) : undefined,
    };
  }

  async applyDiscount(
    code: string,
    tenantId: string,
    orderAmount: string,
    actorId: string,
    context: {
      planId?: string;
      subscriptionChange?: BillingDiscountSubscriptionChange;
      subscriptionId?: string;
      invoiceId?: string;
    } = {},
  ): Promise<DiscountApplicationResponseDto> {
    const result = await this.billingCommands.applyDiscountCode(
      code,
      tenantId,
      orderAmount,
      actorId,
      context,
    );
    this.logger.log(
      JSON.stringify({
        event: 'discount.apply.forwarded',
        tenantId,
        valid: result.valid ?? false,
        reason: result.reason ?? null,
      }),
    );
    return {
      valid: result.valid ?? false,
      reason: result.reason,
      originalAmount: result.originalAmount ?? orderAmount,
      discountAmount: result.discountAmount ?? '0',
      finalAmount: result.finalAmount ?? orderAmount,
      grantedFreeMonths: result.grantedFreeMonths,
      grantedTrialExtensionDays: result.grantedTrialExtensionDays,
      redemptionId: result.redemptionId,
      message: result.message,
    };
  }
}

/**
 * A read of billing's table becomes the same wire shape a write returns.
 * `Decimal` fields become their exact decimal string — the value the client
 * would have received anyway through `toJSON`, now stated in the type.
 */
function toCodeResponse(row: DiscountCodeReadOnly): DiscountCodeResponseDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? undefined,
    discountType: row.discountType,
    percentOff: row.percentOff?.toString(),
    amountOff: row.amountOff?.toString(),
    freeMonths: row.freeMonths ?? undefined,
    trialExtensionDays: row.trialExtensionDays ?? undefined,
    currency: row.currency,
    appliesTo: row.appliesTo,
    applicablePlanIds: row.applicablePlanIds ?? undefined,
    duration: row.duration,
    durationInMonths: row.durationInMonths ?? undefined,
    isActive: row.isActive,
    validFrom: row.validFrom ? new Date(row.validFrom).toISOString() : undefined,
    validUntil: row.validUntil ? new Date(row.validUntil).toISOString() : undefined,
    maxRedemptions: row.maxRedemptions ?? undefined,
    currentRedemptions: row.currentRedemptions,
    maxRedemptionsPerTenant: row.maxRedemptionsPerTenant ?? undefined,
    minimumOrderAmount: row.minimumOrderAmount?.toString(),
    campaignId: row.campaignId ?? undefined,
    campaignName: row.campaignName ?? undefined,
    stripePromotionCodeId: row.stripePromotionCodeId ?? undefined,
    stripeCouponId: row.stripeCouponId ?? undefined,
    isReferralCode: row.isReferralCode,
    referrerId: row.referrerId ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    createdBy: row.createdBy ?? undefined,
    updatedBy: row.updatedBy ?? undefined,
  };
}

/** billing's command reply, in the same wire shape as a read. */
function fromSnapshot(snapshot: BillingDiscountCodeSnapshot): DiscountCodeResponseDto {
  const branch =
    snapshot.discountType === 'percentage'
      ? { percentOff: snapshot.percentOff }
      : snapshot.discountType === 'fixed_amount'
        ? { amountOff: snapshot.amountOff }
        : snapshot.discountType === 'free_months'
          ? { freeMonths: snapshot.freeMonths }
          : { trialExtensionDays: snapshot.trialExtensionDays };

  return {
    id: snapshot.id,
    code: snapshot.code,
    name: snapshot.name,
    description: snapshot.description,
    discountType: snapshot.discountType,
    ...branch,
    currency: snapshot.currency,
    appliesTo: snapshot.appliesTo ?? 'all_plans',
    applicablePlanIds: snapshot.applicablePlanIds,
    duration: snapshot.duration ?? 'once',
    durationInMonths: snapshot.durationInMonths,
    isActive: snapshot.isActive,
    validFrom: snapshot.validFrom,
    validUntil: snapshot.validUntil,
    maxRedemptions: snapshot.maxRedemptions,
    currentRedemptions: snapshot.currentRedemptions,
    maxRedemptionsPerTenant: snapshot.maxRedemptionsPerTenant,
    minimumOrderAmount: snapshot.minimumOrderAmount,
    campaignId: snapshot.campaignId,
    campaignName: snapshot.campaignName,
    stripePromotionCodeId: snapshot.stripePromotionCodeId ?? undefined,
    stripeCouponId: snapshot.stripeCouponId ?? undefined,
    isReferralCode: snapshot.isReferralCode ?? false,
    referrerId: snapshot.referrerId,
    metadata: snapshot.metadata,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    createdBy: snapshot.createdBy ?? undefined,
    updatedBy: snapshot.updatedBy ?? undefined,
  };
}

function toRedemptionResponse(row: DiscountRedemptionReadOnly): DiscountRedemptionResponseDto {
  return {
    id: row.id,
    discountCodeId: row.discountCodeId,
    tenantId: row.tenantId,
    subscriptionId: row.subscriptionId ?? undefined,
    invoiceId: row.invoiceId ?? undefined,
    discountAmount: row.discountAmount.toString(),
    currency: row.currency,
    redeemedAt: new Date(row.redeemedAt).toISOString(),
    redeemedBy: row.redeemedBy ?? undefined,
  };
}
