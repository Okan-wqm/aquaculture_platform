/**
 * Update Consumable Input DTO
 */
import { InputType, Field, ID, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateConsumableInput } from './create-consumable.input';
import { ConsumableCategory, ConsumableStatus } from '../entities/consumable.entity';

@InputType()
export class UpdateConsumableInput extends PartialType(CreateConsumableInput) {
  @Field(() => ID)
  @IsUUID()
  id!: string;

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

  @Field(() => ConsumableCategory, { nullable: true })
  @IsOptional()
  @IsEnum(ConsumableCategory)
  category?: ConsumableCategory;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @Field(() => ConsumableStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ConsumableStatus)
  status?: ConsumableStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
