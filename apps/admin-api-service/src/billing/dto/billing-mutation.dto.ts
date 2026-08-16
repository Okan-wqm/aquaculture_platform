import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  DiscountAppliesTo,
  DiscountDuration,
  DiscountType,
} from '../entities/discount-code.entity';
import { BillingCycle, PlanTier, PlanVisibility } from '../entities/plan-definition.entity';
import { PricingMetricType } from '../entities/pricing-metric.enum';

class PlanLimitsDto {
  @IsInt() @Min(-1) maxUsers!: number;
  @IsInt() @Min(-1) maxFarms!: number;
  @IsInt() @Min(-1) maxPonds!: number;
  @IsInt() @Min(-1) maxSensors!: number;
  @IsInt() @Min(-1) maxModules!: number;
  @IsNumber() @Min(0) storageGB!: number;
  @IsInt() @Min(0) dataRetentionDays!: number;
  @IsInt() @Min(0) apiRateLimit!: number;
  @IsBoolean() alertsEnabled!: boolean;
  @IsBoolean() reportsEnabled!: boolean;
  @IsBoolean() customBrandingEnabled!: boolean;
  @IsBoolean() apiAccessEnabled!: boolean;
  @IsBoolean() customIntegrationsEnabled!: boolean;
  @IsBoolean() ssoEnabled!: boolean;
  @IsBoolean() auditLogEnabled!: boolean;
  @IsBoolean() prioritySupport!: boolean;
  @IsBoolean() dedicatedAccountManager!: boolean;
}

class PlanLimitsPatchDto {
  @IsOptional() @IsInt() @Min(-1) maxUsers?: number;
  @IsOptional() @IsInt() @Min(-1) maxFarms?: number;
  @IsOptional() @IsInt() @Min(-1) maxPonds?: number;
  @IsOptional() @IsInt() @Min(-1) maxSensors?: number;
  @IsOptional() @IsInt() @Min(-1) maxModules?: number;
  @IsOptional() @IsNumber() @Min(0) storageGB?: number;
  @IsOptional() @IsInt() @Min(0) dataRetentionDays?: number;
  @IsOptional() @IsInt() @Min(0) apiRateLimit?: number;
  @IsOptional() @IsBoolean() alertsEnabled?: boolean;
  @IsOptional() @IsBoolean() reportsEnabled?: boolean;
  @IsOptional() @IsBoolean() customBrandingEnabled?: boolean;
  @IsOptional() @IsBoolean() apiAccessEnabled?: boolean;
  @IsOptional() @IsBoolean() customIntegrationsEnabled?: boolean;
  @IsOptional() @IsBoolean() ssoEnabled?: boolean;
  @IsOptional() @IsBoolean() auditLogEnabled?: boolean;
  @IsOptional() @IsBoolean() prioritySupport?: boolean;
  @IsOptional() @IsBoolean() dedicatedAccountManager?: boolean;
}

class PlanCyclePricingDto {
  @IsNumber() @Min(0) basePrice!: number;
  @IsNumber() @Min(0) perUserPrice!: number;
  @IsNumber() @Min(0) perFarmPrice!: number;
  @IsNumber() @Min(0) perModulePrice!: number;
}

class DiscountedPlanCyclePricingDto extends PlanCyclePricingDto {
  @IsNumber() @Min(0) @Max(100) discountPercent!: number;
}

class PlanPricingDto {
  @ValidateNested() @Type(() => PlanCyclePricingDto) monthly!: PlanCyclePricingDto;
  @ValidateNested()
  @Type(() => DiscountedPlanCyclePricingDto)
  quarterly!: DiscountedPlanCyclePricingDto;
  @ValidateNested()
  @Type(() => DiscountedPlanCyclePricingDto)
  semiAnnual!: DiscountedPlanCyclePricingDto;
  @ValidateNested()
  @Type(() => DiscountedPlanCyclePricingDto)
  annual!: DiscountedPlanCyclePricingDto;
  @IsString() @MaxLength(3) currency!: string;
}

class PlanPricingPatchDto {
  @IsOptional() @ValidateNested() @Type(() => PlanCyclePricingDto) monthly?: PlanCyclePricingDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => DiscountedPlanCyclePricingDto)
  quarterly?: DiscountedPlanCyclePricingDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => DiscountedPlanCyclePricingDto)
  semiAnnual?: DiscountedPlanCyclePricingDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => DiscountedPlanCyclePricingDto)
  annual?: DiscountedPlanCyclePricingDto;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
}

class PlanAddOnDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsString() @MaxLength(2000) description!: string;
  @IsNumber() @Min(0) price!: number;
  @IsEnum(BillingCycle) billingCycle!: BillingCycle;
}

class PlanFeaturesDto {
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) coreFeatures!: string[];
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) advancedFeatures!: string[];
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) premiumFeatures!: string[];
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlanAddOnDto)
  addOns!: PlanAddOnDto[];
}

class PlanFeaturesPatchDto {
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) coreFeatures?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) advancedFeatures?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) premiumFeatures?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PlanAddOnDto)
  addOns?: PlanAddOnDto[];
}

export class CreatePlanDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsEnum(PlanTier) tier!: PlanTier;
  @IsOptional() @IsEnum(PlanVisibility) visibility?: PlanVisibility;
  @IsOptional() @IsBoolean() isRecommended?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @ValidateNested() @Type(() => PlanLimitsDto) limits!: PlanLimitsDto;
  @ValidateNested() @Type(() => PlanPricingDto) pricing!: PlanPricingDto;
  @ValidateNested() @Type(() => PlanFeaturesDto) features!: PlanFeaturesDto;
  @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) gracePeriodDays?: number;
  @IsOptional() @IsString() @MaxLength(2000) upgradeMessage?: string;
  @IsOptional() @IsString() @MaxLength(2000) downgradeWarning?: string;
  @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(100) badge?: string;
}

export class UpdatePlanDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsOptional() @IsEnum(PlanVisibility) visibility?: PlanVisibility;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isRecommended?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @ValidateNested() @Type(() => PlanLimitsPatchDto) limits?: PlanLimitsPatchDto;
  @IsOptional() @ValidateNested() @Type(() => PlanPricingPatchDto) pricing?: PlanPricingPatchDto;
  @IsOptional() @ValidateNested() @Type(() => PlanFeaturesPatchDto) features?: PlanFeaturesPatchDto;
  @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(365) gracePeriodDays?: number;
  @IsOptional() @IsString() @MaxLength(2000) upgradeMessage?: string;
  @IsOptional() @IsString() @MaxLength(2000) downgradeWarning?: string;
  @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(100) badge?: string;
}

export class CreateDiscountCodeDto {
  @IsString() @MaxLength(100) code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsEnum(DiscountType) discountType!: DiscountType;
  @IsNumber() @Min(0) discountValue!: number;
  @IsOptional() @IsEnum(DiscountAppliesTo) appliesTo?: DiscountAppliesTo;
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(100)
  applicablePlanIds?: string[];
  @IsOptional() @IsEnum(DiscountDuration) duration?: DiscountDuration;
  @IsOptional() @IsInt() @Min(1) durationInMonths?: number;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptionsPerTenant?: number;
  @IsOptional() @IsNumber() @Min(0) minimumOrderAmount?: number;
  @IsOptional() @IsString() @MaxLength(255) campaignId?: string;
  @IsOptional() @IsString() @MaxLength(255) campaignName?: string;
  @IsOptional() @IsBoolean() isReferralCode?: boolean;
  @IsOptional() @IsUUID('4') referrerId?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class UpdateDiscountCodeDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptionsPerTenant?: number;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class PlanChangeRequestDto {
  @IsUUID('4') tenantId!: string;
  @IsUUID('4') currentPlanId!: string;
  @IsUUID('4') newPlanId!: string;
  @IsOptional() @IsEnum(BillingCycle) newBillingCycle?: BillingCycle;
  @IsOptional() @IsString() @MaxLength(100) discountCode?: string;
  @IsOptional() @IsBoolean() effectiveImmediately?: boolean;
}

class PricingMetricDto {
  @IsEnum(PricingMetricType) type!: PricingMetricType;
  @IsNumber() @Min(0) price!: number;
  @IsString() @MaxLength(3) currency!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsNumber() @Min(0) minQuantity?: number;
  @IsOptional() @IsNumber() @Min(0) maxQuantity?: number;
  @IsOptional() @IsNumber() @Min(0) includedQuantity?: number;
}

export class SetModulePricingDto {
  @IsUUID('4') moduleId!: string;
  @IsString() @MaxLength(100) moduleCode!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PricingMetricDto)
  pricingMetrics!: PricingMetricDto[];
  @IsOptional() @IsObject() tierMultipliers?: Partial<Record<PlanTier, number>>;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @Type(() => Date) @IsDate() effectiveFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() effectiveTo?: Date | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class ModuleQuantitiesDto {
  @IsOptional() @IsNumber() @Min(0) users?: number;
  @IsOptional() @IsNumber() @Min(0) farms?: number;
  @IsOptional() @IsNumber() @Min(0) ponds?: number;
  @IsOptional() @IsNumber() @Min(0) sensors?: number;
  @IsOptional() @IsNumber() @Min(0) devices?: number;
  @IsOptional() @IsNumber() @Min(0) storageGb?: number;
  @IsOptional() @IsNumber() @Min(0) apiCalls?: number;
  @IsOptional() @IsNumber() @Min(0) alerts?: number;
  @IsOptional() @IsNumber() @Min(0) reports?: number;
  @IsOptional() @IsNumber() @Min(0) integrations?: number;
}

class ModuleSelectionDto {
  @IsUUID('4') moduleId!: string;
  @IsString() @MaxLength(100) moduleCode!: string;
  @IsOptional() @IsString() @MaxLength(255) moduleName?: string;
  @ValidateNested() @Type(() => ModuleQuantitiesDto) quantities!: ModuleQuantitiesDto;
}

export class QuoteRequestDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ModuleSelectionDto)
  modules!: ModuleSelectionDto[];
  @IsEnum(PlanTier) tier!: PlanTier;
  @IsEnum(BillingCycle) billingCycle!: BillingCycle;
  @IsOptional() @IsString() @MaxLength(100) discountCode?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) taxRate?: number;
}

