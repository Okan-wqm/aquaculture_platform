/**
 * Create Supplier Input DTO
 */
import { InputType, Field, Float, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, IsEmail, MaxLength, MinLength, IsEnum, IsArray, ValidateNested, IsUrl } from 'class-validator';
import { Type } from 'class-transformer';
import { SupplierType } from '../entities/supplier.entity';

@InputType()
export class SupplierContactInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  department?: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  isPrimary?: boolean;
}

@InputType()
export class SupplierAddressInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  street?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  city: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  country: string;
}

@InputType()
export class PaymentTermsInput {
  @Field(() => Int)
  @IsNumber()
  paymentDays: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  creditLimit?: number;

  @Field({ defaultValue: 'TRY' })
  @IsString()
  @MaxLength(3)
  currency: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  discountPercent?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  discountDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class CreateSupplierInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code: string;

  @Field(() => SupplierType)
  @IsEnum(SupplierType)
  type: SupplierType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  categories?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  products?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactPerson?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @Field(() => SupplierContactInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SupplierContactInput)
  primaryContact?: SupplierContactInput;

  @Field(() => [SupplierContactInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SupplierContactInput)
  contacts?: SupplierContactInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  fax?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @Field(() => SupplierAddressInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SupplierAddressInput)
  address?: SupplierAddressInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxNumber?: string;

  @Field(() => PaymentTermsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentTermsInput)
  paymentTerms?: PaymentTermsInput;

  @Field(() => Float, { nullable: true, description: 'Rating 0-5' })
  @IsOptional()
  @IsNumber()
  rating?: number;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  certifications?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
