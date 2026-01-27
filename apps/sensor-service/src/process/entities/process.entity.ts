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
 * Process status enum
 */
export enum ProcessStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ARCHIVED = 'archived',
}

registerEnumType(ProcessStatus, {
  name: 'ProcessStatus',
  description: 'Status of the process diagram',
});

/**
 * Process node interface for JSONB storage
 */
export interface ProcessNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    equipmentId?: string;
    equipmentName: string;
    equipmentCode?: string;
    equipmentType?: string;
    equipmentCategory?: string;
    status?: string;
    sensorMappings?: SensorMapping[];
    connectionPoints?: Record<string, string>;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Process edge interface for JSONB storage
 */
export interface ProcessEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type?: string;
  data?: Record<string, unknown>;
}

/**
 * Sensor mapping interface for equipment nodes
 */
export interface SensorMapping {
  sensorId: string;
  sensorName: string;
  channelId: string;
  channelName: string;
  dataPath: string;
  dataType: string;
  unit?: string;
}

/**
 * Process entity - represents an equipment connection diagram
 */
@ObjectType()
@Entity('processes')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'siteId'])
export class Process {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => ProcessStatus)
  @Column({ type: 'enum', enum: ProcessStatus, default: ProcessStatus.DRAFT })
  status!: ProcessStatus;

  @Field(() => GraphQLJSON)
  @Column('jsonb', { default: '[]' })
  nodes!: ProcessNode[];

  @Field(() => GraphQLJSON)
  @Column('jsonb', { default: '[]' })
  edges!: ProcessEdge[];

  @Field()
  @Column({ name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Field({ nullable: true })
  @Column({ name: 'site_id', nullable: true })
  @Index()
  siteId?: string;

  @Field({ nullable: true })
  @Column({ name: 'department_id', nullable: true })
  departmentId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column('jsonb', { nullable: true })
  metadata?: Record<string, unknown>;

  @Field()
  @Column({ name: 'is_template', default: false })
  isTemplate!: boolean;

  @Field({ nullable: true })
  @Column({ name: 'template_name', nullable: true })
  templateName?: string;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ name: 'updated_by', nullable: true })
  updatedBy?: string;
}
