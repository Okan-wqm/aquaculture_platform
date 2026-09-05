/**
 * Request bodies for `users.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { Query } from '@nestjs/common';
import { PLATFORM_CAPABILITIES, type PlatformCapability } from '@platform/event-contracts';
import { Type } from 'class-transformer';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsEnum,
  MinLength,
  MaxLength,
  IsArray,
  IsInt,
  Min,
  Max,
  Matches,
  IsIn,
  IsISO8601,
} from 'class-validator';

export const ALLOWED_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'email',
  'firstName',
  'lastName',
  'role',
] as const;

export type SortField = (typeof ALLOWED_SORT_FIELDS)[number];

/** ADR-0016 — grant one platform capability. The actor is the verified principal, never a body field. */
export class GrantPlatformCapabilityDto {
  @IsIn(PLATFORM_CAPABILITIES)
  capability!: PlatformCapability;

  /** ISO-8601. Required for `break-glass` (≤ 4 h), optional standing grants otherwise. */
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}

export class RevokePlatformCapabilityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}

export class CreateUserDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsEmail({}, { message: 'Invalid email format' })
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/, {
    message: 'Password must contain uppercase, lowercase, number and special character',
  })
  password!: string;

  @IsString()
  @IsEnum(['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'], {
    message: 'Invalid role',
  })
  role!: string;
}

export class UpdateUserDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @IsEnum(['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'], {
    message: 'Invalid role',
  })
  role?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class InviteUserRequestDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsEmail({}, { message: 'Invalid email format' })
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsString()
  @IsEnum(['TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'], {
    message: 'Invalid role for invitation',
  })
  role!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  moduleIds?: string[];

  @IsOptional()
  @IsUUID('4')
  primaryModuleId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

// Query DTO for list users with validation
export class ListUsersQueryDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsString()
  @IsEnum(['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'])
  role?: string;

  @IsOptional()
  @IsEnum(['active', 'inactive', 'all'])
  status?: 'active' | 'inactive' | 'all';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9@._\-\s]*$/, { message: 'Invalid search characters' })
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @IsEnum(ALLOWED_SORT_FIELDS, { message: 'Invalid sort field' })
  sortBy?: SortField;

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}
