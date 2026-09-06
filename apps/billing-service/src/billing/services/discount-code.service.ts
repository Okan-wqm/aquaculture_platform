/**
 * Discount catalogue writer — billing is the only one (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * Everything that mints, edits, retires or redeems a discount code happens
 * here. admin-api reaches it over `request.billing.admin.*Discount*`; nothing
 * else writes these two tables.
 */
import { randomInt } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type {
  BillingDiscountCodeInput,
  BillingDiscountCodeSnapshot,
  BillingDiscountRedemptionSnapshot,
  BillingDiscountRejectionReason,
  BillingDiscountSubscriptionChange,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, Repository } from 'typeorm';

import {
  DiscountAppliesTo,
  DiscountCode,
  DiscountDuration,
  DiscountRedemption,
  DiscountType,
} from '../entities/discount-code.entity';

import {
  evaluateDiscount,
  grantOf,
  reject,
  roundToCurrency,
  type DiscountEvaluation,
  type DiscountGrant,
} from './discount-rules';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_GENERATION_ATTEMPTS = 10;
/** Same shape the DB CHECK enforces: upper-case A–Z0–9 and `_`, 3–64 chars. */
const CODE_PATTERN = /^[A-Z0-9_]{3,64}$/;

export interface DiscountValidation {
  valid: boolean;
  reason?: BillingDiscountRejectionReason;
  message: string;
  discountCode?: DiscountCode;
  /** Present only when an order amount was supplied AND the branch moves money. */
  discountAmount?: Decimal;
}

export interface DiscountApplication {
  originalAmount: Decimal;
  discountAmount: Decimal;
  finalAmount: Decimal;
  grantedFreeMonths?: number;
  grantedTrialExtensionDays?: number;
  redemptionId: string;
  discountCode: DiscountCode;
  message: string;
}

export interface DiscountRedemptionContext {
  readonly planId?: string;
  readonly subscriptionChange?: BillingDiscountSubscriptionChange;
  readonly subscriptionId?: string;
  readonly invoiceId?: string;
  readonly redeemedBy?: string;
}

/** Refusal by a business rule, as opposed to a malformed request. */
export class DiscountRejectedError extends Error {
  constructor(
    readonly reason: BillingDiscountRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'DiscountRejectedError';
  }
}

@Injectable()
export class DiscountCodeService {
  private readonly logger = new Logger(DiscountCodeService.name);

  constructor(
    @InjectRepository(DiscountCode)
    private readonly codes: Repository<DiscountCode>,
    @InjectRepository(DiscountRedemption)
    private readonly redemptions: Repository<DiscountRedemption>,
    // Only `apply` needs the DataSource: the redemption claim runs in one
    // transaction so the code row can be held FOR UPDATE across the rules.
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // ── Authoring ──────────────────────────────────────────────────────────

  async create(
    code: string,
    input: BillingDiscountCodeInput,
    actorId: string,
  ): Promise<DiscountCode> {
    const normalized = normalizeCode(code);

    if (await this.codes.findOne({ where: { code: normalized } })) {
      throw new ConflictException(`Discount code ${normalized} already exists`);
    }

    const entity = this.codes.create(this.toColumns(normalized, input, actorId));
    const saved = await this.codes.save(entity);
    this.logger.log(JSON.stringify({ event: 'discount-code.created', code: saved.code, actorId }));
    return saved;
  }

  async update(
    discountCodeId: string,
    input: {
      name?: string;
      description?: string;
      isActive?: boolean;
      validFrom?: string;
      validUntil?: string;
      maxRedemptions?: number;
      maxRedemptionsPerTenant?: number;
      metadata?: Record<string, unknown>;
    },
    actorId: string,
  ): Promise<DiscountCode> {
    const existing = await this.requireById(discountCodeId);

    if (input.name !== undefined) existing.name = input.name;
    if (input.description !== undefined) existing.description = input.description;
    if (input.isActive !== undefined) existing.isActive = input.isActive;
    if (input.validFrom !== undefined) existing.validFrom = new Date(input.validFrom);
    if (input.validUntil !== undefined) existing.validUntil = new Date(input.validUntil);
    if (input.maxRedemptions !== undefined) existing.maxRedemptions = input.maxRedemptions;
    if (input.maxRedemptionsPerTenant !== undefined) {
      existing.maxRedemptionsPerTenant = input.maxRedemptionsPerTenant;
    }
    if (input.metadata !== undefined) existing.metadata = input.metadata;
    existing.updatedBy = actorId;

    assertValidityWindow(existing.validFrom ?? null, existing.validUntil ?? null);
    // A cap cannot be lowered below what has already been handed out: the DB
    // CHECK would refuse the row anyway, and this says why.
    if (
      existing.maxRedemptions !== null &&
      existing.maxRedemptions !== undefined &&
      existing.currentRedemptions > existing.maxRedemptions
    ) {
      throw new BadRequestException(
        `maxRedemptions (${existing.maxRedemptions}) is below the ${existing.currentRedemptions} redemptions already recorded`,
      );
    }

    const saved = await this.codes.save(existing);
    this.logger.log(JSON.stringify({ event: 'discount-code.updated', code: saved.code, actorId }));
    return saved;
  }

  async deactivate(discountCodeId: string, actorId: string): Promise<DiscountCode> {
    const existing = await this.requireById(discountCodeId);
    existing.isActive = false;
    existing.updatedBy = actorId;
    const saved = await this.codes.save(existing);
    this.logger.log(
      JSON.stringify({ event: 'discount-code.deactivated', code: saved.code, actorId }),
    );
    return saved;
  }

  /**
   * A discount code is a bearer instrument: a guessable one is free money, so
   * the alphabet is drawn from the OS CSPRNG (`crypto.randomInt`), never
   * `Math.random`.
   */
  async generateUniqueCode(prefix?: string, length = 8): Promise<string> {
    if (length < 4 || length > 32) {
      throw new BadRequestException('Generated code length must be between 4 and 32');
    }
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      let candidate = prefix ? `${normalizeCode(prefix)}_` : '';
      for (let i = 0; i < length; i += 1) {
        candidate += CODE_ALPHABET.charAt(randomInt(0, CODE_ALPHABET.length));
      }
      if (!(await this.codes.findOne({ where: { code: candidate } }))) return candidate;
    }
    throw new ConflictException(
      `Could not generate an unused discount code in ${MAX_GENERATION_ATTEMPTS} attempts`,
    );
  }

