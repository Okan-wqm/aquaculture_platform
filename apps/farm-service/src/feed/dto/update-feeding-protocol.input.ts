/**
 * Update Feeding Protocol Input DTO
 */
import { InputType, Field, ID, PartialType, OmitType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateFeedingProtocolInput } from './create-feeding-protocol.input';
import { FeedType } from '../entities/feed.entity';

@InputType()
export class UpdateFeedingProtocolInput extends PartialType(CreateFeedingProtocolInput) {
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
  @MaxLength(100)
  species?: string;

  @Field(() => FeedType, { nullable: true })
  @IsOptional()
  @IsEnum(FeedType)
  stage?: FeedType;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
