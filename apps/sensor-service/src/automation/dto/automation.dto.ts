import { InputType, Field, ID, Int, Float, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

import {
  ProgramType,
  ExecutionMode,
  ProgramStatus,
} from '../entities/automation-program.entity';
import {
  StepType,
  TimeoutBehavior,
} from '../entities/program-step.entity';
import {
  ConditionType,
} from '../entities/program-transition.entity';
import {
  VariableDataType,
  VariableScope,
} from '../entities/program-variable.entity';
import {
  ActionQualifier,
  ActionType,
} from '../entities/step-action.entity';

// ============================================
// Program Input Types
// ============================================

@InputType()
export class CreateProgramInput {
  @Field()
  programCode!: string;

  @Field()
  programName!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ProgramType, { defaultValue: ProgramType.SFC })
  programType?: ProgramType;

  @Field(() => ExecutionMode, { defaultValue: ExecutionMode.MANUAL })
  executionMode?: ExecutionMode;

  @Field({ nullable: true })
  deviceId?: string;

  @Field({ nullable: true })
  processTemplateId?: string;

  @Field(() => GraphQLJSON)
  sfcDefinition!: Record<string, unknown>;

  @Field({ nullable: true })
  structuredTextCode?: string;

  @Field(() => Int, { defaultValue: 100 })
  scanCycleMs?: number;

  @Field(() => Int, { defaultValue: 5 })
  priority?: number;

  @Field({ nullable: true })
  category?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  triggerConfig?: Record<string, unknown>;

  @Field(() => [String], { nullable: true })
  tags?: string[];
}

@InputType()
export class UpdateProgramInput {
  @Field({ nullable: true })
  programName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ExecutionMode, { nullable: true })
  executionMode?: ExecutionMode;

  @Field(() => GraphQLJSON, { nullable: true })
  sfcDefinition?: Record<string, unknown>;

  @Field({ nullable: true })
  structuredTextCode?: string;

  @Field(() => Int, { nullable: true })
  scanCycleMs?: number;

  @Field(() => Int, { nullable: true })
  priority?: number;

  @Field({ nullable: true })
  category?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  triggerConfig?: Record<string, unknown>;

  @Field(() => [String], { nullable: true })
  tags?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;
}

@InputType()
export class ProgramFilterInput {
  @Field(() => ProgramStatus, { nullable: true })
  status?: ProgramStatus;

  @Field(() => ProgramType, { nullable: true })
  programType?: ProgramType;

  @Field({ nullable: true })
  deviceId?: string;

  @Field({ nullable: true })
  processTemplateId?: string;

  @Field({ nullable: true })
  category?: string;

  @Field({ nullable: true, description: 'Search in name and code' })
  search?: string;

  @Field({ nullable: true })
  isLocked?: boolean;
}

// ============================================
// Step Input Types
// ============================================

@InputType()
export class CreateStepInput {
  @Field(() => ID)
  programId!: string;

  @Field()
  stepCode!: string;

  @Field()
  stepName!: string;

  @Field(() => StepType, { defaultValue: StepType.NORMAL })
  stepType?: StepType;

  @Field({ nullable: true })
  description?: string;

  @Field(() => Int, { defaultValue: 0 })
  positionX?: number;

  @Field(() => Int, { defaultValue: 0 })
  positionY?: number;

  @Field({ nullable: true, description: 'IEC 61131-3 ST code for entry action' })
  entryAction?: string;

  @Field({ nullable: true, description: 'IEC 61131-3 ST code for exit action' })
  exitAction?: string;

  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @Field(() => TimeoutBehavior, { nullable: true })
  onTimeout?: TimeoutBehavior;

  @Field({ nullable: true })
  timeoutTargetStep?: string;

  @Field(() => Int, { defaultValue: 0 })
  stepOrder?: number;
}

@InputType()
export class UpdateStepInput {
  @Field({ nullable: true })
  stepName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => Int, { nullable: true })
  positionX?: number;

  @Field(() => Int, { nullable: true })
  positionY?: number;

  @Field({ nullable: true })
  entryAction?: string;

  @Field({ nullable: true })
  exitAction?: string;

  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @Field(() => TimeoutBehavior, { nullable: true })
  onTimeout?: TimeoutBehavior;

  @Field({ nullable: true })
  timeoutTargetStep?: string;

  @Field(() => Int, { nullable: true })
  stepOrder?: number;
}