  async bulkCreate(
    count: number,
    template: BillingDiscountCodeInput,
    actorId: string,
    codePrefix?: string,
  ): Promise<DiscountCode[]> {
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      throw new BadRequestException('Bulk discount creation accepts between 1 and 500 codes');
    }
    const created: DiscountCode[] = [];
    for (let i = 0; i < count; i += 1) {
      const code = await this.generateUniqueCode(codePrefix);
      created.push(await this.create(code, template, actorId));
    }
    this.logger.log(
      JSON.stringify({
        event: 'discount-code.bulk-created',
        count: created.length,
        campaignId: template.campaignId ?? null,
        actorId,
      }),
    );
    return created;
  }

  // ── Redemption ─────────────────────────────────────────────────────────

  async validate(
    code: string,
    tenantId: string,
    context: {
      planId?: string;
      subscriptionChange?: BillingDiscountSubscriptionChange;
      orderAmount?: Decimal;
    } = {},
  ): Promise<DiscountValidation> {
    const found = await this.codes.findOne({ where: { code: normalizeCode(code) } });
    if (!found) {
      const refusal = reject('unknown_code');
      return {
        valid: false,
        reason: refusal.valid ? undefined : refusal.reason,
        message: refusal.message,
      };
    }

    const tenantRedemptions = await this.redemptions.count({
      where: { discountCodeId: found.id, tenantId },
    });

    const evaluation = evaluateDiscount(found, {
      now: new Date(),
      planId: context.planId,
      subscriptionChange: context.subscriptionChange,
      orderAmount: context.orderAmount,
      tenantRedemptions,
    });

    return toValidation(found, evaluation, context.orderAmount);
  }

  /**
   * Redeem the code for one tenant, atomically.
   *
   * The row is taken FOR UPDATE before any rule is asked, so every concurrent
   * redeemer of the same code serialises here. That is what makes the caps
   * real: the previous implementation validated, then inserted, then did a
   * read-modify-write of `currentRedemptions`, so two requests racing on the
   * last remaining use both passed validation and both redeemed, and a lost
   * update could leave the counter behind the number of redemption rows.
   */
  async apply(
    code: string,
    tenantId: string,
    orderAmount: Decimal,
    context: DiscountRedemptionContext = {},
  ): Promise<DiscountApplication> {
    // The entity-first EntityManager overloads keep every statement on THIS
    // transaction's connection without materialising a repository: the row
    // stays locked from the claim to the commit.
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const claimed = await manager.findOne(DiscountCode, {
        where: { code: normalizeCode(code) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!claimed) throw new DiscountRejectedError('unknown_code', 'Invalid discount code');

      const tenantRedemptions = await manager.count(DiscountRedemption, {
        where: { discountCodeId: claimed.id, tenantId },
      });

      const evaluation = evaluateDiscount(claimed, {
        now: new Date(),
        planId: context.planId,
        subscriptionChange: context.subscriptionChange,
        orderAmount,
        tenantRedemptions,
      });
      if (!evaluation.valid) {
        throw new DiscountRejectedError(evaluation.reason, evaluation.message);
      }

      const grant = evaluation.grant;
      const discountAmount = grant.kind === 'amount' ? grant.amountOff : new Decimal(0);
      const finalAmount = Decimal.max(new Decimal(0), orderAmount.minus(discountAmount));

      const redemption = await manager.save(
        manager.create(DiscountRedemption, {
          discountCodeId: claimed.id,
          tenantId,
          subscriptionId: context.subscriptionId ?? null,
          invoiceId: context.invoiceId ?? null,
          discountAmount,
          currency: claimed.currency,
          redeemedAt: new Date(),
          redeemedBy: context.redeemedBy ?? null,
        }),
      );

      claimed.currentRedemptions += 1;
      await manager.save(claimed);

      this.logger.log(
        JSON.stringify({
          event: 'discount-code.redeemed',
          code: claimed.code,
          tenantId,
          discountAmount: discountAmount.toString(),
          currency: claimed.currency,
        }),
      );

      return {
        originalAmount: orderAmount,
        discountAmount,
        finalAmount,
        grantedFreeMonths: grant.kind === 'free-months' ? grant.months : undefined,
        grantedTrialExtensionDays: grant.kind === 'trial-extension' ? grant.days : undefined,
        redemptionId: redemption.id,
        discountCode: claimed,
        message: describeGrant(grant, claimed.currency),
      };
    });
  }

  // ── Reads used by the command surface ──────────────────────────────────

  async requireById(discountCodeId: string): Promise<DiscountCode> {
    const found = await this.codes.findOne({ where: { id: discountCodeId } });
    if (!found) throw new NotFoundException(`Discount code ${discountCodeId} not found`);
    return found;
  }

  // ── Mapping ────────────────────────────────────────────────────────────

  private toColumns(
    code: string,
    input: BillingDiscountCodeInput,
    actorId: string,
  ): Partial<DiscountCode> {
    const currency = (input.currency ?? 'USD').toUpperCase();
    const validFrom = input.validFrom ? new Date(input.validFrom) : null;
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    assertValidityWindow(validFrom, validUntil);

    const columns: Partial<DiscountCode> = {
      code,
      name: input.name,
      description: input.description ?? null,
      currency,
      discountType: input.discountType as DiscountType,
      percentOff: null,
      amountOff: null,
      freeMonths: null,
      trialExtensionDays: null,
      appliesTo: (input.appliesTo ?? DiscountAppliesTo.ALL_PLANS) as DiscountAppliesTo,
      applicablePlanIds: input.applicablePlanIds ?? null,
      duration: (input.duration ?? DiscountDuration.ONCE) as DiscountDuration,
      durationInMonths: input.durationInMonths ?? null,
      isActive: true,
      validFrom,
      validUntil,
      maxRedemptions: input.maxRedemptions ?? null,
      currentRedemptions: 0,
      maxRedemptionsPerTenant: input.maxRedemptionsPerTenant ?? null,
      minimumOrderAmount:
        input.minimumOrderAmount === undefined ? null : new Decimal(input.minimumOrderAmount),
      campaignId: input.campaignId ?? null,
      campaignName: input.campaignName ?? null,
      metadata: input.metadata ?? null,
      isReferralCode: input.isReferralCode ?? false,
      referrerId: input.referrerId ?? null,
      createdBy: actorId,
      updatedBy: actorId,
    };

    // The value branch is exhaustive over `discountType`, so a new kind is a
    // compile error here rather than a row with every value column NULL.
    switch (input.discountType) {
      case 'percentage': {
        const percent = new Decimal(input.percentOff);
        if (percent.lessThanOrEqualTo(0) || percent.greaterThan(100)) {
          throw new BadRequestException('percentOff must be greater than 0 and at most 100');
        }
        columns.percentOff = percent;
        break;
      }
      case 'fixed_amount': {
        const amount = new Decimal(input.amountOff);
        if (amount.lessThanOrEqualTo(0)) {
          throw new BadRequestException('amountOff must be greater than 0');
        }
        columns.amountOff = roundToCurrency(amount, currency);
        break;
      }
      case 'free_months': {
        if (!Number.isInteger(input.freeMonths) || input.freeMonths < 1) {
          throw new BadRequestException('freeMonths must be a positive whole number of months');
        }
        columns.freeMonths = input.freeMonths;
        break;
      }
      case 'free_trial_extension': {
        if (!Number.isInteger(input.trialExtensionDays) || input.trialExtensionDays < 1) {
          throw new BadRequestException(
            'trialExtensionDays must be a positive whole number of days',
          );
        }
        columns.trialExtensionDays = input.trialExtensionDays;
        break;
      }
    }

    return columns;
  }
}

