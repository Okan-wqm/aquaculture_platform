/**
 * @module AiConsentInput
 * @description GraphQL input types for AI privacy consent management.
 * Implements the dual-consent model: tenant-level enable + user-level opt-in.
 * @see ADR-012 section 12.5 (AI Privacy Framework)
 */
import { InputType, Field } from '@nestjs/graphql';
import { IsBoolean } from 'class-validator';

// UpdateTenantAiSettingInput removed — tenant AI enablement is owned by ai-service
// (updateAiProviderSettings.isEnabled); messaging keeps only user-level consent.

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
