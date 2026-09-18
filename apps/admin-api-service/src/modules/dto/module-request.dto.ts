/**
 * Module catalogue request bodies (CONTRACT-CRITICAL-003).
 *
 * These were `interface`s declared in the controller, which compile to
 * `design:paramtypes = Object`: ValidationPipe skipped them and Swagger
 * emitted an empty schema, so the catalogue accepted any JSON at all. They
 * are classes here so validation and the generated contract describe the same
 * request.
 */
import { TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ModuleQuantitiesDto {
  @IsOptional() @IsInt() @Min(0) users?: number;
  @IsOptional() @IsInt() @Min(0) farms?: number;
  @IsOptional() @IsInt() @Min(0) ponds?: number;
  @IsOptional() @IsInt() @Min(0) sensors?: number;
  @IsOptional() @IsInt() @Min(0) devices?: number;
  @IsOptional() @IsInt() @Min(0) storageGb?: number;
  @IsOptional() @IsInt() @Min(0) apiCalls?: number;
  @IsOptional() @IsInt() @Min(0) alerts?: number;
  @IsOptional() @IsInt() @Min(0) reports?: number;
  @IsOptional() @IsInt() @Min(0) integrations?: number;
}

/**
 * WHY no price field: billing owns all subscription pricing (platform rule
 * D14). Per-module prices are managed through the module-pricing catalog
 * (admin.module_pricing via ModulePricingService), never through the
 * auth.modules catalogue surface.
 */
export class CreateModuleDto {
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z][a-z0-9_-]*$/, {
    message: 'code must be lower-case letters, digits, "_" or "-"',
  })
  code!: string;

  @IsString() @MaxLength(255) name!: string;

  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsString()
  @MaxLength(255)
  @Matches(/^\//, { message: 'defaultRoute must start with "/"' })
  defaultRoute!: string;

  @IsOptional() @IsString() @MaxLength(100) icon?: string;

  @IsOptional() @IsBoolean() isCore?: boolean;
}

export class UpdateModuleDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^\//, { message: 'defaultRoute must start with "/"' })
  defaultRoute?: string;

  @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class AssignModuleDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsUUID('4') moduleId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ModuleQuantitiesDto)
  quantities?: ModuleQuantitiesDto;

  @IsOptional() @IsObject() configuration?: Record<string, unknown>;

  @IsOptional() @Type(() => Date) @IsDate() expiresAt?: Date;
}
