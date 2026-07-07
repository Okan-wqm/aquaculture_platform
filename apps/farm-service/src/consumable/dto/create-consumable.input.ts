/**
 * Create Consumable Input DTO
 */
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, MinLength, IsEnum, IsUUID } from 'class-validator';
import { ConsumableCategory } from '../entities/consumable.entity';

@InputType()
export class CreateConsumableInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code!: string;

  @Field(() => ConsumableCategory)
  @IsEnum(ConsumableCategory)
  category!: ConsumableCategory;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(20)
  unit!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  quantity?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minStock?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  // Storage conditions
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  storageTempMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  storageTempMax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  storageHumidityMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  storageHumidityMax?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  storageRequirements?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
