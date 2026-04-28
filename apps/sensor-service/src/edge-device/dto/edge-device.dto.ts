import {
  InputType,
  Field,
  Int,
  Float,
  ObjectType,
  ID,
} from '@nestjs/graphql';
import { IsUUID, IsBoolean, IsOptional, IsString, IsHexadecimal, Length, IsEnum, Matches, Min, Max } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';
import { StandardPaginatedResponse } from '@aquaculture/backend-common/pagination';

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
import {
  LoRaActivationMode,
  LoRaDeviceClass,
} from '../entities/lora-device.entity';

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
  @IsOptional()
  @IsString()
  driverType?: string;

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
export class EdgeDeviceConnection extends StandardPaginatedResponse(EdgeDevice) {}

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

// ==================== Install Commands ====================

/**
 * Install/uninstall commands for edge device setup
 */
@ObjectType()
export class DeviceInstallCommands {
  @Field({ description: 'curl command to install the agent' })
  installCommand!: string;

  @Field({ description: 'curl command to uninstall the agent' })
  uninstallCommand!: string;

  @Field({ description: 'curl command to update the agent to latest version' })
  updateCommand!: string;

  @Field({ description: 'Direct URL to the install script' })
  installUrl!: string;

  @Field({ description: 'Direct URL to the uninstall script' })
  uninstallUrl!: string;

  @Field({ description: 'Direct URL to the update script' })
  updateUrl!: string;
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

// ==================== LoRaWAN Device Management ====================

/**
 * Input for adding a LoRaWAN end-device to an edge gateway.
 *
 * DevEUI, AppKey gibi LoRaWAN kimlik bilgileri cihaz üreticisinin
 * etiketinden veya provisioning kartından alınır. OTAA modunda
 * AppEUI ve AppKey zorunludur; ABP modunda DevAddr gerekir.
 */
@InputType()
export class AddLoRaDeviceInput {
  /** DevEUI: 16 hex karakter — cihazın globally unique tanımlayıcısı */
  @Field({ description: 'Device EUI - 16 hex character unique identifier' })
  @IsHexadecimal({ message: 'devEui must be a hex string' })
  @Length(16, 16, { message: 'devEui must be exactly 16 hex characters' })
  devEui!: string;

  /** AppEUI/JoinEUI: OTAA için gerekli */
  @Field({ nullable: true, description: 'Application EUI for OTAA activation (16 hex chars)' })
  @IsOptional()
  @IsHexadecimal({ message: 'appEui must be a hex string' })
  @Length(16, 16, { message: 'appEui must be exactly 16 hex characters' })
  appEui?: string;

  /** AppKey: 128-bit root key, OTAA join için zorunlu */
  @Field({ description: 'Application Key for OTAA (32 hex chars)' })
  @IsHexadecimal({ message: 'appKey must be a hex string' })
  @Length(32, 32, { message: 'appKey must be exactly 32 hex characters' })
  appKey!: string;

  @Field({ description: 'Human-friendly device name' })
  @IsString()
  @Length(1, 50)
  name!: string;

  /** I/O tag prefix — edge agent bu prefix ile decoded değerleri yayınlar */
  @Field({ description: 'Tag name prefix for I/O data (e.g. "LORA_PH")' })
  @IsString()
  @Length(1, 30)
  @Matches(/^[A-Za-z0-9_]+$/, { message: 'tagPrefix must contain only letters, numbers, and underscores' })
  tagPrefix!: string;

  @Field(() => LoRaActivationMode, { nullable: true, defaultValue: LoRaActivationMode.OTAA })
  @IsOptional()
  @IsEnum(LoRaActivationMode)
  activationMode?: LoRaActivationMode;

  @Field(() => LoRaDeviceClass, { nullable: true, defaultValue: LoRaDeviceClass.A })
  @IsOptional()
  @IsEnum(LoRaDeviceClass)
  deviceClass?: LoRaDeviceClass;

  /** Payload codec: cayenne_lpp (varsayılan), raw, json */
  @Field({ nullable: true, defaultValue: 'cayenne_lpp', description: 'Payload codec: cayenne_lpp, raw, json' })
  @IsOptional()
  @IsString()
  codec?: string;

