/**
 * Chemical Filter Input DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { ChemicalType, ChemicalStatus } from '../entities/chemical.entity';

@InputType()
export class ChemicalFilterInput {
  @Field(() => ChemicalType, { nullable: true })
  @IsOptional()
  @IsEnum(ChemicalType)
  type?: ChemicalType;

  @Field(() => ChemicalStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ChemicalStatus)
  status?: ChemicalStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter chemicals assigned to a site' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
