/**
 * @module AiConsentInput
 * @description GraphQL input types for AI privacy consent management.
 * Implements the dual-consent model: tenant-level enable + user-level opt-in.
 * @see ADR-012 section 12.5 (AI Privacy Framework)
 */
import { InputType, Field } from '@nestjs/graphql';
import { IsBoolean } from 'class-validator';

/**
 * Input for updating tenant-level AI analysis setting.
 * Only TENANT_ADMIN can toggle this.
 */
@InputType()
export class UpdateTenantAiSettingInput {
  @Field(() => Boolean, {
    description: 'Enable or disable AI analysis for the entire tenant',
  })
  @IsBoolean()
  enabled: boolean;
}

/**
 * Input for updating user-level AI analysis consent.
 * Each user controls their own opt-in status.
 */
@InputType()
export class UpdateUserAiConsentInput {
  @Field(() => Boolean, {
    description: 'User opt-in consent for AI analysis of their messages',
  })
  @IsBoolean()
  consent: boolean;
}
