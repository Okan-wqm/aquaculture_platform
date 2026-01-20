import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, IsNull, Or } from 'typeorm';
import {
  DiscountCode,
  DiscountRedemption,
  DiscountType,
  DiscountAppliesTo,
  DiscountDuration,
} from '../entities/discount-code.entity';

export interface CreateDiscountCodeDto {
  code: string;
  name: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  appliesTo?: DiscountAppliesTo;
  applicablePlanIds?: string[];
  duration?: DiscountDuration;
  durationInMonths?: number;
  validFrom?: Date;
  validUntil?: Date;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  minimumOrderAmount?: number;
  campaignId?: string;
  campaignName?: string;
  isReferralCode?: boolean;
  referrerId?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateDiscountCodeDto {
  name?: string;
  description?: string;
  isActive?: boolean;
  validFrom?: Date;
  validUntil?: Date;
  maxRedemptions?: number;
  maxRedemptionsPerTenant?: number;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

export interface ValidateDiscountResult {
  valid: boolean;
  discountCode?: DiscountCode;
  message?: string;
  discountAmount?: number;
}

export interface ApplyDiscountResult {
  success: boolean;
  originalAmount: number;
  discountAmount: number;
  finalAmount: number;
  discountCode?: DiscountCode;
  redemptionId?: string;
  message?: string;
}

export interface DiscountStats {
  totalCodes: number;
  activeCodes: number;
  expiredCodes: number;
  totalRedemptions: number;
  totalDiscountAmount: number;
  topCodes: Array<{
    code: string;
    redemptions: number;
    totalDiscount: number;
  }>;
}

/**
 * Discount Code Service
 * Manages coupon codes and promotional discounts
 */
@Injectable()
export class DiscountCodeService {
  private readonly logger = new Logger(DiscountCodeService.name);
  private readonly defaultCurrency: string;

  constructor(
    @InjectRepository(DiscountCode)
    private readonly discountCodeRepo: Repository<DiscountCode>,
    @InjectRepository(DiscountRedemption)
    private readonly redemptionRepo: Repository<DiscountRedemption>,
    private readonly configService: ConfigService,
  ) {
    this.defaultCurrency = this.configService.get<string>('BILLING_DEFAULT_CURRENCY', 'USD');
  }

  /**
   * Get all discount codes with optional filters
   */
  async findAll(options?: {
    isActive?: boolean;
    campaignId?: string;
    includeExpired?: boolean;
  }): Promise<DiscountCode[]> {
    const query = this.discountCodeRepo.createQueryBuilder('dc');

    if (options?.isActive !== undefined) {
      query.andWhere('dc.isActive = :isActive', { isActive: options.isActive });
    }

    if (options?.campaignId) {
      query.andWhere('dc.campaignId = :campaignId', { campaignId: options.campaignId });
    }

    if (!options?.includeExpired) {
      const now = new Date();
      query.andWhere(
        '(dc.validUntil IS NULL OR dc.validUntil > :now)',
        { now }
      );
    }

    return query.orderBy('dc.createdAt', 'DESC').getMany();
  }

  /**
   * Get discount code by ID
   */
  async findById(id: string): Promise<DiscountCode> {
    const code = await this.discountCodeRepo.findOne({ where: { id } });
    if (!code) {
      throw new NotFoundException(`Discount code with ID ${id} not found`);
    }
    return code;
  }

  /**
   * Get discount code by code string
   */
  async findByCode(code: string): Promise<DiscountCode | null> {
    return this.discountCodeRepo.findOne({
      where: { code: code.toUpperCase() },
    });
  }

  /**
   * Create a new discount code
   */
  async create(dto: CreateDiscountCodeDto): Promise<DiscountCode> {
    const normalizedCode = dto.code.toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Check for duplicate
    const existing = await this.findByCode(normalizedCode);
    if (existing) {
      throw new ConflictException(`Discount code ${normalizedCode} already exists`);
    }

    // Validate discount value
    if (dto.discountType === DiscountType.PERCENTAGE && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100%');
    }

    if (dto.discountValue <= 0) {
      throw new BadRequestException('Discount value must be positive');
    }

    const discountCode = this.discountCodeRepo.create({
      ...dto,
      code: normalizedCode,
      appliesTo: dto.appliesTo || DiscountAppliesTo.ALL_PLANS,
      duration: dto.duration || DiscountDuration.ONCE,
      isActive: true,
      currentRedemptions: 0,
    });

    const saved = await this.discountCodeRepo.save(discountCode);
    this.logger.log(`Created discount code: ${saved.code}`);
    return saved;
  }

  /**
   * Update a discount code
   */
  async update(id: string, dto: UpdateDiscountCodeDto): Promise<DiscountCode> {
    const discountCode = await this.findById(id);

    Object.assign(discountCode, dto);
    discountCode.updatedBy = dto.updatedBy;

    const saved = await this.discountCodeRepo.save(discountCode);
    this.logger.log(`Updated discount code: ${saved.code}`);
    return saved;
  }

  /**
   * Deactivate a discount code
   */
  async deactivate(id: string, updatedBy: string): Promise<DiscountCode> {
    const discountCode = await this.findById(id);
    discountCode.isActive = false;
    discountCode.updatedBy = updatedBy;

    const saved = await this.discountCodeRepo.save(discountCode);
    this.logger.log(`Deactivated discount code: ${saved.code}`);
    return saved;
  }

  /**
   * Validate a discount code for a tenant and order
   */
  async validateCode(
    code: string,
    tenantId: string,
    planId?: string,
    orderAmount?: number,
  ): Promise<ValidateDiscountResult> {
    const discountCode = await this.findByCode(code);

    if (!discountCode) {
      return { valid: false, message: 'Invalid discount code' };
    }

    // Check if active
    if (!discountCode.isActive) {
      return { valid: false, message: 'This discount code is no longer active' };
    }

    // Check validity period
    const now = new Date();
    if (discountCode.validFrom && now < discountCode.validFrom) {
      return { valid: false, message: 'This discount code is not yet valid' };
    }

    if (discountCode.validUntil && now > discountCode.validUntil) {
      return { valid: false, message: 'This discount code has expired' };
    }

    // Check max redemptions
    if (
      discountCode.maxRedemptions !== null &&
      discountCode.maxRedemptions !== undefined &&
      discountCode.currentRedemptions >= discountCode.maxRedemptions
    ) {
      return { valid: false, message: 'This discount code has reached its maximum usage limit' };
    }

    // Check per-tenant redemptions
    if (discountCode.maxRedemptionsPerTenant) {
      const tenantRedemptions = await this.redemptionRepo.count({
        where: {
          discountCodeId: discountCode.id,
          tenantId,
        },
      });

      if (tenantRedemptions >= discountCode.maxRedemptionsPerTenant) {
        return {
          valid: false,
          message: 'You have already used this discount code the maximum number of times',
        };
      }
    }

    // Check plan applicability
    if (
      planId &&
      discountCode.appliesTo === DiscountAppliesTo.SPECIFIC_PLANS &&
      discountCode.applicablePlanIds &&
      !discountCode.applicablePlanIds.includes(planId)
    ) {
      return { valid: false, message: 'This discount code is not valid for your selected plan' };
    }

    // Check minimum order amount
    if (
      orderAmount !== undefined &&
      discountCode.minimumOrderAmount &&
      orderAmount < discountCode.minimumOrderAmount
    ) {
      return {
        valid: false,
        message: `Minimum order amount of ${discountCode.minimumOrderAmount} required for this discount`,
      };
    }

    // Calculate discount amount
    let discountAmount = 0;
    if (orderAmount !== undefined) {
      discountAmount = this.calculateDiscountAmount(discountCode, orderAmount);
    }

    return {
      valid: true,
      discountCode,
      discountAmount,
      message: 'Discount code is valid',
    };
  }

  /**
   * Apply a discount code to an order
   */
  async applyDiscount(
    code: string,
    tenantId: string,
    originalAmount: number,
    options: {
      subscriptionId?: string;
      invoiceId?: string;
      planId?: string;
      redeemedBy?: string;
      currency?: string;
    } = {},
  ): Promise<ApplyDiscountResult> {
    const validation = await this.validateCode(
      code,
      tenantId,
      options.planId,
      originalAmount,
    );

    if (!validation.valid || !validation.discountCode) {
      return {
        success: false,
        originalAmount,
        discountAmount: 0,
        finalAmount: originalAmount,
        message: validation.message,
      };
    }

    const discountCode = validation.discountCode;
    const discountAmount = this.calculateDiscountAmount(discountCode, originalAmount);
    const finalAmount = Math.max(0, originalAmount - discountAmount);

    // Record redemption
    const redemption = this.redemptionRepo.create({
      discountCodeId: discountCode.id,
      tenantId,
      subscriptionId: options.subscriptionId,
      invoiceId: options.invoiceId,
      discountAmount,
      currency: options.currency || this.defaultCurrency,
      redeemedAt: new Date(),
      redeemedBy: options.redeemedBy,
    });

    await this.redemptionRepo.save(redemption);

    // Increment redemption count
    discountCode.currentRedemptions += 1;
    await this.discountCodeRepo.save(discountCode);

    this.logger.log(
      `Applied discount ${discountCode.code} for tenant ${tenantId}: $${discountAmount} off`,
    );

    return {
      success: true,
      originalAmount,
      discountAmount,
      finalAmount,
      discountCode,
      redemptionId: redemption.id,
      message: `Discount of $${discountAmount.toFixed(2)} applied`,
    };
  }

  /**
   * Get redemption history for a discount code
   */
  async getRedemptions(
    discountCodeId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ redemptions: DiscountRedemption[]; total: number }> {
    const [redemptions, total] = await this.redemptionRepo.findAndCount({
      where: { discountCodeId },
      order: { redeemedAt: 'DESC' },
      take: options?.limit || 50,
      skip: options?.offset || 0,
    });

    return { redemptions, total };
  }

  /**
   * Get redemption history for a tenant
   */
  async getTenantRedemptions(tenantId: string): Promise<DiscountRedemption[]> {
    return this.redemptionRepo.find({
      where: { tenantId },
      order: { redeemedAt: 'DESC' },
    });
  }

  /**
   * Get discount statistics
   */
  async getStats(): Promise<DiscountStats> {
    const now = new Date();

    const [totalCodes, activeCodes] = await Promise.all([
      this.discountCodeRepo.count(),
      this.discountCodeRepo.count({
        where: {
          isActive: true,
        },
      }),
    ]);

    const expiredCodes = await this.discountCodeRepo.count({
      where: {
        validUntil: LessThanOrEqual(now),
      },
    });

    // Get total redemptions and discount amount
    const redemptionStats = await this.redemptionRepo
      .createQueryBuilder('r')
      .select('COUNT(*)', 'totalRedemptions')
      .addSelect('COALESCE(SUM(r.discountAmount), 0)', 'totalDiscountAmount')
      .getRawOne();

    // Get top codes
    const topCodes = await this.redemptionRepo
      .createQueryBuilder('r')
      .innerJoin('discount_codes', 'dc', 'dc.id = r.discountCodeId')
      .select('dc.code', 'code')
      .addSelect('COUNT(*)', 'redemptions')
      .addSelect('COALESCE(SUM(r.discountAmount), 0)', 'totalDiscount')
      .groupBy('dc.code')
      .orderBy('redemptions', 'DESC')
      .limit(10)
      .getRawMany();

    return {
      totalCodes,
      activeCodes,
      expiredCodes,
      totalRedemptions: parseInt(redemptionStats?.totalRedemptions || '0', 10),
      totalDiscountAmount: parseFloat(redemptionStats?.totalDiscountAmount || '0'),
      topCodes: topCodes.map(tc => ({
        code: tc.code,
        redemptions: parseInt(tc.redemptions, 10),
        totalDiscount: parseFloat(tc.totalDiscount),
      })),
    };
  }

  /**
   * Generate a unique discount code
   */
  async generateUniqueCode(prefix?: string, length = 8): Promise<string> {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      let code = prefix ? `${prefix}_` : '';
      for (let i = 0; i < length; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }

      const existing = await this.findByCode(code);
      if (!existing) {
        return code;
      }
      attempts++;
    }

    throw new Error('Failed to generate unique discount code');
  }

  /**
   * Bulk create discount codes for a campaign
   */
  async bulkCreate(
    count: number,
    template: Omit<CreateDiscountCodeDto, 'code'>,
    codePrefix?: string,
  ): Promise<DiscountCode[]> {
    const codes: DiscountCode[] = [];

    for (let i = 0; i < count; i++) {
      const code = await this.generateUniqueCode(codePrefix);
      const created = await this.create({ ...template, code });
      codes.push(created);
    }

    this.logger.log(`Bulk created ${count} discount codes for campaign ${template.campaignId}`);
    return codes;
  }

  /**
   * Calculate discount amount based on discount type
   */
  private calculateDiscountAmount(discountCode: DiscountCode, orderAmount: number): number {
    switch (discountCode.discountType) {
      case DiscountType.PERCENTAGE:
        return (orderAmount * discountCode.discountValue) / 100;

      case DiscountType.FIXED_AMOUNT:
        return Math.min(discountCode.discountValue, orderAmount);

      case DiscountType.FREE_MONTHS:
        // This would need context about monthly price
        // For now, return 0 - handled differently in subscription
        return 0;

      case DiscountType.FREE_TRIAL_EXTENSION:
        // This doesn't affect amount directly
        return 0;

      default:
        return 0;
    }
  }
}
