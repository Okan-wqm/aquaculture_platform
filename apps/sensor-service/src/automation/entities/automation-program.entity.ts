import {
  ObjectType,
  Field,
  ID,
  Int,
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
 * Program execution mode
 */
export enum ExecutionMode {
  MANUAL = 'manual',           // Started/stopped manually
  CONTINUOUS = 'continuous',   // Auto-start on device boot
  SCHEDULED = 'scheduled',     // Runs on schedule
  TRIGGERED = 'triggered',     // Runs when condition met
}

registerEnumType(ExecutionMode, {
  name: 'ExecutionMode',
  description: 'How the program is triggered to run',
});

/**
 * Program status
 */
export enum ProgramStatus {
  DRAFT = 'draft',             // Being edited
  PENDING_REVIEW = 'pending_review', // Awaiting approval
  APPROVED = 'approved',       // Ready to deploy
  DEPLOYED = 'deployed',       // Running on device
  ARCHIVED = 'archived',       // No longer active
}

registerEnumType(ProgramStatus, {
  name: 'ProgramStatus',
  description: 'Current status of the automation program',
});

/**
 * Program type (IEC 61131-3)
 */
export enum ProgramType {
  SFC = 'sfc',                 // Sequential Function Chart
  FBD = 'fbd',                 // Function Block Diagram
  ST = 'st',                   // Structured Text only
  LD = 'ld',                   // Ladder Diagram
}

registerEnumType(ProgramType, {
  name: 'ProgramType',
  description: 'IEC 61131-3 programming language type',
});

/**
 * SFC Definition structure stored as JSONB
 */
export interface SfcDefinition {
  initialStep: string;
  steps: Record<string, {
    code: string;
    name: string;
    type: 'initial' | 'normal' | 'final';
    positionX: number;
    positionY: number;
    entryAction?: string;
    exitAction?: string;
    timeoutMs?: number;
    onTimeout?: 'abort' | 'skip' | 'alarm' | 'goto';
    timeoutTargetStep?: string;
  }>;
  transitions: Record<string, {
    code: string;
    fromStep: string;
    toStep: string;
    condition: string;
    priority: number;
  }>;
  variables: Record<string, {
    name: string;
    type: 'BOOL' | 'INT' | 'REAL' | 'STRING';
    initialValue?: string;
    ioConfigId?: string;
    ioDirection?: 'input' | 'output' | 'inout';
  }>;
}

/**
 * AutomationProgram entity - IEC 61131-3 compliant automation program
 */
@ObjectType()
@Entity('automation_programs')
@Index(['tenantId', 'deviceId'])
@Index(['tenantId', 'programCode'], { unique: true })
@Index(['tenantId', 'status'])
export class AutomationProgram {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Tenant & Device Relations
  @Field()
  @Column({ name: 'tenant_id' })
  @Index()
  tenantId: string;

  @Field({ nullable: true })
  @Column({ name: 'device_id', nullable: true })
  @Index()
  deviceId?: string;

  @Field({ nullable: true })
  @Column({ name: 'process_template_id', nullable: true })
  processTemplateId?: string;

  // Program Identity
  @Field()
  @Column({ name: 'program_code', length: 30 })
  programCode: string;

  @Field()
  @Column({ name: 'program_name', length: 100 })
  programName: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => ProgramType)
  @Column({
    name: 'program_type',
    type: 'enum',
    enum: ProgramType,
    default: ProgramType.SFC,
  })
  programType: ProgramType;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  category?: string; // startup, shutdown, emergency, process, cleaning

  // SFC Definition (JSONB)
  @Field(() => GraphQLJSON)
  @Column({ name: 'sfc_definition', type: 'jsonb' })
  sfcDefinition: SfcDefinition;

  // IEC 61131-3 Structured Text Source
  @Field({ nullable: true })
  @Column({ name: 'structured_text_code', type: 'text', nullable: true })
  structuredTextCode?: string;

  // Transpiled JavaScript (for Node-RED execution)
  @Column({ name: 'transpiled_js', type: 'text', nullable: true })
  transpiledJs?: string;

  // Execution Configuration
  @Field(() => ExecutionMode)
  @Column({
    name: 'execution_mode',
    type: 'enum',
    enum: ExecutionMode,
    default: ExecutionMode.MANUAL,
  })
  executionMode: ExecutionMode;

  @Field(() => Int)
  @Column({ name: 'scan_cycle_ms', type: 'int', default: 100 })
  scanCycleMs: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 5 })
  priority: number; // 1-10, lower = higher priority

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'trigger_config', type: 'jsonb', nullable: true })
  triggerConfig?: {
    schedule?: string;        // Cron expression
    condition?: string;       // ST expression
    eventType?: string;       // Event to listen for
  };

  // Versioning
  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  version: number;

  @Field(() => ProgramStatus)
  @Column({
    type: 'enum',
    enum: ProgramStatus,
    default: ProgramStatus.DRAFT,
  })
  status: ProgramStatus;

  // Deployment Tracking
  @Field(() => Int, { nullable: true })
  @Column({ name: 'deployed_version', type: 'int', nullable: true })
  deployedVersion?: number;

  @Field({ nullable: true })
  @Column({ name: 'deployed_at', type: 'timestamptz', nullable: true })
  deployedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'deployed_by', nullable: true })
  deployedBy?: string;

  // Approval Workflow
  @Field({ nullable: true })
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'approved_by', nullable: true })
  approvedBy?: string;

  // Lock for editing
  @Field()
  @Column({ name: 'is_locked', default: false })
  isLocked: boolean;

  @Field({ nullable: true })
  @Column({ name: 'locked_by', nullable: true })
  lockedBy?: string;

  @Field({ nullable: true })
  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt?: Date;

  // Metadata
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  // Timestamps
  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  // Computed fields (resolved in GraphQL)
  @Field(() => Int, { nullable: true })
  stepCount?: number;

  @Field(() => Int, { nullable: true })
  transitionCount?: number;

  @Field(() => Int, { nullable: true })
  variableCount?: number;

  @Field({ nullable: true })
  lastExecutionTime?: Date;

  @Field({ nullable: true })
  currentStep?: string;
}
