/**
 * Update Chemical Input DTO
 */
import { InputType, Field, ID, PartialType, OmitType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateChemicalInput } from './create-chemical.input';
import { ChemicalStatus, ChemicalType } from '../entities/chemical.entity';

@InputType()
export class UpdateChemicalInput extends PartialType(
  OmitType(CreateChemicalInput, ['siteId'] as const)
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

  @Field(() => ChemicalType, { nullable: true })
  @IsOptional()
  @IsEnum(ChemicalType)
  type?: ChemicalType;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @Field(() => ChemicalStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ChemicalStatus)
  status?: ChemicalStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
