/**
 * Update Feed Input DTO
 */
import { InputType, Field, ID, PartialType, OmitType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateFeedInput } from './create-feed.input';
import { FeedStatus, FeedType } from '../entities/feed.entity';

@InputType()
export class UpdateFeedInput extends PartialType(
  OmitType(CreateFeedInput, ['siteId', 'speciesMappings'] as const)
) {
  @Field(() => ID)
  @IsUUID()
  id: string;

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

  @Field(() => FeedStatus, { nullable: true })
  @IsOptional()
  @IsEnum(FeedStatus)
  status?: FeedStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
