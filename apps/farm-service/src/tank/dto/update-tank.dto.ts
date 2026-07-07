/**
 * Update Tank DTO
 * @module Tank/DTO
 */
import { InputType, Field, PartialType, ID } from '@nestjs/graphql';
import { IsUUID, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateTankInput } from './create-tank.dto';

@InputType()
export class UpdateTankInput extends PartialType(CreateTankInput) {
  @Field(() => ID)
  @IsUUID()
  @IsNotEmpty()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;
}
