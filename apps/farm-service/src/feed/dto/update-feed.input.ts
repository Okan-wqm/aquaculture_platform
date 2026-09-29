/**
 * Update Feed Input DTO
 */
import { InputType, Field, ID, PartialType, OmitType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsIn, IsString, MinLength, MaxLength } from 'class-validator';
import {
  CreateFeedInput,
  FEED_STATUS_INPUT_DESCRIPTION,
  FEED_STATUS_INPUT_MESSAGE,
} from './create-feed.input';
import { FeedStatus, FeedType, FEED_CLIENT_SETTABLE_STATUSES } from '../entities/feed.entity';

@InputType()
export class UpdateFeedInput extends PartialType(
  OmitType(CreateFeedInput, ['siteId', 'speciesMappings'] as const)
) {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  // Override inherited required fields to make them optional for partial updates
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code?: string;

  @Field(() => FeedType, { nullable: true })
  @IsOptional()
  @IsEnum(FeedType)
  type?: FeedType;

  // WHY (FARM-HIGH-337): a re-declared property shadows the inherited
  // validator, so the lifecycle-only rule is restated here, not inherited.
  // `quantity` is absent: CreateFeedInput no longer carries it.
  @Field(() => FeedStatus, { nullable: true, description: FEED_STATUS_INPUT_DESCRIPTION })
  @IsOptional()
  @IsIn(FEED_CLIENT_SETTABLE_STATUSES, { message: FEED_STATUS_INPUT_MESSAGE })
  status?: FeedStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
