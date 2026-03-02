import {
  InputType,
  Field,
  Int,
  Float,
  ObjectType,
  ID,
} from '@nestjs/graphql';
import { IsUUID, IsBoolean } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import {
  DeviceIoConfig,
  IoType,
  IoDataType,
} from '../entities/device-io-config.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeDevice,
} from '../entities/edge-device.entity';

// Re-export enums for GraphQL schema
export { DeviceLifecycleState, DeviceModel };

/**
 * Input for registering a new edge device
 */
@InputType()
export class RegisterEdgeDeviceInput {
  @Field({ nullable: true })
  siteId?: string;

  @Field()
  deviceCode!: string;

  @Field()
  deviceName!: string;

  @Field(() => DeviceModel)
  deviceModel!: DeviceModel;

  @Field({ nullable: true })
  serialNumber?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  timezone?: string;
}

/**
 * Input for updating an edge device
 */
@InputType()
export class UpdateEdgeDeviceInput {
  @Field({ nullable: true })
  deviceName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  timezone?: string;

  @Field(() => Int, { nullable: true })
  scanRateMs?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  config?: Record<string, unknown>;

  @Field(() => GraphQLJSON, { nullable: true })
  capabilities?: Record<string, boolean>;

  @Field(() => [String], { nullable: true })
  tags?: string[];
}

/**
 * Input for adding I/O configuration
 */
