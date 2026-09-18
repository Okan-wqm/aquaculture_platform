/**
 * Request bodies for `global-settings.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsNumber,
  IsObject,
  IsDefined,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import {
  FeatureToggleScope,
  FeatureToggleStatus,
  FeatureCondition,
} from '../../entities/feature-toggle.entity';
import { MaintenanceScope, MaintenanceType } from '../../entities/maintenance-mode.entity';
import { ReleaseType, ChangelogEntry } from '../../entities/system-version.entity';

// ============================================================================
// DTOs
// ============================================================================

export class CreateFeatureToggleDto {
  @IsString()
  key!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  scope?: FeatureToggleScope;

  @IsOptional()
  @IsString()
  status?: FeatureToggleStatus;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  conditions?: FeatureCondition[];

  @IsOptional()
  @IsNumber()
  rolloutPercentage?: number;

  @IsOptional()
  defaultValue?: unknown;

  @IsOptional()
  @IsArray()
  variants?: Array<{ key: string; value: unknown; weight: number; description?: string }>;

  @IsOptional()
  @IsBoolean()
  requiresRestart?: boolean;

  @IsOptional()
  @IsBoolean()
  isExperimental?: boolean;
}

export class UpdateFeatureToggleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  status?: FeatureToggleStatus;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  conditions?: FeatureCondition[];

  @IsOptional()
  @IsNumber()
  rolloutPercentage?: number;

  @IsOptional()
  @IsArray()
  enabledTenants?: string[];

  @IsOptional()
  @IsArray()
  disabledTenants?: string[];

  @IsOptional()
  defaultValue?: unknown;

  @IsOptional()
  @IsArray()
  variants?: Array<{ key: string; value: unknown; weight: number; description?: string }>;

  @IsOptional()
  deprecatedAt?: Date;

  @IsOptional()
  @IsString()
  deprecationMessage?: string;
}

export class EvaluateFeatureToggleDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  userRole?: string;

  @IsOptional()
  @IsString()
  planType?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsObject()
  custom?: Record<string, string>;
}

export class CreateMaintenanceDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsString()
  title!: string;

  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  scope?: MaintenanceScope;

  @IsOptional()
  @IsString()
  type?: MaintenanceType;

  @IsOptional()
  @IsArray()
  affectedTenants?: string[];

  @IsOptional()
  @IsArray()
  affectedServices?: Array<{
    name: string;
    status: 'unavailable' | 'degraded' | 'read_only';
    message?: string;
  }>;

  @IsDefined()
  scheduledStart!: Date;

  @IsOptional()
  scheduledEnd?: Date;

  @IsOptional()
  @IsNumber()
  estimatedDurationMinutes?: number;

  @IsOptional()
  @IsString()
  userMessage?: string;

  @IsOptional()
  @IsBoolean()
  allowReadOnlyAccess?: boolean;

  @IsOptional()
  @IsBoolean()
  bypassForSuperAdmins?: boolean;

  @IsOptional()
  @IsArray()
  whitelistedIPs?: string[];
}

export class CreateVersionDto {
  @IsString()
  version!: string;

  @IsString()
  releaseType!: ReleaseType;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  changelog?: ChangelogEntry[];

  @IsOptional()
  @IsArray()
  breakingChanges?: string[];

  @IsOptional()
  @IsArray()
  deprecations?: string[];

  @IsOptional()
  @IsArray()
  newFeatures?: string[];

  @IsOptional()
  @IsString()
  releaseNotes?: string;

  @IsOptional()
  @IsString()
  upgradeGuide?: string;
}

export class UpdateMaintenanceDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  scope?: MaintenanceScope;

  @IsOptional()
  @IsString()
  type?: MaintenanceType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedTenants?: string[];

  @IsOptional()
  @IsArray()
  affectedServices?: Array<{
    name: string;
    status: 'unavailable' | 'degraded' | 'read_only';
    message?: string;
  }>;

  @IsOptional()
  scheduledStart?: Date;

  @IsOptional()
  scheduledEnd?: Date;

  @IsOptional()
  @IsNumber()
  estimatedDurationMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  userMessage?: string;

  @IsOptional()
  @IsBoolean()
  allowReadOnlyAccess?: boolean;

  @IsOptional()
  @IsBoolean()
  bypassForSuperAdmins?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  whitelistedIPs?: string[];
}

export class ExtendMaintenanceDto {
  @IsNumber()
  @Min(1)
  @Max(1440)
  additionalMinutes!: number;
}

export class DeployVersionDto {
  @IsString()
  @MaxLength(255)
  deployedBy!: string;
}

export class RollbackVersionDto {
  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsString()
  @MaxLength(255)
  rolledBackBy!: string;
}
