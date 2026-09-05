import { TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsObject,
  IsUUID,
  IsBoolean,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
} from 'class-validator';

import { PricingMetric, TierMultipliers } from '../entities/module-pricing.entity';
import { PlanTier } from '../entities/plan-definition.entity';
import { CreateDiscountCodeDto } from '../services/discount-code.service';
import { QuoteRequest } from '../services/pricing-calculator.service';

// ============================================================================
// Module Pricing
// ============================================================================

export class UpdateModulePricingDto {
  @IsOptional()
  @IsUUID('4')
  moduleId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  moduleCode?: string;

  @IsOptional()
  @IsArray()
  pricingMetrics?: PricingMetric[];

  @IsOptional()
  @IsObject()
  tierMultipliers?: TierMultipliers;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  effectiveFrom?: Date;

  @IsOptional()
  effectiveTo?: Date | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SeedModulePricingDto {
  @IsObject()
  moduleIdMap!: Record<string, string>;
}

// ============================================================================
// Plan Compare
// ============================================================================

export class ComparePlansDto {
  @IsUUID('4')
  currentPlanId!: string;

  @IsUUID('4')
  newPlanId!: string;
}

// ============================================================================
// Discount Codes
// ============================================================================

export class ValidateDiscountCodeDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsOptional()
  @IsUUID('4')
  planId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  orderAmount?: number;
}

export class ApplyDiscountCodeDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  @MaxLength(100)
  code!: string;

  @IsNumber()
  @Min(0)
  originalAmount!: number;

  @IsOptional()
  @IsUUID('4')
  subscriptionId?: string;

  @IsOptional()
  @IsUUID('4')
  invoiceId?: string;

  @IsOptional()
  @IsUUID('4')
  planId?: string;
}

export class GenerateDiscountCodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  prefix?: string;

  @IsOptional()
  @IsNumber()
  @Min(4)
  @Max(32)
  length?: number;
}

export class BulkCreateDiscountCodesDto {
  @IsNumber()
  @Min(1)
  @Max(1000)
  count!: number;

  @IsObject()
  template!: Omit<CreateDiscountCodeDto, 'code'>;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  codePrefix?: string;
}

// ============================================================================
// Subscriptions
// ============================================================================

export class CancelSubscriptionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsBoolean()
  cancelImmediately?: boolean;
}

export class ExtendTrialDto {
  @IsNumber()
  @Min(1)
  @Max(365)
  additionalDays!: number;
}

// ============================================================================
// Pricing Calculator
// ============================================================================

export class QuickEstimateDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  moduleCodes!: string[];

  @IsString()
  tier!: PlanTier;

  @IsOptional()
  @IsObject()
  quantities?: {
    users?: number;
    farms?: number;
    ponds?: number;
    sensors?: number;
  };
}

export class ComparePricingDto {
  @IsObject()
  config1!: QuoteRequest;

  @IsObject()
  config2!: QuoteRequest;
}

// ============================================================================
// Custom Plans
// ============================================================================

export class RejectCustomPlanDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class CloneCustomPlanDto {
  @IsUUID('4')
  newTenantId!: string;
}

// ============================================================================
// Invoices
// ============================================================================

export class MarkInvoicePaidDto {
  @IsNumber()
  @Min(0)
  amount!: number;
}

export class VoidInvoiceDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

// ============================================================================
// Users (password reset in billing context)
// ============================================================================

export class ResetPasswordByAdminDto {
  @IsString()
  @MaxLength(255)
  newPassword!: string;
}