export function normalizeCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!CODE_PATTERN.test(normalized)) {
    throw new BadRequestException(
      `Discount code must be 3-64 characters of A-Z, 0-9 or _ after normalisation (got "${code}")`,
    );
  }
  return normalized;
}

function assertValidityWindow(validFrom: Date | null, validUntil: Date | null): void {
  if (validFrom && validUntil && validUntil <= validFrom) {
    throw new BadRequestException('validUntil must be after validFrom');
  }
}

function describeGrant(grant: DiscountGrant, currency: string): string {
  switch (grant.kind) {
    case 'amount':
      return `Discount of ${grant.amountOff.toString()} ${currency} applied`;
    case 'free-months':
      return `${grant.months} free month(s) granted`;
    case 'trial-extension':
      return `Trial extended by ${grant.days} day(s)`;
  }
}

function toValidation(
  code: DiscountCode,
  evaluation: DiscountEvaluation,
  orderAmount?: Decimal,
): DiscountValidation {
  if (!evaluation.valid) {
    return {
      valid: false,
      reason: evaluation.reason,
      message: evaluation.message,
      discountCode: code,
    };
  }
  const grant = orderAmount === undefined ? undefined : grantOf(code, orderAmount);
  return {
    valid: true,
    message: evaluation.message,
    discountCode: code,
    discountAmount: grant?.kind === 'amount' ? grant.amountOff : undefined,
  };
}

