import { ObjectType, Field, ID, Float, Int, registerEnumType } from '@nestjs/graphql';

// ============================================================================
// Enums matching frontend expectations
// ============================================================================

export enum TenantSubscriptionStatus {
  ACTIVE = 'ACTIVE',
  TRIAL = 'TRIAL',
  PAST_DUE = 'PAST_DUE',
  CANCELLED = 'CANCELLED',
  SUSPENDED = 'SUSPENDED',
}

export enum TenantBillingPeriod {
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
}

export enum TenantInvoiceStatus {
  PAID = 'PAID',
  PENDING = 'PENDING',
  OVERDUE = 'OVERDUE',
  DRAFT = 'DRAFT',
  VOID = 'VOID',
}

registerEnumType(TenantSubscriptionStatus, { name: 'TenantSubscriptionStatus' });
registerEnumType(TenantBillingPeriod, { name: 'TenantBillingPeriod' });
registerEnumType(TenantInvoiceStatus, { name: 'TenantInvoiceStatus' });

// ============================================================================
// Subscription DTO
// ============================================================================

@ObjectType()
export class TenantSubscriptionDto {
  @Field(() => ID)
  id!: string;

  @Field()
  plan!: string;

  @Field(() => TenantSubscriptionStatus)
  status!: TenantSubscriptionStatus;

  @Field(() => TenantBillingPeriod)
  billingPeriod!: TenantBillingPeriod;

  @Field()
  currentPeriodStart!: string;

  @Field()
  currentPeriodEnd!: string;

  @Field(() => String, { nullable: true })
  trialEndDate!: string | null;

  @Field(() => Float, {
    deprecationReason: 'Use monthlyPriceDecimal (exact decimal string, ADR-0004).',
  })
  monthlyPrice!: number;

  @Field()
  currency!: string;
}

// ============================================================================
// Invoice DTO
// ============================================================================

@ObjectType()
export class TenantInvoiceDto {
  @Field(() => ID)
  id!: string;

  @Field()
  invoiceNumber!: string;

  @Field(() => Float, {
    deprecationReason: 'Use amountDecimal (exact decimal string, ADR-0004).',
  })
  amount!: number;

  @Field()
  currency!: string;

  @Field(() => TenantInvoiceStatus)
  status!: TenantInvoiceStatus;

  @Field()
  issuedAt!: string;

  @Field()
  dueDate!: string;

  @Field(() => String, { nullable: true })
  paidAt!: string | null;

  @Field()
  description!: string;
}

// ============================================================================
// Plan Limits DTO
// ============================================================================

@ObjectType()
export class TenantPlanLimitsDto {
  @Field(() => Int)
  maxFarms!: number;

  @Field(() => Int)
  maxSensors!: number;

  @Field(() => Int)
  maxUsers!: number;

  @Field(() => Float)
  maxStorage!: number;

  @Field(() => Int)
  currentFarms!: number;

  @Field(() => Int)
  currentSensors!: number;

  @Field(() => Int)
  currentUsers!: number;

  @Field(() => Float)
  currentStorage!: number;
}

// ============================================================================
// Usage Metrics DTO
// ============================================================================

@ObjectType()
export class TenantUsageMetricsDto {
  @Field(() => Int)
  apiCallsThisMonth!: number;

  @Field(() => Int)
  apiCallsLimit!: number;

  @Field(() => Float)
  storageUsedGb!: number;

  @Field(() => Float)
  storageLimit!: number;

  @Field(() => Int)
  sensorReadingsThisMonth!: number;

  @Field(() => Int)
  sensorReadingsLimit!: number;
}

// ============================================================================
// Top-level Response DTO
// ============================================================================

@ObjectType()
export class TenantBillingResponse {
  @Field(() => TenantSubscriptionDto, { nullable: true })
  subscription!: TenantSubscriptionDto | null;

  @Field(() => [TenantInvoiceDto])
  invoices!: TenantInvoiceDto[];

  @Field(() => TenantPlanLimitsDto, { nullable: true })
  planLimits!: TenantPlanLimitsDto | null;

  @Field(() => TenantUsageMetricsDto, { nullable: true })
  usageMetrics!: TenantUsageMetricsDto | null;
}
