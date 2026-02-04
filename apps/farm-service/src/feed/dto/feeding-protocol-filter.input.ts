/**
 * Feeding Protocol Filter Input DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { FeedType } from '../entities/feed.entity';

@InputType()
export class FeedingProtocolFilterInput {
  @Field(() => FeedType, { nullable: true, description: 'Filter by feed stage/type' })
  @IsOptional()
  @IsEnum(FeedType)
  stage?: FeedType;

  @Field({ nullable: true, description: 'Filter by species name' })
  @IsOptional()
  @IsString()
  species?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by associated feed' })
  @IsOptional()
  @IsUUID()
  feedId?: string;

  @Field({ nullable: true, description: 'Filter by active status' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'Filter default protocols only' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @Field({ nullable: true, description: 'Search by name or description' })
  @IsOptional()
  @IsString()
  search?: string;
}
