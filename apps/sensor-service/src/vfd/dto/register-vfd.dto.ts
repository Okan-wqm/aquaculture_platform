import { InputType, Field, ID } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsUUID,
  IsObject,
  IsArray,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { VfdBrand, VfdProtocol } from '../entities/vfd.enums';

import { ProtocolConfigurationDto } from './protocol-config.dto';

/**
 * Input DTO for registering a new VFD device
 */
@InputType('RegisterVfdInput')
export class RegisterVfdDto {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field(() => String)
  @IsEnum(VfdBrand)
  brand!: VfdBrand;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serialNumber?: string;

  @Field(() => String)
  @IsEnum(VfdProtocol)
  protocol!: VfdProtocol;

  @Field(() => ProtocolConfigurationDto)
  @IsObject()
  @ValidateNested()
  @Type(() => ProtocolConfigurationDto)
  protocolConfiguration!: ProtocolConfigurationDto;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  farmId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  skipConnectionTest?: boolean;
}

/**
 * Response for VFD registration
 */
export class VfdRegistrationResponseDto {
  device!: {
    id: string;
    name: string;
    brand: VfdBrand;
    protocol: VfdProtocol;
    status: string;
    createdAt: Date;
  };

  connectionTest?: {
    success: boolean;
    latencyMs?: number;
    error?: string;
    sampleData?: Record<string, unknown>;
  };
}
