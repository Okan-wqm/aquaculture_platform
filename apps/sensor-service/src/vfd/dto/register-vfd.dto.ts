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
  modelSeries?: string;

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

  /**
   * The farm `equipment.id` this drive actuates — a feeder, a water pump, a
   * blower, anything with a motor. Optional at registration (a drive can be
   * catalogued before it is wired to anything), but a drive that has not been
   * bound cannot be commanded.
   *
   * Replaces the former `tankId` and `pumpId`. Those asked the operator to type a
   * uuid nothing ever checked, and `pumpId` could only express one of the several
   * things a drive actually drives. This id is confirmed by the service that owns
   * equipment before the drive will act on it.
   */
  @Field(() => ID, {
    nullable: true,
    description: 'farm equipment.id this drive actuates (feeder, pump, blower, …)',
  })
  @IsOptional()
  @IsUUID()
  drivenEquipmentId?: string;

  // SENSOR-CRITICAL-007: edge-delegated write binding. Provide both together —
  // the owning edge gateway (edgeDeviceId) and the Modbus `device` name it
  // exposes for this drive (edgeModbusDeviceName). Enforced both-or-neither by
  // the service so a half-bound drive can never be dispatched to.
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  edgeDeviceId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  edgeModbusDeviceName?: string;

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
