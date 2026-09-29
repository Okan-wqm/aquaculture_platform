/**
 * Update Chemical Input DTO
 */
import { InputType, Field, ID, PartialType, OmitType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsIn, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateChemicalInput } from './create-chemical.input';
import {
  ChemicalStatus,
  ChemicalType,
  CHEMICAL_CLIENT_SETTABLE_STATUSES,
} from '../entities/chemical.entity';

/** Schema description of the lifecycle-only status input (FARM-HIGH-337). */
export const CHEMICAL_STATUS_INPUT_DESCRIPTION =
  'Lifecycle status. Accepts AVAILABLE, EXPIRED or DISCONTINUED. AVAILABLE clears a ' +
  'lifecycle override: the stock band (AVAILABLE / LOW_STOCK / OUT_OF_STOCK) is then ' +
  'derived from storage-ledger stock and minStock. LOW_STOCK and OUT_OF_STOCK are rejected.';
export const CHEMICAL_STATUS_INPUT_MESSAGE =
  'status accepts only AVAILABLE, EXPIRED or DISCONTINUED; LOW_STOCK and OUT_OF_STOCK are derived from stock movements';

@InputType()
export class UpdateChemicalInput extends PartialType(
  OmitType(CreateChemicalInput, ['siteId'] as const)
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

  @Field(() => ChemicalType, { nullable: true })
  @IsOptional()
  @IsEnum(ChemicalType)
  type?: ChemicalType;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  // WHY (FARM-HIGH-337): stock bands are derived from the ledger, so only the
  // lifecycle vocabulary (plus AVAILABLE = "clear the override") is accepted.
  @Field(() => ChemicalStatus, { nullable: true, description: CHEMICAL_STATUS_INPUT_DESCRIPTION })
  @IsOptional()
  @IsIn(CHEMICAL_CLIENT_SETTABLE_STATUSES, { message: CHEMICAL_STATUS_INPUT_MESSAGE })
  status?: ChemicalStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
