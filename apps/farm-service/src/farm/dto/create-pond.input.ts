import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsNumber,
  MinLength,
  MaxLength,
  Min,
  IsUUID,
  IsEnum,
  IsNotEmpty,
} from 'class-validator';
import { WaterType, PondStatus } from '../entities/pond.entity';

/**
 * Create Pond Input DTO
 */
@InputType()
export class CreatePondInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @Field(() => ID)
  @IsUUID()
  farmId: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  capacity: number; // in cubic meters

  @Field(() => WaterType, { nullable: true })
  @IsEnum(WaterType)
  @IsOptional()
  waterType?: WaterType;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  depth?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  surfaceArea?: number;

  @Field(() => PondStatus, { nullable: true })
  @IsEnum(PondStatus)
  @IsOptional()
  status?: PondStatus;
}
