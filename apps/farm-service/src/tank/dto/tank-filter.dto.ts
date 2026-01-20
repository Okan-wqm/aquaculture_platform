/**
 * Tank Filter DTO
 * @module Tank/DTO
 */
import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsUUID,
  Min,
  Max,
} from 'class-validator';
import { TankType, TankMaterial, WaterType, TankStatus } from '../entities/tank.entity';

@InputType()
export class TankFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => TankType, { nullable: true })
  @IsOptional()
  @IsEnum(TankType)
  tankType?: TankType;

  @Field(() => TankMaterial, { nullable: true })
  @IsOptional()
  @IsEnum(TankMaterial)
  material?: TankMaterial;

  @Field(() => WaterType, { nullable: true })
  @IsOptional()
  @IsEnum(WaterType)
  waterType?: WaterType;

  @Field(() => TankStatus, { nullable: true })
  @IsOptional()
  @IsEnum(TankStatus)
  status?: TankStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  hasAvailableCapacity?: boolean;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  minVolume?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  maxVolume?: number;

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

  @Field({ defaultValue: 'name' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @Field({ defaultValue: 'ASC' })
  @IsOptional()
  @IsString()
  sortOrder?: 'ASC' | 'DESC';
}
