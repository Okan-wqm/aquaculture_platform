import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * class-validator DTOs for the modules control-plane surface.
 *
 * These replace the interface-typed @Body() parameters that erased to metatype
 * Object at runtime, silently bypassing the platform's global
 * ValidationPipe({ whitelist, forbidNonWhitelisted, transform }). Closes
 * APA-067 / APA-076.
 */

export class CreateModuleDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsNotEmpty()
  defaultRoute!: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  isCore?: boolean;
}

export class UpdateModuleDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  defaultRoute?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ModuleQuantitiesDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  users?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  farms?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  ponds?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sensors?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  devices?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  storageGb?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  apiCalls?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  alerts?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  reports?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  integrations?: number;
}

export class AssignModuleDto {
  @IsUUID()
  tenantId!: string;

  @IsUUID()
  moduleId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ModuleQuantitiesDto)
  quantities?: ModuleQuantitiesDto;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown>;

  // Wire type is an ISO-8601 string (JSON has no Date). The service forwards it
  // verbatim to the auth-service assign command — no Date round-trip, so the
  // pre-fix `expiresAt.toISOString()` TypeError (APA-067) is now unrepresentable.
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
