/**
 * Feed Filter Input DTO
 */
import { InputType, Field, ID, Float } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID, IsNumber } from 'class-validator';
import { FeedType, FeedStatus, FloatingType } from '../entities/feed.entity';

@InputType()
export class FeedFilterInput {
  @Field(() => FeedType, { nullable: true })
  @IsOptional()
  @IsEnum(FeedType)
  type?: FeedType;

  @Field(() => FeedStatus, { nullable: true })
  @IsOptional()
  @IsEnum(FeedStatus)
  status?: FeedStatus;

  @Field(() => FloatingType, { nullable: true })
  @IsOptional()
  @IsEnum(FloatingType)
  floatingType?: FloatingType;

  @Field(() => Float, { nullable: true, description: 'Filter by pellet size in mm' })
  @IsOptional()
  @IsNumber()
  pelletSize?: number;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter feeds assigned to a site' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter feeds mapped to a species via feed_type_species' })
  @IsOptional()
  @IsUUID()
  speciesId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  targetSpecies?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
