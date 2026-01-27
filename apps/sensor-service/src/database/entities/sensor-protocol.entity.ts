import {
  ObjectType,
  Field,
  ID,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Protocol category enum
 */
export enum ProtocolCategory {
  INDUSTRIAL = 'industrial',
  IOT = 'iot',
  SERIAL = 'serial',
  WIRELESS = 'wireless',
}

registerEnumType(ProtocolCategory, {
  name: 'ProtocolCategory',
  description: 'Category of communication protocol',
});

/**
 * Protocol subcategory for more granular classification
 */
export enum ProtocolSubcategory {
  // Industrial
  MODBUS = 'modbus',
  FIELDBUS = 'fieldbus',
  ETHERNET_INDUSTRIAL = 'ethernet_industrial',
  PLC_NATIVE = 'plc_native',
  PLC = 'plc',
  BUILDING_AUTOMATION = 'building_automation',
  REALTIME_ETHERNET = 'realtime_ethernet',

  // IoT
  MESSAGE_QUEUE = 'message_queue',
  REQUEST_RESPONSE = 'request_response',
  REALTIME = 'realtime',

  // Serial
  WIRED_SERIAL = 'wired_serial',
  SOCKET = 'socket',
  BUS = 'bus',
  SERIAL_PORT = 'serial_port',
  NETWORK = 'network',

  // Wireless
  LPWAN = 'lpwan',
  MESH = 'mesh',
  SHORT_RANGE = 'short_range',
}

registerEnumType(ProtocolSubcategory, {
  name: 'ProtocolSubcategory',
  description: 'Subcategory of communication protocol',
});

/**
 * Connection type enum
 */
export enum ConnectionType {
  TCP = 'tcp',
  UDP = 'udp',
  SERIAL = 'serial',
  USB = 'usb',
  WIRELESS = 'wireless',
  HYBRID = 'hybrid',
  ETHERNET = 'ethernet',
  I2C = 'i2c',
  ONE_WIRE = 'one_wire',
  SPI = 'spi',
  BLUETOOTH = 'bluetooth',
}

registerEnumType(ConnectionType, {
  name: 'ConnectionType',
  description: 'Type of physical connection',
});

/**
 * JSON Schema property type for form generation
 */
export interface JSONSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: (string | number)[];
  enumNames?: string[];
  format?: 'ipv4' | 'ipv6' | 'uri' | 'email' | 'password' | 'date-time' | 'hostname' | 'hex';
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  // UI hints for form generation
  'ui:widget'?: string;
  'ui:placeholder'?: string;
  'ui:help'?: string;
  'ui:order'?: number;
  'ui:group'?: string;
  'ui:hidden'?: boolean;
  'ui:readonly'?: boolean;
}

/**
 * JSON Schema for protocol configuration
 */
export interface ProtocolConfigurationSchema {
  type: 'object';
  title?: string;
  description?: string;
  required?: string[];
  properties: Record<string, JSONSchemaProperty>;
  // UI layout hints
  'ui:groups'?: Array<{
    name: string;
    title: string;
    description?: string;
    fields: string[];
  }>;
}

/**
 * SensorProtocol entity - defines available communication protocols
 */
@ObjectType()
@Entity('sensor_protocols') // Schema comes from search_path (tenant-specific)
@Index(['code'], { unique: true })
@Index(['category'])
@Index(['isActive'])
export class SensorProtocol {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ unique: true, length: 50 })
  code!: string;

  @Field()
  @Column({ length: 100 })
  name!: string;

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  description?: string;

  @Field(() => ProtocolCategory)
  @Column({ type: 'enum', enum: ProtocolCategory })
  category!: ProtocolCategory;

  @Field(() => ProtocolSubcategory, { nullable: true })
  @Column({ type: 'enum', enum: ProtocolSubcategory, nullable: true })
  subcategory?: ProtocolSubcategory;

  @Field(() => ConnectionType)
  @Column({ type: 'enum', enum: ConnectionType })
  connectionType!: ConnectionType;

  @Field(() => GraphQLJSON)
  @Column('jsonb')
  configurationSchema!: ProtocolConfigurationSchema;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { nullable: true })
  defaultConfiguration?: Record<string, unknown>;

  @Field({ nullable: true })
  @Column({ nullable: true })
  documentationUrl?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  iconName?: string;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field()
  @Column({ default: false })
  requiresGateway!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  gatewayProtocol?: string;

  @Field()
  @Column({ default: false })
  supportsDiscovery!: boolean;

  @Field()
  @Column({ default: false })
  supportsBidirectional!: boolean;

  @Field()
  @Column({ default: true })
  supportsPolling!: boolean;

  @Field()
  @Column({ default: false })
  supportsSubscription!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'int', nullable: true })
  defaultPort?: number;

  @Field({ nullable: true })
  @Column({ type: 'int', nullable: true })
  defaultBaudRate?: number;

  @Field({ nullable: true })
  @Column({ type: 'int', nullable: true })
  defaultTimeout?: number;

  @Field({ nullable: true })
  @Column({ type: 'int', nullable: true })
  maxConnectionsPerInstance?: number;

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  requiredPermissions?: string[];

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  supportedDataTypes?: string[];

  @Field({ nullable: true })
  @Column({ type: 'int', nullable: true })
  sortOrder?: number;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;
}
