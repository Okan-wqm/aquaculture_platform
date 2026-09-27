/**
 * Messaging admin request bodies (CONTRACT-CRITICAL-003).
 *
 * Declared as `interface`s in the controller until now, which left
 * ValidationPipe with nothing to check: a legal hold could be opened with an
 * empty reason and a retention policy set to any number at all, on the
 * surface that decides how long a tenant's messages survive.
 */
import { TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateIf,
} from 'class-validator';

export class CreateLegalHoldDto {
  /** null means the hold covers every channel of the tenant. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  channelId?: string | null;

  @IsString() @MinLength(10) @MaxLength(2000) reason!: string;

  @IsString() @MinLength(1) @MaxLength(120) legalMatterId!: string;

  @IsOptional() @IsString() @MaxLength(2000) legalMatterDescription?: string;

  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class UpdateRetentionPolicyDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam. */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  /** null means the policy applies to every channel of the tenant. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('4')
  channelId?: string | null;

  /**
   * The retention window in days: `-1` for indefinite, otherwise one day to
   * ten years. A retention window is a compliance decision, not a free
   * integer — hence the ceiling — but `@Min(1)` made INDEFINITE unreachable
   * (ADMIN-CRITICAL-151). `RetentionPolicy.retentionDays` documents `-1` as
   * indefinite and `executeRetentionCleanup` skips those policies
   * (`retention-policy.service.ts:221`), so the state exists, the nightly job
   * honours it, and only this validator stood between an operator and setting
   * it. `@NotEquals(0)` keeps the one meaningless value out: zero days would
   * ask the cleanup to delete everything the moment it runs.
   */
  @IsInt() @Min(-1) @NotEquals(0) @Max(3650) retentionDays!: number;
}

export class TriggerExportDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam. */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsOptional() @IsIn(['csv', 'json']) format?: 'csv' | 'json';
}
