/**
 * Species Filter DTO
 * @module Species/DTO
 */
import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsArray,
  Min,
  Max,
} from 'class-validator';
import { SpeciesCategory, SpeciesWaterType, SpeciesStatus } from '../entities/species.entity';

@InputType()
export class SpeciesFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => SpeciesCategory, { nullable: true })
  @IsOptional()
  @IsEnum(SpeciesCategory)
  category?: SpeciesCategory;

  @Field(() => SpeciesWaterType, { nullable: true })
  @IsOptional()
  @IsEnum(SpeciesWaterType)
  waterType?: SpeciesWaterType;

  @Field(() => SpeciesStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SpeciesStatus)
  status?: SpeciesStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Tag bazlı filtreleme
   * Örnek: ['cleaner-fish'] - Sadece cleaner-fish tag'li türleri getirir
   * Birden fazla tag verilebilir (OR mantığı)
   */
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /**
   * Cleaner fish filtreleme (backward compatibility)
   */
  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isCleanerFish?: boolean;

  @Field(() => Int, { defaultValue: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  offset?: number;

  @Field(() => Int, { defaultValue: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field({ defaultValue: 'commonName' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @Field({ defaultValue: 'ASC' })
  @IsOptional()
  @IsString()
  sortOrder?: 'ASC' | 'DESC';
}
