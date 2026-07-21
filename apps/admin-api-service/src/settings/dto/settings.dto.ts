import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsObject,
  IsEmail,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
  ValidateNested,
  IsInt,
  IsIP,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================================
// Bulk Update
// ============================================================================

class SettingUpdateItem {
  @IsString()
  @MaxLength(255)
  key!: string;

  @IsString()
  @MaxLength(10000)
  value!: string;
}

export class BulkUpdateSettingsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SettingUpdateItem)
  updates!: SettingUpdateItem[];
}

// ============================================================================
// Email Config
// ============================================================================

export class UpdateEmailConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  smtpHost?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  smtpPort?: number;

  @IsOptional()
  @IsBoolean()
  smtpSecure?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  smtpUsername?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  smtpPassword?: string;

  @IsOptional()
  @IsEmail()
  fromAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fromName?: string;
}

// ============================================================================
// Maintenance Mode
// ============================================================================

export class SetMaintenanceModeDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100)
  allowedIps?: string[];
}

// ============================================================================
// Billing Config
// ============================================================================

export class UpdateBillingConfigDto {
  @IsOptional()
  @IsBoolean()
  stripeEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  defaultCurrency?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  invoiceDueDays?: number;
}

// ============================================================================
// Import Settings
// ============================================================================

export class ImportSettingsDto {
  @IsObject()
  data!: Record<string, unknown>;
}

// ============================================================================
// System Setting Update
// ============================================================================

/**
 * Body for `PUT /settings/key/:key`. A class (not a service interface) so the
 * global ValidationPipe engages on this body (APA-364). `updatedBy` is sourced
 * from the JWT in the controller; it is whitelisted here only so a stray client
 * value is dropped rather than triggering forbidNonWhitelisted before the
 * controller overrides it.
 */
export class UpdateSystemSettingDto {
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  value?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresRestart?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  updatedBy?: string;
}
