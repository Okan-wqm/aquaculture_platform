import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, IsBoolean, IsOptional } from 'class-validator';

/**
 * Per-feature toggle fields shared by the single-user and bulk update inputs.
 *
 * WHY abstract base: the flag vocabulary must match MobileAllowedFeatures
 * (mobile-user-settings.entity.ts) 1:1. Before FARM-HIGH-214 the two input
 * types each hand-copied a 7-flag subset — transfer/schedule/attendance/
 * leave/tasks were never admin-settable via the API (part of the
 * FARM-MEDIUM-215 drift). One base class means a new feature flag is added in
 * exactly one place per layer.
 */
@InputType({ isAbstract: true })
abstract class MobileFeatureTogglesInput {
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  mortality?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  cull?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  harvest?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  feeding?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  waterQuality?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  tankView?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  transfer?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  schedule?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  attendance?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  leave?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  tasks?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  storage?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  liceCount?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  welfare?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  escape?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  reports?: boolean;
}

@InputType()
export class UpdateMobileUserSettingsInput extends MobileFeatureTogglesInput {
  @Field(() => ID)
  @IsUUID()
  userId!: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isMobileEnabled?: boolean;
}

@InputType()
export class BulkUpdateMobileSettingsInput extends MobileFeatureTogglesInput {
  @Field(() => [ID])
  userIds!: string[];

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isMobileEnabled?: boolean;
}
