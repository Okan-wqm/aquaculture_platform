import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsInt,
  IsEnum,
  IsBoolean,
  IsIP,
  Min,
  Max,
  Matches,
  ValidateIf,
} from 'class-validator';

import { VfdProtocol } from '../entities/vfd.enums';

/**
 * Modbus RTU Configuration
 */
@InputType('ModbusRtuConfigInput')
export class ModbusRtuConfigDto {
  @Field()
  @IsString()
  @Matches(/^(COM\d+|\/dev\/tty\w+)$/, {
    message: 'Serial port must be COM* (Windows) or /dev/tty* (Linux)',
  })
  serialPort: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(247)
  slaveId: number;

  @Field(() => Int, { defaultValue: 9600 })
  @IsOptional()
  @IsInt()
  @IsEnum([4800, 9600, 19200, 38400, 57600, 115200])
  baudRate?: number;

  @Field(() => Int, { defaultValue: 8 })
  @IsOptional()
  @IsInt()
  @IsEnum([7, 8])
  dataBits?: number;

  @Field({ defaultValue: 'none' })
  @IsOptional()
  @IsEnum(['none', 'even', 'odd'])
  parity?: 'none' | 'even' | 'odd';

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @IsEnum([1, 2])
  stopBits?: number;

  @Field(() => Int, { defaultValue: 5000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(30000)
  timeout?: number;

  @Field(() => Int, { defaultValue: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  retryCount?: number;
}

/**
 * Modbus TCP Configuration
 */
@InputType('ModbusTcpConfigInput')
export class ModbusTcpConfigDto {
  @Field()
  @IsString()
  host: string;

  @Field(() => Int, { defaultValue: 502 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(255)
  unitId?: number;

  @Field(() => Int, { defaultValue: 5000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(30000)
  connectionTimeout?: number;

  @Field(() => Int, { defaultValue: 5000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(30000)
  responseTimeout?: number;

  @Field({ defaultValue: true })
  @IsOptional()
  @IsBoolean()
  keepAlive?: boolean;
}

/**
 * PROFINET Configuration
 */
@InputType('ProfinetConfigInput')
export class ProfinetConfigDto {
  @Field()
  @IsString()
  deviceName: string;

  @Field()
  @IsString()
  ipAddress: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  subnetMask?: string;

  @Field(() => Int, { defaultValue: 32 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  updateRate?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  gsdmlFile?: string;
}

/**
 * EtherNet/IP Configuration
 */
@InputType('EthernetIpConfigInput')
export class EthernetIpConfigDto {
  @Field()
  @IsString()
  ipAddress: string;

  @Field(() => Int, { defaultValue: 44818 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @Field(() => Int, { defaultValue: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rpi?: number;

  @Field({ defaultValue: 'Class1' })
  @IsOptional()
  @IsString()
  connectionType?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  edsFile?: string;
}

/**
 * CANopen Configuration
 */
@InputType('CanopenConfigInput')
export class CanopenConfigDto {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(127)
  nodeId: number;

  @Field()
  @IsString()
  interface: string;

  @Field(() => Int, { defaultValue: 500000 })
  @IsOptional()
  @IsInt()
  @IsEnum([125000, 250000, 500000, 1000000])
  baudRate?: number;

  @Field(() => Int, { defaultValue: 1000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10000)
  heartbeatProducerTime?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  edsFile?: string;
}

/**
 * BACnet IP Configuration
 */
@InputType('BacnetIpConfigInput')
export class BacnetIpConfigDto {
  @Field()
  @IsString()
  ipAddress: string;

  @Field(() => Int, { defaultValue: 47808 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(4194302)
  deviceInstance: number;

  @Field(() => Int, { defaultValue: 1476 })
  @IsOptional()
  @IsInt()
  @Min(128)
  @Max(1476)
  maxApduLength?: number;
}

/**
 * BACnet MS/TP Configuration
 */
@InputType('BacnetMstpConfigInput')
export class BacnetMstpConfigDto {
  @Field()
  @IsString()
  serialPort: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(127)
  macAddress: number;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  @Max(4194302)
  deviceInstance: number;

  @Field(() => Int, { defaultValue: 76800 })
  @IsOptional()
  @IsInt()
  baudRate?: number;
}

/**
 * PROFIBUS DP Configuration
 */
@InputType('ProfibusDpConfigInput')
export class ProfibusDpConfigDto {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(126)
  stationAddress: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(126)
  masterAddress?: number;

  @Field(() => Int, { defaultValue: 1500000 })
  @IsOptional()
  @IsInt()
  baudRate?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  gsdFile?: string;
}

/**
 * Union type DTO for protocol configuration
 * Validated based on the selected protocol
 */
@InputType('ProtocolConfigurationInput')
export class ProtocolConfigurationDto {
  // Modbus RTU fields
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  serialPort?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(247)
  slaveId?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  baudRate?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  dataBits?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  parity?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  stopBits?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  timeout?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  retryCount?: number;

  // Modbus TCP / EtherNet/IP fields
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  host?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  unitId?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  connectionTimeout?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  responseTimeout?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  keepAlive?: boolean;

  // PROFINET fields
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  deviceName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  subnetMask?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  updateRate?: number;

  // CANopen fields
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(127)
  nodeId?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  interface?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  heartbeatProducerTime?: number;

  // BACnet fields
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  deviceInstance?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  maxApduLength?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  macAddress?: number;

  // PROFIBUS DP fields
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  stationAddress?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  masterAddress?: number;

  // Common file fields
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  gsdFile?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  gsdmlFile?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  edsFile?: string;

  // EtherNet/IP specific
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  rpi?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  connectionType?: string;
}

/**
 * Input for testing connection configuration
 */
@InputType('TestVfdConnectionConfigInput')
export class TestVfdConnectionConfigDto {
  @Field(() => String)
  @IsEnum(VfdProtocol)
  protocol: VfdProtocol;

  @Field(() => ProtocolConfigurationDto)
  configuration: ProtocolConfigurationDto;

  @Field(() => String, { nullable: true })
  @IsOptional()
  brand?: string;
}
