/**
 * Consumable Filter Input DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { ConsumableCategory, ConsumableStatus } from '../entities/consumable.entity';

@InputType()
export class ConsumableFilterInput {
  @Field(() => ConsumableCategory, { nullable: true })
  @IsOptional()
  @IsEnum(ConsumableCategory)
  category?: ConsumableCategory;

  @Field(() => ConsumableStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ConsumableStatus)
  status?: ConsumableStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
