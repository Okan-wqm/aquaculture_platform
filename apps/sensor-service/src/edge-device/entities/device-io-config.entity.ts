import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { EdgeDevice } from './edge-device.entity';

/**
 * I/O Type enum (Industrial standard)
 */
export enum IoType {
  DI = 'DI', // Digital Input
  DO = 'DO', // Digital Output
  AI = 'AI', // Analog Input
  AO = 'AO', // Analog Output
}

registerEnumType(IoType, {
  name: 'IoType',
  description: 'Type of I/O point (DI, DO, AI, AO)',
});

/**
 * Data type enum for I/O values
 */
export enum IoDataType {
  BOOL = 'bool',
  INT16 = 'int16',
  INT32 = 'int32',
  UINT16 = 'uint16',
  UINT32 = 'uint32',
  FLOAT32 = 'float32',
  FLOAT64 = 'float64',
}

registerEnumType(IoDataType, {
  name: 'IoDataType',
  description: 'Data type for I/O values',
});

/**
 * DeviceIoConfig entity - represents an I/O point configuration on an edge device
 */
@ObjectType()
@Entity('device_io_configs')
@Index(['deviceId', 'tagName'], { unique: true })
@Index(['deviceId', 'moduleAddress', 'channel'])
export class DeviceIoConfig {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ name: 'device_id' })
  @Index()
  deviceId: string;

  @Field(() => EdgeDevice)
  @ManyToOne(() => EdgeDevice, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: EdgeDevice;

  // I/O Point Identity
  @Field()
  @Column({ name: 'tag_name', length: 50 })
  tagName: string;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  description?: string;

  // I/O Type
  @Field(() => IoType)
  @Column({ name: 'io_type', type: 'enum', enum: IoType })
  ioType: IoType;

  @Field(() => IoDataType)
  @Column({ name: 'data_type', type: 'enum', enum: IoDataType })
  dataType: IoDataType;

  // Hardware Mapping
  @Field(() => Int)
  @Column({ name: 'module_address', type: 'int' })
  moduleAddress: number;

  @Field(() => Int)
  @Column({ type: 'int' })
  channel: number;

  // Scaling (for analog I/O)
  @Field(() => Float, { nullable: true })
  @Column({ name: 'raw_min', type: 'decimal', precision: 15, scale: 4, nullable: true })
  rawMin?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'raw_max', type: 'decimal', precision: 15, scale: 4, nullable: true })
  rawMax?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'eng_min', type: 'decimal', precision: 15, scale: 4, nullable: true })
  engMin?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'eng_max', type: 'decimal', precision: 15, scale: 4, nullable: true })
  engMax?: number;

  @Field({ nullable: true })
  @Column({ name: 'eng_unit', length: 20, nullable: true })
  engUnit?: string;

  // Modbus Specific
  @Field(() => Int, { nullable: true })
  @Column({ name: 'modbus_function', type: 'int', nullable: true })
  modbusFunction?: number;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'modbus_slave_id', type: 'int', default: 1 })
  modbusSlaveId?: number;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'modbus_register', type: 'int', nullable: true })
  modbusRegister?: number;

  // GPIO Specific
  @Field(() => Int, { nullable: true })
  @Column({ name: 'gpio_pin', type: 'int', nullable: true })
  gpioPin?: number;

  @Field({ nullable: true })
  @Column({ name: 'gpio_mode', length: 20, nullable: true })
  gpioMode?: string; // 'input', 'output', 'pwm'

  // Value Inversion
  @Field()
  @Column({ name: 'invert_value', default: false })
  invertValue: boolean;

  // Alarm Thresholds (for analog)
  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_hh', type: 'decimal', precision: 15, scale: 4, nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_h', type: 'decimal', precision: 15, scale: 4, nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_l', type: 'decimal', precision: 15, scale: 4, nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_ll', type: 'decimal', precision: 15, scale: 4, nullable: true })
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 15, scale: 4, nullable: true })
  deadband?: number;

  // Status
  @Field()
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  // Timestamps
  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
