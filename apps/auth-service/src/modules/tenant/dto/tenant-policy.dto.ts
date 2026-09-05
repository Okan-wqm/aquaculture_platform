import { InputType, Field, ObjectType, Int } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * ADR-046 — tenant auth-security policy surface.
 *
 * SECURITY ONLY. Tenant localization (timezone / locale) is a different
 * authority with its own surface (`updateTenantLocalization`, written through
 * the tenant command-receipt path and fanned out on `TenantUpdated`); folding
 * it into a "security config" container is exactly the split-brain ADR-046
 * forbids.
 *
 * `tenantId` is never an input on this surface — it always comes from the
 * caller's JWT (`@CurrentUser`), so a TENANT_ADMIN can only ever read or write
 * their OWN tenant's policy.
 */

@ObjectType()
export class TenantSecurityPolicy {
  /**
   * EFFECTIVE enforcement flag: the nullable `enforce_mfa` column collapsed to
   * its enforced meaning (NULL → false) so consumers never re-implement the
   * default.
   */
  @Field(() => Boolean)
  enforceMfa!: boolean;

  /** Idle-session timeout in minutes; null = the configured platform TTL applies. */
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
   * 5..1440 (5 minutes to 24 hours): below 5 every silent refresh becomes a
   * logout; above a day it is no longer an IDLE timeout. The same bound is a
   * CHECK constraint on `auth.tenants` so the store rejects an out-of-range
   * value even if it never passed through this DTO.
   */
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  sessionTimeoutMinutes?: number;
}