class CustomPlanModuleDto {
  @IsUUID('4') moduleId!: string;
  @IsString() @MaxLength(100) moduleCode!: string;
  @IsString() @MaxLength(255) moduleName!: string;
  @ValidateNested() @Type(() => ModuleQuantitiesDto) quantities!: ModuleQuantitiesDto;
}

export class CreateCustomPlanDto {
  @IsUUID('4') tenantId!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsUUID('4') basePlanId?: string;
  @IsOptional() @IsEnum(PlanTier) tier?: PlanTier;
  @IsOptional() @IsEnum(BillingCycle) billingCycle?: BillingCycle;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomPlanModuleDto)
  modules!: CustomPlanModuleDto[];
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsNumber() @Min(0) discountAmount?: number;
  @IsOptional() @IsString() @MaxLength(1000) discountReason?: string;
  @Type(() => Date) @IsDate() validFrom!: Date;
  @IsOptional() @Type(() => Date) @IsDate() validTo?: Date;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

export class UpdateCustomPlanDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomPlanModuleDto)
  modules?: CustomPlanModuleDto[];
  @IsOptional() @IsNumber() @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @IsNumber() @Min(0) discountAmount?: number;
  @IsOptional() @IsString() @MaxLength(1000) discountReason?: string;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validTo?: Date;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

class BillingAddressDto {
  @IsString() @MaxLength(255) companyName!: string;
  @IsOptional() @IsString() @MaxLength(255) attention?: string;
  @IsString() @MaxLength(255) street!: string;
  @IsString() @MaxLength(100) city!: string;
  @IsString() @MaxLength(100) state!: string;
  @IsString() @MaxLength(32) postalCode!: string;
  @IsString() @MaxLength(2) country!: string;
  @IsOptional() @IsString() @MaxLength(100) taxId?: string;
}

class InvoiceLineItemDto {
  @IsString() @MaxLength(1000) description!: string;
  @IsNumber() @Min(0) quantity!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() @MaxLength(100) productCode?: string;
}

class InvoiceTaxDto {
  @IsNumber() @Min(0) @Max(1) taxRate!: number;
  @IsOptional() @IsString() @MaxLength(100) taxId?: string;
  @IsOptional() @IsString() @MaxLength(255) taxName?: string;
}

export class CreateInvoiceRequestDto {
  @IsUUID('4') tenantId!: string;
  @IsOptional() @IsUUID('4') subscriptionId?: string;
  @ValidateNested() @Type(() => BillingAddressDto) billingAddress!: BillingAddressDto;
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemDto)
  lineItems!: InvoiceLineItemDto[];
  @IsOptional() @ValidateNested() @Type(() => InvoiceTaxDto) tax?: InvoiceTaxDto;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsString() @MaxLength(100) discountCode?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsDateString() dueDate!: string;
  @IsDateString() periodStart!: string;
  @IsDateString() periodEnd!: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

export class RecordPaymentDto {
  @IsUUID('4') invoiceId!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsString() @MaxLength(100) paymentMethod!: string;
  @IsOptional() @IsDateString() paymentDate?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class RefundPaymentDto {
  @IsUUID('4') paymentId!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsString() @MaxLength(1000) reason!: string;
}
