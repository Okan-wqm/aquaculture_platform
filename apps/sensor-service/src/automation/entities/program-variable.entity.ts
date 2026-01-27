import {
  ObjectType,
  Field,
  ID,
  Float,
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
 * IEC 61131-3 Variable data types
 */
export enum VariableDataType {
  BOOL = 'BOOL',         // Boolean (TRUE/FALSE)
  INT = 'INT',           // 16-bit signed integer
  DINT = 'DINT',         // 32-bit signed integer
  UINT = 'UINT',         // 16-bit unsigned integer
  UDINT = 'UDINT',       // 32-bit unsigned integer
  REAL = 'REAL',         // 32-bit floating point
  LREAL = 'LREAL',       // 64-bit floating point
  STRING = 'STRING',     // Character string
  TIME = 'TIME',         // Duration
  DATE = 'DATE',         // Date
  TOD = 'TOD',           // Time of day
  DT = 'DT',             // Date and time
}

registerEnumType(VariableDataType, {
  name: 'VariableDataType',
  description: 'IEC 61131-3 variable data type',
});

/**
 * Variable scope
 */
export enum VariableScope {
  LOCAL = 'local',       // Program-local variable
  INPUT = 'input',       // Mapped to input I/O
  OUTPUT = 'output',     // Mapped to output I/O
  INOUT = 'inout',       // Bidirectional I/O mapping
  RETAIN = 'retain',     // Retained across power cycles
  CONSTANT = 'constant', // Read-only constant
}

registerEnumType(VariableScope, {
  name: 'VariableScope',
  description: 'Scope/usage of the variable',
});

/**
 * ProgramVariable entity - IEC 61131-3 program variables with I/O mapping
 */
@ObjectType()
@Entity('program_variables')
@Index(['programId', 'varName'], { unique: true })
@Index(['programId', 'scope'])
@Index(['ioConfigId'])
export class ProgramVariable {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ name: 'program_id' })
  @Index()
  programId!: string;

  // Variable Identity
  @Field()
  @Column({ name: 'var_name', length: 50 })
  varName!: string;

  @Field({ nullable: true })
  @Column({ name: 'display_name', length: 100, nullable: true })
  displayName?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // Data Type
  @Field(() => VariableDataType)
  @Column({
    name: 'data_type',
    type: 'enum',
    enum: VariableDataType,
    default: VariableDataType.REAL,
  })
  dataType!: VariableDataType;

  @Field(() => VariableScope)
  @Column({
    type: 'enum',
    enum: VariableScope,
    default: VariableScope.LOCAL,
  })
  scope!: VariableScope;

  // Initial/Default Value
  @Field({ nullable: true })
  @Column({ name: 'initial_value', type: 'text', nullable: true })
  initialValue?: string;

  // I/O Mapping (links to DeviceIoConfig)
  @Field({ nullable: true, description: 'Reference to DeviceIoConfig.id' })
  @Column({ name: 'io_config_id', nullable: true })
  ioConfigId?: string;

  @Field({ nullable: true, description: 'I/O tag name for quick reference' })
  @Column({ name: 'io_tag_name', length: 50, nullable: true })
  ioTagName?: string;

  // Equipment binding (for Process Editor integration)
  @Field({ nullable: true, description: 'Reference to equipment node in process template' })
  @Column({ name: 'equipment_node_id', length: 100, nullable: true })
  equipmentNodeId?: string;

  @Field({ nullable: true })
  @Column({ name: 'equipment_property', length: 50, nullable: true })
  equipmentProperty?: string; // e.g., "speed", "running", "level"

  // Sensor binding (for sensor data)
  @Field({ nullable: true, description: 'Reference to sensor data channel' })
  @Column({ name: 'sensor_channel_id', nullable: true })
  sensorChannelId?: string;

  // Value constraints
  @Field(() => Float, { nullable: true })
  @Column({ name: 'min_value', type: 'decimal', precision: 15, scale: 4, nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'max_value', type: 'decimal', precision: 15, scale: 4, nullable: true })
  maxValue?: number;

  @Field({ nullable: true })
  @Column({ name: 'eng_unit', length: 20, nullable: true })
  engUnit?: string;

  // Alarm thresholds
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

  // Metadata
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  // Ordering
  @Field()
  @Column({ name: 'var_order', type: 'int', default: 0 })
  varOrder!: number;

  // Timestamps
  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  // Computed fields
  @Field({ nullable: true })
  currentValue?: string;

  @Field({ nullable: true })
  lastUpdated?: Date;
}