// ============================================
// Action Input Types
// ============================================

@InputType()
export class CreateActionInput {
  @Field(() => ID)
  stepId!: string;

  @Field()
  actionName!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ActionQualifier, { defaultValue: ActionQualifier.N })
  qualifier?: ActionQualifier;

  @Field(() => ActionType, { defaultValue: ActionType.CUSTOM_ST })
  actionType?: ActionType;

  @Field({ description: 'IEC 61131-3 Structured Text code' })
  actionCode!: string;

  @Field({ nullable: true })
  targetRef?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  params?: Record<string, unknown>;

  @Field(() => Int, { nullable: true })
  delayMs?: number;

  @Field(() => Int, { nullable: true })
  durationMs?: number;

  @Field(() => Int, { defaultValue: 0 })
  actionOrder?: number;

  @Field({ defaultValue: true })
  isActive?: boolean;
}

@InputType()
export class UpdateActionInput {
  @Field({ nullable: true })
  actionName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ActionQualifier, { nullable: true })
  qualifier?: ActionQualifier;

  @Field(() => ActionType, { nullable: true })
  actionType?: ActionType;

  @Field({ nullable: true })
  actionCode?: string;

  @Field({ nullable: true })
  targetRef?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  params?: Record<string, unknown>;

  @Field(() => Int, { nullable: true })
  delayMs?: number;

  @Field(() => Int, { nullable: true })
  durationMs?: number;

  @Field(() => Int, { nullable: true })
  actionOrder?: number;

  @Field({ nullable: true })
  isActive?: boolean;
}

// ============================================
// Transition Input Types
// ============================================

@InputType()
export class CreateTransitionInput {
  @Field(() => ID)
  programId!: string;

  @Field()
  transitionCode!: string;

  @Field({ nullable: true })
  transitionName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ID)
  fromStepId!: string;

  @Field(() => ID)
  toStepId!: string;

  @Field({ nullable: true })
  fromStepCode?: string;

  @Field({ nullable: true })
  toStepCode?: string;

  @Field(() => ConditionType, { defaultValue: ConditionType.EXPRESSION })
  conditionType?: ConditionType;

  @Field({ description: 'IEC 61131-3 ST expression' })
  conditionExpression!: string;

  @Field(() => Int, { defaultValue: 1 })
  priority?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  controlPoints?: Array<{ x: number; y: number }>;

  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @Field({ nullable: true })
  eventType?: string;

  @Field({ defaultValue: true })
  isActive?: boolean;
}

@InputType()
export class UpdateTransitionInput {
  @Field({ nullable: true })
  transitionName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => ConditionType, { nullable: true })
  conditionType?: ConditionType;

  @Field({ nullable: true })
  conditionExpression?: string;

  @Field(() => Int, { nullable: true })
  priority?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  controlPoints?: Array<{ x: number; y: number }>;

  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @Field({ nullable: true })
  eventType?: string;

  @Field({ nullable: true })
  isActive?: boolean;
}

// ============================================
// Variable Input Types
// ============================================

@InputType()
export class CreateVariableInput {
  @Field(() => ID)
  programId!: string;

  @Field()
  varName!: string;

  @Field({ nullable: true })
  displayName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => VariableDataType, { defaultValue: VariableDataType.REAL })
  dataType?: VariableDataType;

  @Field(() => VariableScope, { defaultValue: VariableScope.LOCAL })
  scope?: VariableScope;

  @Field({ nullable: true })
  initialValue?: string;

  // I/O Mapping
  @Field({ nullable: true, description: 'Reference to DeviceIoConfig.id' })
  ioConfigId?: string;

  @Field({ nullable: true })
  ioTagName?: string;

  // Equipment binding (Process Editor integration)
  @Field({ nullable: true, description: 'Reference to equipment node in process template' })
  equipmentNodeId?: string;

  @Field({ nullable: true })
  equipmentProperty?: string;

  // Sensor binding
  @Field({ nullable: true, description: 'Reference to sensor data channel' })
  sensorChannelId?: string;

  // Constraints
  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @Field({ nullable: true })
  engUnit?: string;

  // Alarms
  @Field(() => Float, { nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  alarmLL?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => Int, { defaultValue: 0 })
  varOrder?: number;
}

