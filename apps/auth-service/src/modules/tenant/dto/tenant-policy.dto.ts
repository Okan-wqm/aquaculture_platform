import { InputType, Field, ObjectType, Int, registerEnumType } from '@nestjs/graphql';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidationOptions,
  buildMessage,
} from 'class-validator';

import { TENANT_DATE_FORMATS, TenantDateFormat } from '../entities/tenant.entity';

/**
 * ADR-045 — tenant auth-security policy + localization preferences surface.
 *
 * Two deliberately SEPARATE containers: the security policy (enforced by the
 * login gate + refresh-TTL clamp) and the localization preferences
 * (timezone/dateFormat, display-only). tenantId is never an input on any of
 * these — it always comes from the caller's JWT (@CurrentUser).
 */

/** GraphQL enum over the closed date-format vocabulary (SSoT: tenant.entity.ts). */
export enum TenantDateFormatEnum {
  DD_MM_YYYY = 'DD/MM/YYYY',
  MM_DD_YYYY = 'MM/DD/YYYY',
  YYYY_MM_DD = 'YYYY-MM-DD',
}

registerEnumType(TenantDateFormatEnum, {
  name: 'TenantDateFormat',
  description: 'Tenant date-format preference (ADR-045)',
});

/**
 * IANA-timezone sanity validator (ADR-045).
 *
 * Tier-1 placement: validation lives ON the input DTO, so an invalid zone can
 * never reach the service. `Intl.DateTimeFormat` is the runtime's own tz
 * database — the same authority every renderer will use — so "valid here"
 * is exactly "renderable everywhere" (no hand-rolled allowlist to drift).
 */
export function isValidIanaTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function IsIanaTimezone(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isIanaTimezone',
      validator: {
        validate: (value): boolean => isValidIanaTimezone(value),
        defaultMessage: buildMessage(
          (eachPrefix) => `${eachPrefix}$property must be a valid IANA timezone (e.g. Europe/Istanbul)`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

// ============================================================================
// Security policy (enforced — ADR-045)
// ============================================================================

@ObjectType()
export class TenantSecurityPolicy {
  /**
   * EFFECTIVE enforcement flag: the nullable enforce_mfa column collapsed to
   * its enforced meaning (NULL → false), so consumers never re-implement the
   * default.
   */
  @Field(() => Boolean)
  enforceMfa!: boolean;

  /** Idle-session timeout in minutes; null = configured platform TTL applies. */
  @Field(() => Int, { nullable: true })
  sessionTimeoutMinutes!: number | null;
}

@InputType()
export class UpdateTenantSecurityPolicyInput {
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  enforceMfa?: boolean;

  /**
   * 5..1440 (5 minutes to 24 hours): below 5 turns every silent refresh into a
   * logout; above a day is no longer an IDLE timeout.
   */
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  sessionTimeoutMinutes?: number;
}

// ============================================================================
// Localization preferences (display-only — separate from security by design)
// ============================================================================

@ObjectType()
export class TenantLocalizationPreferences {
  @Field(() => String, { nullable: true })
  timezone!: string | null;

  @Field(() => TenantDateFormatEnum, { nullable: true })
  dateFormat!: TenantDateFormat | null;
}

@InputType()
export class UpdateTenantLocalizationPreferencesInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  // Shape sanity BEFORE the tz-database check: IANA ids are /-separated
  // ASCII segments (plus legacy aliases like 'UTC').
  @Matches(/^[A-Za-z0-9_+/-]+$/, {
    message: 'timezone must be an IANA timezone identifier',
  })
  @IsIanaTimezone()
  timezone?: string;

  @Field(() => TenantDateFormatEnum, { nullable: true })
  @IsOptional()
  @IsIn(TENANT_DATE_FORMATS)
  dateFormat?: TenantDateFormat;
}