/** The wire shape of a code — the one place a row becomes a snapshot. */
export function toDiscountCodeSnapshot(code: DiscountCode): BillingDiscountCodeSnapshot {
  const shared = {
    id: code.id,
    code: code.code,
    name: code.name,
    description: code.description ?? undefined,
    currency: code.currency,
    appliesTo: code.appliesTo,
    applicablePlanIds: code.applicablePlanIds ?? undefined,
    duration: code.duration,
    durationInMonths: code.durationInMonths ?? undefined,
    isActive: code.isActive,
    validFrom: code.validFrom ? new Date(code.validFrom).toISOString() : undefined,
    validUntil: code.validUntil ? new Date(code.validUntil).toISOString() : undefined,
    maxRedemptions: code.maxRedemptions ?? undefined,
    currentRedemptions: code.currentRedemptions,
    maxRedemptionsPerTenant: code.maxRedemptionsPerTenant ?? undefined,
    minimumOrderAmount: code.minimumOrderAmount ? code.minimumOrderAmount.toString() : undefined,
    campaignId: code.campaignId ?? undefined,
    campaignName: code.campaignName ?? undefined,
    stripePromotionCodeId: code.stripePromotionCodeId ?? null,
    stripeCouponId: code.stripeCouponId ?? null,
    isReferralCode: code.isReferralCode,
    referrerId: code.referrerId ?? undefined,
    metadata: code.metadata ?? undefined,
    createdAt: new Date(code.createdAt).toISOString(),
    updatedAt: new Date(code.updatedAt).toISOString(),
    createdBy: code.createdBy ?? null,
    updatedBy: code.updatedBy ?? null,
  };

  switch (code.discountType) {
    case DiscountType.PERCENTAGE:
      return {
        ...shared,
        discountType: 'percentage',
        percentOff: (code.percentOff ?? new Decimal(0)).toString(),
      };
    case DiscountType.FIXED_AMOUNT:
      return {
        ...shared,
        discountType: 'fixed_amount',
        amountOff: (code.amountOff ?? new Decimal(0)).toString(),
      };
    case DiscountType.FREE_MONTHS:
      return { ...shared, discountType: 'free_months', freeMonths: code.freeMonths ?? 0 };
    case DiscountType.FREE_TRIAL_EXTENSION:
      return {
        ...shared,
        discountType: 'free_trial_extension',
        trialExtensionDays: code.trialExtensionDays ?? 0,
      };
  }
}

export function toDiscountRedemptionSnapshot(
  redemption: DiscountRedemption,
): BillingDiscountRedemptionSnapshot {
  return {
    id: redemption.id,
    discountCodeId: redemption.discountCodeId,
    tenantId: redemption.tenantId,
    subscriptionId: redemption.subscriptionId ?? null,
    invoiceId: redemption.invoiceId ?? null,
    discountAmount: redemption.discountAmount.toString(),
    currency: redemption.currency,
    redeemedAt: new Date(redemption.redeemedAt).toISOString(),
    redeemedBy: redemption.redeemedBy ?? null,
  };
}