  /** ADR: Adaptive Data Rate etkin mi? Varsayılan true. */
  @Field({ nullable: true, defaultValue: true, description: 'Enable Adaptive Data Rate' })
  @IsOptional()
  @IsBoolean()
  adrEnabled?: boolean;
}

/**
 * GraphQL output type for LoRaWAN device.
 * Entity'nin tüm alanlarını GraphQL schema'da expose eder.
 */
@ObjectType()
export class LoRaDeviceType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  edgeDeviceId!: string;

  @Field()
  devEui!: string;

  @Field({ nullable: true })
  appEui?: string;

  // appKey: GraphQL'den expose edilmez — güvenlik için maskelenmiş versiyonu kullanılır
  appKey!: string;

  /** Maskelenmiş AppKey — ilk 4 ve son 4 karakter gösterilir, ortası yıldızlı */
  @Field({ description: 'Masked application key (first 4 + last 4 chars)' })
  get appKeyMasked(): string {
    if (!this.appKey) return '';
    return `${this.appKey.slice(0, 4)}${'*'.repeat(24)}${this.appKey.slice(-4)}`;
  }

  @Field({ nullable: true })
  devAddr?: string;

  @Field(() => LoRaActivationMode)
  activationMode!: LoRaActivationMode;

  @Field(() => LoRaDeviceClass)
  deviceClass!: LoRaDeviceClass;

  @Field()
  name!: string;

  @Field()
  tagPrefix!: string;

  @Field()
  codec!: string;

  @Field()
  adrEnabled!: boolean;

  @Field(() => Int)
  fPort!: number;

  @Field({ nullable: true })
  lastSeenAt?: Date;

  @Field(() => Float, { nullable: true, description: 'RSSI in dBm' })
  lastRssi?: number;

  @Field(() => Float, { nullable: true, description: 'SNR in dB' })
  lastSnr?: number;

  @Field(() => Int, { nullable: true, description: 'Uplink frame counter' })
  frameCountUp?: number;

  @Field({ description: 'Whether device has successfully joined the network' })
  isJoined!: boolean;

  @Field({ nullable: true })
  joinedAt?: Date;

  @Field()
  tenantId!: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

/**
 * LoRa downlink gönderimi için input DTO.
 * Frontend'in beklediği format: payload (hex string), fPort, confirmed flag.
 */
@InputType()
export class SendLoRaDownlinkInput {
  /** Hex string olarak downlink payload (ör: "01FF0A") */
  @Field({ description: 'Downlink payload as hex string' })
  @IsString()
  payload!: string;

  /** LoRaWAN uygulama katmanı port numarası (1-223 arası) */
  @Field(() => Int, { nullable: true, defaultValue: 1, description: 'Application port (1-223)' })
  @IsOptional()
  @Min(1, { message: 'fPort must be at least 1' })
  @Max(223, { message: 'fPort must be at most 223' })
  fPort?: number;

  /** Confirmed downlink: cihazdan ACK beklenir mi? */
  @Field({ nullable: true, defaultValue: false, description: 'Request confirmed downlink (device ACK)' })
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

/**
 * Result of a LoRa downlink send operation
 */
@ObjectType()
export class SendLoRaDownlinkResult {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  error?: string;
}

// ==================== OTA Firmware Update ====================

/**
 * Available firmware version info from GitHub releases
 */
@ObjectType()
export class FirmwareVersionInfo {
  @Field()
  tag!: string;

  @Field()
  name!: string;

  @Field()
  publishedAt!: Date;

  @Field()
  prerelease!: boolean;
}

/**
 * Individual failure entry for bulk firmware update
 */
@ObjectType()
export class BulkFirmwareUpdateFailure {
  @Field(() => ID)
  id!: string;

  @Field()
  error!: string;
}

/**
 * Result of a bulk firmware update operation
 */
@ObjectType()
export class BulkFirmwareUpdateResult {
  @Field(() => [ID])
  success!: string[];

  @Field(() => [BulkFirmwareUpdateFailure])
  failed!: BulkFirmwareUpdateFailure[];
}