@InputType()
export class AddIoConfigInput {
  @Field()
  tagName!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => IoType)
  ioType!: IoType;

  @Field(() => IoDataType)
  dataType!: IoDataType;

  @Field(() => Int)
  moduleAddress!: number;

  @Field(() => Int)
  channel!: number;

  @Field(() => Float, { nullable: true })
  rawMin?: number;

  @Field(() => Float, { nullable: true })
  rawMax?: number;

  @Field(() => Float, { nullable: true })
  engMin?: number;

  @Field(() => Float, { nullable: true })
  engMax?: number;

  @Field({ nullable: true })
  engUnit?: string;

  @Field(() => Int, { nullable: true })
  modbusFunction?: number;

  @Field(() => Int, { nullable: true })
  modbusSlaveId?: number;

  @Field(() => Int, { nullable: true })
  modbusRegister?: number;

  @Field(() => Int, { nullable: true })
  gpioPin?: number;

  @Field({ nullable: true })
  gpioMode?: string;

  @Field({ nullable: true })
  busType?: string;

  @Field(() => Int, { nullable: true })
  i2cBus?: number;

  @Field(() => Int, { nullable: true })
  i2cAddress?: number;

  @Field(() => Int, { nullable: true })
  spiBus?: number;

  @Field(() => Int, { nullable: true })
  spiCs?: number;

  @Field({ nullable: true })
  uartPort?: string;

  @Field({ nullable: true })
  invertValue?: boolean;

  @Field(() => Float, { nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  deadband?: number;
}

/**
 * Input for updating I/O configuration
 */
@InputType()
export class UpdateIoConfigInput {
  @Field({ nullable: true })
  description?: string;

  @Field(() => Float, { nullable: true })
  rawMin?: number;

  @Field(() => Float, { nullable: true })
  rawMax?: number;

  @Field(() => Float, { nullable: true })
  engMin?: number;

  @Field(() => Float, { nullable: true })
  engMax?: number;

  @Field({ nullable: true })
  engUnit?: string;

  @Field({ nullable: true })
  invertValue?: boolean;

  @Field(() => Float, { nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  deadband?: number;

  @Field({ nullable: true })
  isActive?: boolean;
}

/**
 * Edge device connection (paginated list)
 */
@ObjectType()
export class EdgeDeviceConnection {
  @Field(() => [EdgeDevice])
  items!: EdgeDevice[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;
}

/**
 * State count for statistics
 */
@ObjectType()
export class StateCount {
  @Field(() => DeviceLifecycleState)
  state!: DeviceLifecycleState;

  @Field(() => Int)
  count!: number;
}

/**
 * Model count for statistics
 */
@ObjectType()
export class ModelCount {
  @Field(() => DeviceModel)
  model!: DeviceModel;

  @Field(() => Int)
  count!: number;
}

/**
 * Edge device statistics
 */
@ObjectType()
export class EdgeDeviceStats {
  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  online!: number;

  @Field(() => Int)
  offline!: number;

  @Field(() => [StateCount])
  byState!: StateCount[];

  @Field(() => [ModelCount])
  byModel!: ModelCount[];
}

/**
 * Ping result from edge device
 */
@ObjectType()
export class PingResult {
  @Field()
  success!: boolean;

  @Field(() => Int, { nullable: true, description: 'Round-trip latency in milliseconds' })
  latencyMs?: number;

  @Field({ description: 'Device code that was pinged' })
  deviceCode!: string;

  @Field({ description: 'Timestamp of ping result' })
  timestamp!: Date;

  @Field({ nullable: true, description: 'Error message if ping failed' })
  error?: string;
}

/**
 * Result of pushing I/O config to a device
 */
@ObjectType()
export class PushIoConfigResult {
  @Field()
  success!: boolean;

  @Field({ nullable: true, description: 'Error message if push failed' })
  error?: string;
}

/**
 * setDigitalOutput Mutation Input/Result
 * -----------------------------------------------------------------------
 * Process editor'dan DO (Digital Output) tag'ini ON/OFF yapmak için
 * kullanılır. Güvenlik: sadece DO tipi tag'lere izin verir,
 * device online olmalı, MQTT üzerinden edge agent'a gönderilir.
 * -----------------------------------------------------------------------
 */
@InputType()
export class SetDigitalOutputInput {
  /** Edge device UUID — class-validator ile format doğrulaması yapılır */
  @Field(() => ID)
  @IsUUID('4', { message: 'deviceId must be a valid UUID v4' })
  deviceId!: string;

  /** DeviceIoConfig UUID — DO tipinde olmalı, service katmanında kontrol edilir */
  @Field(() => ID)
  @IsUUID('4', { message: 'ioConfigId must be a valid UUID v4' })
  ioConfigId!: string;

  /** true = ON, false = OFF — fiziksel çıkışı kontrol eder */
  @Field()
  @IsBoolean({ message: 'value must be a boolean (true/false)' })
  value!: boolean;
}

@ObjectType()
export class SetDigitalOutputResult {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  error?: string;

  @Field({ nullable: true })
  tagName?: string;

  @Field({ nullable: true })
  value?: boolean;
}

// ==================== I/O Auto-Detection (v2.3) ====================

@ObjectType()
export class I2cDeviceInfo {
  @Field(() => Int, { description: 'I2C device address (0x03-0x77)' })
  address!: number;

  @Field({ description: 'Hex representation of address (e.g. "0x76")' })
  addressHex!: string;

  @Field({ nullable: true, description: 'Known device name (e.g. "BME280")' })
  deviceName?: string;

  @Field({ nullable: true, description: 'Device description' })
  deviceDescription?: string;
}

@ObjectType()
export class I2cBusScanInfo {
  @Field(() => Int, { description: 'I2C bus number (e.g. 0 or 1)' })
  bus!: number;

  @Field(() => Int, { description: 'Number of devices found on this bus' })
  deviceCount!: number;

  @Field(() => [I2cDeviceInfo], { description: 'Devices found on this bus' })
  devices!: I2cDeviceInfo[];
}

@ObjectType()
export class SpiBusInfo {
  @Field({ description: 'Device path (e.g. "/dev/spidev0.0")' })
  devicePath!: string;

  @Field(() => Int, { description: 'SPI bus number' })
  bus!: number;

  @Field(() => Int, { description: 'Chip select number' })
  chipSelect!: number;
}

@ObjectType()
export class UartPortInfo {
  @Field({ description: 'Device path (e.g. "/dev/ttyAMA0")' })
  devicePath!: string;

  @Field({ description: 'Port type: hardware, software, usb-serial, usb-acm' })
  portType!: string;
}

/**
 * A single I/O channel discovered via hardware scan.
 * Maps to the Rust agent's `DiscoveredIo` struct.
 * Frontend uses this to display scan results in AutoDetectResultsPanel.
 */
@ObjectType()
export class DiscoveredIoChannel {
  @Field({ description: 'Auto-generated tag name (e.g. "DI_01", "GPIO_17")' })
  tagName!: string;

  @Field({ description: 'I/O type: DI, DO, AI, AO' })
  ioType!: string;

  @Field({ description: 'Data type: BOOL, INT16, INT32, FLOAT32 etc.' })
  dataType!: string;

  @Field(() => Int, { description: 'Module address (piControl byte offset or GPIO chip base)' })
  moduleAddress!: number;

  @Field(() => Int, { description: 'Channel/pin number within the module' })
  channel!: number;

  @Field({ nullable: true, description: 'Human-readable description' })
  description?: string;

  @Field(() => Int, { nullable: true, description: 'GPIO pin number (RPi only)' })
  gpioPin?: number;

  @Field({ description: 'Discovery source: picontrol, gpiochip, sysfs' })
  source!: string;

  @Field({ nullable: true, description: 'Bus type: i2c, spi, uart' })
  busType?: string;

  @Field(() => Int, { nullable: true, description: 'I2C bus number' })
  i2cBus?: number;

  @Field(() => Int, { nullable: true, description: 'I2C device address' })
  i2cAddress?: number;

  @Field({ nullable: true, description: 'Known I2C device name' })
  i2cDeviceName?: string;

  @Field(() => Int, { nullable: true, description: 'SPI bus number' })
  spiBus?: number;

  @Field(() => Int, { nullable: true, description: 'SPI chip select' })
  spiCs?: number;

  @Field({ nullable: true, description: 'UART port path' })
  uartPort?: string;
}

/**
 * Result of a hardware scan command sent to an edge device.
 * Returned by the `scanEdgeDeviceHardware` mutation.
 */
@ObjectType()
export class HardwareScanResultType {
  @Field({ description: 'Whether the scan completed successfully' })
  success!: boolean;

  @Field({ nullable: true, description: 'Error message if scan failed' })
  error?: string;

  @Field({ description: 'Detected platform: RevolutionPi, RaspberryPi, GenericLinux, Unknown' })
  platform!: string;

  @Field(() => [DiscoveredIoChannel], { description: 'Discovered I/O channels' })
  discoveredChannels!: DiscoveredIoChannel[];

  @Field(() => Int, { description: 'Total number of I/O channels found' })
  totalFound!: number;

  @Field(() => [I2cBusScanInfo], { nullable: true, description: 'I2C bus scan results' })
  i2cBuses?: I2cBusScanInfo[];

  @Field(() => [SpiBusInfo], { nullable: true, description: 'SPI bus info' })
  spiBuses?: SpiBusInfo[];

  @Field(() => [UartPortInfo], { nullable: true, description: 'UART port info' })
  uartPorts?: UartPortInfo[];
}

/**
 * Result of bulk I/O config import.
 * Reports which channels were created and which were skipped (duplicates).
 */
@ObjectType()
export class BulkAddIoConfigResult {
  @Field(() => [DeviceIoConfig], { description: 'Successfully created I/O configs' })
  created!: DeviceIoConfig[];

  @Field(() => [String], { description: 'Tag names that were skipped (already exist)' })
  skipped!: string[];

  @Field(() => Int, { description: 'Number of configs created' })
  createdCount!: number;

  @Field(() => Int, { description: 'Number of configs skipped (duplicate tagName)' })
  skippedCount!: number;
}
