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
 * Tag I/O direction
 */
export enum TagDirection {
  INPUT = 'input',
  OUTPUT = 'output',
  BIDIRECTIONAL = 'bidirectional',
}

registerEnumType(TagDirection, {
  name: 'TagDirection',
  description: 'Direction of the tag I/O',
});

/**
 * Tag I/O type (reuses industrial standard naming)
 */
export enum TagIoType {
  DI = 'DI',
  DO = 'DO',
  AI = 'AI',
  AO = 'AO',
}

registerEnumType(TagIoType, {
  name: 'TagIoType',
  description: 'Type of I/O point (DI, DO, AI, AO)',
});

/**
 * Tag data type
 */
export enum TagDataType {
  BOOL = 'BOOL',
  INT16 = 'INT16',
  INT32 = 'INT32',
  UINT16 = 'UINT16',
  UINT32 = 'UINT32',
  FLOAT32 = 'FLOAT32',
  FLOAT64 = 'FLOAT64',
}

registerEnumType(TagDataType, {
  name: 'TagDataType',
  description: 'Data type for tag values',
});

/**
 * Source information for a unified tag
 */
export interface TagSource {
  type?: string;
  edgeDeviceId?: string;
  ioConfigId?: string;
  sensorId?: string;
  channelId?: string;
}

/**
 * Hierarchy information for a unified tag
 */
export interface TagHierarchy {
  siteId?: string;
  zoneId?: string;
  equipmentId?: string;
  equipmentCode?: string;
}

/**
 * UnifiedTag entity - represents a unified tag point across all sources
 */
@ObjectType()
@Entity('unified_tags')
@Index(['tenantId', 'fqn'], { unique: true })
export class UnifiedTag {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 500 })
  fqn!: string;

  @Field()
  @Column({ name: 'local_name', length: 100 })
  localName!: string;

  @Field({ nullable: true })
  @Column({ name: 'display_name', nullable: true })
  displayName?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => TagIoType)
  @Column({ name: 'io_type', type: 'enum', enum: TagIoType })
  ioType!: TagIoType;

  @Field(() => TagDataType)
  @Column({ name: 'data_type', type: 'enum', enum: TagDataType })
  dataType!: TagDataType;

  @Field(() => TagDirection)
  @Column({ type: 'enum', enum: TagDirection, default: TagDirection.INPUT })
  direction!: TagDirection;

  @Field({ nullable: true })
  @Column({ name: 'eng_unit', length: 20, nullable: true })
  engUnit?: string;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'eng_min', type: 'float', nullable: true })
  engMin?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'eng_max', type: 'float', nullable: true })
  engMax?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_hh', type: 'float', nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_h', type: 'float', nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_l', type: 'float', nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  @Column({ name: 'alarm_ll', type: 'float', nullable: true })
  alarmLL?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'float', nullable: true })
  deadband?: number;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { default: '{}' })
  source!: TagSource;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { default: '{}' })
  hierarchy!: TagHierarchy;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
