import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsUUID,
  IsNotEmpty,
  MaxLength,
  MinLength,
  Matches,
  ValidateNested,
  IsBoolean,
  IsNumber,
  Min,
  IsArray,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { TenantStatus, TenantPlan, TenantTier } from '../entities/tenant.entity';

export class TenantLimitsDto {
  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxUsers?: number;

  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxFarms?: number;

  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxPonds?: number;

  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxSensors?: number;

  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxAlertRules?: number;

  @IsNumber()
  @Min(-1)
  @IsOptional()
  dataRetentionDays?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  apiRateLimit?: number;

  @IsNumber()
  @Min(-1)
  @IsOptional()
  storageGb?: number;
}

export class NotificationPreferencesDto {
  @IsBoolean()
  @IsOptional()
  email?: boolean;

  @IsBoolean()
  @IsOptional()
  sms?: boolean;

  @IsBoolean()
  @IsOptional()
  push?: boolean;

  @IsBoolean()
  @IsOptional()
  slack?: boolean;
}

export class TenantSettingsDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  timezone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  locale?: string;

  @IsString()
  @IsOptional()
  @MaxLength(5)
  currency?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  dateFormat?: string;

  @IsEnum(['metric', 'imperial'])
  @IsOptional()
  measurementSystem?: 'metric' | 'imperial';

  @ValidateNested()
  @Type(() => NotificationPreferencesDto)
  @IsOptional()
  notificationPreferences?: NotificationPreferencesDto;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  features?: string[];
}

export class TenantContactDto {
  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsString()
  @MaxLength(50)
  role!: string;
}

/**
 * Module quantity configuration for tenant creation
 * Allows specifying quantities like users, farms, ponds per module
 */
export class ModuleQuantityDto {
  @IsUUID('4')
  @IsNotEmpty()
  moduleId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  users?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  farms?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ponds?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sensors?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  employees?: number;
}

export class CreateTenantDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @IsNotEmpty()
  @Transform(({ value }) => value?.trim())
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message:
      'Slug must be lowercase alphanumeric with hyphens, not starting or ending with hyphen',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => value?.trim())
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, {
    message: 'Invalid domain format',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  domain?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @IsOptional()
  @IsEnum(TenantPlan)
  tier?: TenantTier;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantContactDto)
  primaryContact?: TenantContactDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantContactDto)
  billingContact?: TenantContactDto;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  billingEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  trialDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxUsers?: number;

  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  /**
   * Module IDs to assign to the tenant during creation
   * Super Admin selects which modules the tenant will have access to
   */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  moduleIds?: string[];

  /**
   * Optional quantity configuration per module
   * Allows specifying users, farms, ponds etc. per module for pricing
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModuleQuantityDto)
  moduleQuantities?: ModuleQuantityDto[];

  /**
   * Billing cycle preference
   */
  @IsOptional()
  @IsEnum(['monthly', 'quarterly', 'semi_annual', 'annual'])
  billingCycle?: 'monthly' | 'quarterly' | 'semi_annual' | 'annual';
}

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(({ value }) => value?.trim())
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => value?.trim())
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, {
    message: 'Invalid domain format',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  domain?: string;

  @IsOptional()
  @IsEnum(TenantPlan)
  tier?: TenantTier;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantLimitsDto)
  limits?: TenantLimitsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantSettingsDto)
  settings?: TenantSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantContactDto)
  primaryContact?: TenantContactDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TenantContactDto)
  billingContact?: TenantContactDto;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  billingEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxUsers?: number;
}

export class SuspendTenantDto {
  @IsString()
  @MaxLength(500)
  @IsNotEmpty()
  reason!: string;
}

export class ListTenantsQueryDto {
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;

  @IsOptional()
  @IsEnum(TenantPlan)
  tier?: TenantTier;

  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}

export class TenantInviteDto {
  @IsUUID()
  tenantId!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MaxLength(50)
  role!: string;
}

export class TenantStatsDto {
  totalTenants!: number;
  activeTenants!: number;
  suspendedTenants!: number;
  pendingTenants!: number;
  byTier?: Record<string, number>;
  byPlan?: Record<string, number>;
  newTenantsLast30Days!: number;
  churnedTenantsLast30Days!: number;
}

export class TenantUsageDto {
  tenantId!: string;
  userCount?: number;
  farmCount?: number;
  sensorCount?: number;
  alertRuleCount?: number;
  storageUsedGb?: number;
  apiCallsLast24h?: number;
  maxUsers?: number;
  currentUserCount?: number;
  limits?: TenantLimitsDto;
  usagePercentage?: {
    users: number;
    farms?: number;
    sensors?: number;
    alertRules?: number;
    storage?: number;
  } | number;
}
