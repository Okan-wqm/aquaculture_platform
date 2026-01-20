/**
 * Update Species DTO
 * @module Species/DTO
 */
import { InputType, Field, PartialType, ID } from '@nestjs/graphql';
import { IsUUID, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength, IsEnum, IsBoolean, IsArray } from 'class-validator';
import { CreateSpeciesInput } from './create-species.dto';
import { SpeciesCategory, SpeciesWaterType, SpeciesStatus } from '../entities/species.entity';

@InputType()
export class UpdateSpeciesInput extends PartialType(CreateSpeciesInput) {
  @Field(() => ID)
  @IsUUID()
  @IsNotEmpty()
  id: string;

  // Override inherited required fields to make them optional for partial updates
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  scientificName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  commonName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code?: string;

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
   * Tür etiketleri - Filtreleme ve kategorize etme için
   * Predefined: smolt, cleaner-fish, broodstock, fry, fingerling, grower, market-size, organic, certified
   * Custom tag'ler de eklenebilir
   */
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
