/**
 * Update System Input DTO
 */
import { InputType, Field, Float, ID, Int, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsString, MinLength, MaxLength, IsEnum } from 'class-validator';
import { CreateSystemInput } from './create-system.input';
import { SystemType, SystemStatus } from '../entities/system.entity';

@InputType()
export class UpdateSystemInput extends PartialType(CreateSystemInput) {
  @Field(() => ID)
  @IsUUID()
  id: string;

  // Override inherited required fields to make them optional for partial updates
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  code?: string;

  @Field(() => SystemType, { nullable: true })
  @IsOptional()
  @IsEnum(SystemType)
  type?: SystemType;

  @Field(() => SystemStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SystemStatus)
  status?: SystemStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
