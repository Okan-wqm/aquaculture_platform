/**
 * Update Supplier Input DTO
 */
import { InputType, Field, ID, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateSupplierInput } from './create-supplier.input';
import { SupplierStatus, SupplierType } from '../entities/supplier.entity';

@InputType()
export class UpdateSupplierInput extends PartialType(CreateSupplierInput) {
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

  @Field(() => SupplierType, { nullable: true })
  @IsOptional()
  @IsEnum(SupplierType)
  type?: SupplierType;

  @Field(() => SupplierStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SupplierStatus)
  status?: SupplierStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