@InputType()
export class UpdateVariableInput {
  @Field({ nullable: true })
  displayName?: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => VariableDataType, { nullable: true })
  dataType?: VariableDataType;

  @Field(() => VariableScope, { nullable: true })
  scope?: VariableScope;

  @Field({ nullable: true })
  initialValue?: string;

  @Field({ nullable: true })
  ioConfigId?: string;

  @Field({ nullable: true })
  ioTagName?: string;

  @Field({ nullable: true })
  equipmentNodeId?: string;

  @Field({ nullable: true })
  equipmentProperty?: string;

  @Field({ nullable: true })
  sensorChannelId?: string;

  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @Field({ nullable: true })
  engUnit?: string;

  @Field(() => Float, { nullable: true })
  alarmHH?: number;

  @Field(() => Float, { nullable: true })
  alarmH?: number;

  @Field(() => Float, { nullable: true })
  alarmL?: number;

  @Field(() => Float, { nullable: true })
  alarmLL?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => Int, { nullable: true })
  varOrder?: number;
}

// ============================================
// Output Types
// ============================================

@ObjectType()
export class StatusCount {
  @Field()
  status!: string;

  @Field(() => Int)
  count!: number;
}

@ObjectType()
export class TypeCount {
  @Field()
  type!: string;

  @Field(() => Int)
  count!: number;
}

@ObjectType()
export class ProgramStats {
  @Field(() => Int)
  total!: number;

  @Field(() => [StatusCount])
  byStatus!: StatusCount[];

  @Field(() => [TypeCount])
  byType!: TypeCount[];

  @Field(() => Int)
  lockedCount!: number;

  @Field(() => Int)
  deployedCount!: number;
}

@ObjectType()
export class AutomationProgramConnection {
  @Field(() => [ID])
  items!: string[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field()
  hasMore!: boolean;
}

// ============================================
// Deployment Types (v2.1 - IEC 61131-3 Edge Deployment)
// ============================================

@InputType()
export class DeployProgramInput {
  @Field(() => ID, { description: 'Program ID to deploy' })
  programId!: string;

  @Field(() => ID, { description: 'Target edge device ID' })
  deviceId!: string;

  @Field({ nullable: true, description: 'Force deployment even if device is offline (will queue)' })
  forceQueue?: boolean;
}

@ObjectType()
export class DeploymentResult {
  @Field()
  success!: boolean;

  @Field({ nullable: true })
  message?: string;

  @Field(() => ID)
  programId!: string;

  @Field(() => ID)
  deviceId!: string;

  @Field({ nullable: true, description: 'Timestamp when deployment was sent' })
  deployedAt?: Date;

  @Field({ nullable: true, description: 'If true, deployment was queued for offline device' })
  queued?: boolean;

  @Field({ nullable: true, description: 'Deployment command ID for tracking' })
  commandId?: string;

  @Field({ nullable: true, description: 'Version of the deployed program' })
  deployedVersion?: number;

  @Field({ nullable: true })
  error?: string;
}

@ObjectType()
export class DeploymentStatus {
  @Field(() => ID)
  programId!: string;

  @Field(() => ID)
  deviceId!: string;

  @Field()
  deviceCode!: string;

  @Field()
  status!: string; // 'pending' | 'deploying' | 'deployed' | 'failed'

  @Field({ nullable: true })
  deployedVersion?: number;

  @Field({ nullable: true })
  deployedAt?: Date;

  @Field({ nullable: true })
  lastError?: string;
}

// Re-export entity types for convenience
export {
  ProgramType,
  ExecutionMode,
  ProgramStatus,
  StepType,
  TimeoutBehavior,
  ActionQualifier,
  ActionType,
  ConditionType,
  VariableDataType,
  VariableScope,
};
