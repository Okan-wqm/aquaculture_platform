/**
 * Update Tank Status DTO
 * @module Tank/DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID, IsNotEmpty, IsEnum, IsOptional, IsString } from 'class-validator';
import { TankStatus } from '../entities/tank.entity';

@InputType()
export class UpdateTankStatusInput {
  @Field(() => ID)
  @IsUUID()
  @IsNotEmpty()
  id: string;

  @Field(() => TankStatus)
  @IsEnum(TankStatus)
  @IsNotEmpty()
  status: TankStatus;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  reason?: string;
}
