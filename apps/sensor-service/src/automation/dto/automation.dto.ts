import { InputType, Field, ID, Int, Float, ObjectType } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsUUID,
  MaxLength,
  MinLength,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsIP,
  IsIn,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

import {
  AutomationProgram,
  ProgramType,
  ExecutionMode,
  ProgramStatus,
  DeployTarget,
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
import { DeploymentLog } from '../entities/deployment-log.entity';

// ============================================
// Program Input Types
// ============================================

@InputType()
export class CreateProgramInput {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Field()
  programCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Field()
  programName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(ProgramType)
  @Field(() => ProgramType, { defaultValue: ProgramType.SFC })
  programType?: ProgramType;

  @IsOptional()
  @IsEnum(ExecutionMode)
  @Field(() => ExecutionMode, { defaultValue: ExecutionMode.MANUAL })
  executionMode?: ExecutionMode;

  @IsOptional()
  @IsUUID()
  @Field({ nullable: true })
  deviceId?: string;

  @IsOptional()
  @IsUUID()
  @Field({ nullable: true })
  processTemplateId?: string;

  @Field(() => GraphQLJSON)
  sfcDefinition!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(524288) // 512 KB hard limit to prevent MQTT/device memory exhaustion
  @Field({ nullable: true })
  structuredTextCode?: string;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(60000)
  @Field(() => Int, { defaultValue: 100 })
  scanCycleMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  @Field(() => Int, { defaultValue: 5 })
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Field({ nullable: true })
  category?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  triggerConfig?: Record<string, unknown>;

  @Field(() => [String], { nullable: true })
  tags?: string[];

  // Deploy target configuration
  @IsOptional()
  @IsEnum(DeployTarget)
  @Field(() => DeployTarget, { defaultValue: DeployTarget.RUST_ENGINE })
  deployTarget?: DeployTarget;

  @IsOptional()
  @IsIP()
  @Field({ nullable: true, description: 'PLC IP address for Codesys/setpoint targets' })
  targetPlcAddress?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  @Field(() => Int, { nullable: true, description: 'PLC port (e.g., 1217 for Codesys Gateway)' })
  targetPlcPort?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true, description: 'PLC model (e.g., WAGO PFC200, Beckhoff CX)' })
  targetPlcModel?: string;

  @IsOptional()
  @IsIn(['codesys_v3', 'opcua', 'modbus', 's7comm'])
  @Field({ nullable: true, description: 'PLC protocol: codesys_v3, opcua, modbus, s7comm' })
  targetPlcProtocol?: string;
}

@InputType()
export class UpdateProgramInput {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Field({ nullable: true })
  programName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(ExecutionMode)
  @Field(() => ExecutionMode, { nullable: true })
  executionMode?: ExecutionMode;

  @Field(() => GraphQLJSON, { nullable: true })
  sfcDefinition?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(524288) // 512 KB hard limit to prevent MQTT/device memory exhaustion
  @Field({ nullable: true })
  structuredTextCode?: string;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(60000)
  @Field(() => Int, { nullable: true })
  scanCycleMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  @Field(() => Int, { nullable: true })
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Field({ nullable: true })
  category?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  triggerConfig?: Record<string, unknown>;

  @Field(() => [String], { nullable: true })
  tags?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;

  // Deploy target configuration
  @IsOptional()
  @IsEnum(DeployTarget)
  @Field(() => DeployTarget, { nullable: true })
  deployTarget?: DeployTarget;

  @IsOptional()
  @IsIP()
  @Field({ nullable: true })
  targetPlcAddress?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  @Field(() => Int, { nullable: true })
  targetPlcPort?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  targetPlcModel?: string;

  @IsOptional()
  @IsIn(['codesys_v3', 'opcua', 'modbus', 's7comm'])
  @Field({ nullable: true })
  targetPlcProtocol?: string;
}

@InputType()
export class ProgramFilterInput {
  @IsOptional()
  @IsEnum(ProgramStatus)
  @Field(() => ProgramStatus, { nullable: true })
  status?: ProgramStatus;

  @IsOptional()
  @IsEnum(ProgramType)
  @Field(() => ProgramType, { nullable: true })
  programType?: ProgramType;

  @IsOptional()
  @IsUUID()
  @Field({ nullable: true })
  deviceId?: string;

  @IsOptional()
  @IsUUID()
  @Field({ nullable: true })
  processTemplateId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Field({ nullable: true })
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field({ nullable: true, description: 'Search in name and code' })
  search?: string;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isLocked?: boolean;
}

// ============================================
// Step Input Types
// ============================================

@InputType()
export class CreateStepInput {
  @IsUUID()
  @Field(() => ID)
  programId!: string;

  @IsString()
  @MaxLength(30)
  @Field()
  stepCode!: string;

  @IsString()
  @MaxLength(100)
  @Field()
  stepName!: string;

  @IsOptional()
  @IsEnum(StepType)
  @Field(() => StepType, { defaultValue: StepType.NORMAL })
  stepType?: StepType;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { defaultValue: 0 })
  positionX?: number;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { defaultValue: 0 })
  positionY?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  @Field({ nullable: true, description: 'IEC 61131-3 ST code for entry action' })
  entryAction?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  @Field({ nullable: true, description: 'IEC 61131-3 ST code for exit action' })
  exitAction?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @IsOptional()
  @IsEnum(TimeoutBehavior)
  @Field(() => TimeoutBehavior, { nullable: true })
  onTimeout?: TimeoutBehavior;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  timeoutTargetStep?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { defaultValue: 0 })
  stepOrder?: number;
}

@InputType()
export class UpdateStepInput {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  stepName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  positionX?: number;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  positionY?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  @Field({ nullable: true })
  entryAction?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  @Field({ nullable: true })
  exitAction?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @IsOptional()
  @IsEnum(TimeoutBehavior)
  @Field(() => TimeoutBehavior, { nullable: true })
  onTimeout?: TimeoutBehavior;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  timeoutTargetStep?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  stepOrder?: number;
}

// ============================================
// Action Input Types
// ============================================

@InputType()
export class CreateActionInput {
  @IsUUID()
  @Field(() => ID)
  stepId!: string;

  @IsString()
  @MaxLength(100)
  @Field()
  actionName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(ActionQualifier)
  @Field(() => ActionQualifier, { defaultValue: ActionQualifier.N })
  qualifier?: ActionQualifier;

  @IsOptional()
  @IsEnum(ActionType)
  @Field(() => ActionType, { defaultValue: ActionType.CUSTOM_ST })
  actionType?: ActionType;

  @IsString()
  @MaxLength(4096) // Action code limit to prevent MQTT payload exhaustion on edge devices
  @Field({ description: 'IEC 61131-3 Structured Text code' })
  actionCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field({ nullable: true })
  targetRef?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  params?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  delayMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  durationMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { defaultValue: 0 })
  actionOrder?: number;

  @IsOptional()
  @IsBoolean()
  @Field({ defaultValue: true })
  isActive?: boolean;
}

@InputType()
export class UpdateActionInput {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  actionName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(ActionQualifier)
  @Field(() => ActionQualifier, { nullable: true })
  qualifier?: ActionQualifier;

  @IsOptional()
  @IsEnum(ActionType)
  @Field(() => ActionType, { nullable: true })
  actionType?: ActionType;

  @IsOptional()
  @IsString()
  @MaxLength(4096) // Action code limit to prevent MQTT payload exhaustion on edge devices
  @Field({ nullable: true })
  actionCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field({ nullable: true })
  targetRef?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  params?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  delayMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  durationMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  actionOrder?: number;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isActive?: boolean;
}

// ============================================
// Transition Input Types
// ============================================

@InputType()
export class CreateTransitionInput {
  @IsUUID()
  @Field(() => ID)
  programId!: string;

  @IsString()
  @MaxLength(30)
  @Field()
  transitionCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  transitionName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsUUID()
  @Field(() => ID)
  fromStepId!: string;

  @IsUUID()
  @Field(() => ID)
  toStepId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Field({ nullable: true })
  fromStepCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Field({ nullable: true })
  toStepCode?: string;

  @IsOptional()
  @IsEnum(ConditionType)
  @Field(() => ConditionType, { defaultValue: ConditionType.EXPRESSION })
  conditionType?: ConditionType;

  @IsString()
  @MaxLength(512) // Sensor reference expressions must be compact; prevent MQTT payload bloat
  @Field({ description: 'IEC 61131-3 ST expression' })
  conditionExpression!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  @Field(() => Int, { defaultValue: 1 })
  priority?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  controlPoints?: Array<{ x: number; y: number }>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  eventType?: string;

  @IsOptional()
  @IsBoolean()
  @Field({ defaultValue: true })
  isActive?: boolean;
}

@InputType()
export class UpdateTransitionInput {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  transitionName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(ConditionType)
  @Field(() => ConditionType, { nullable: true })
  conditionType?: ConditionType;

  @IsOptional()
  @IsString()
  @MaxLength(512) // Sensor reference expressions must be compact; prevent MQTT payload bloat
  @Field({ nullable: true })
  conditionExpression?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  @Field(() => Int, { nullable: true })
  priority?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  controlPoints?: Array<{ x: number; y: number }>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  eventType?: string;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isActive?: boolean;
}

// ============================================
// Variable Input Types
// ============================================

@InputType()
export class CreateVariableInput {
  @IsUUID()
  @Field(() => ID)
  programId!: string;

  @IsString()
  @MaxLength(100)
  @Field()
  varName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(VariableDataType)
  @Field(() => VariableDataType, { defaultValue: VariableDataType.REAL })
  dataType?: VariableDataType;

  @IsOptional()
  @IsEnum(VariableScope)
  @Field(() => VariableScope, { defaultValue: VariableScope.LOCAL })
  scope?: VariableScope;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Field({ nullable: true })
  initialValue?: string;

  // I/O Mapping
  @IsOptional()
  @IsUUID()
  @Field({ nullable: true, description: 'Reference to DeviceIoConfig.id' })
  ioConfigId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  ioTagName?: string;

  // Equipment binding (Process Editor integration)
  @IsOptional()
  @IsUUID()
  @Field({ nullable: true, description: 'Reference to equipment node in process template' })
  equipmentNodeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  equipmentProperty?: string;

  // Sensor binding
  @IsOptional()
  @IsUUID()
  @Field({ nullable: true, description: 'Reference to sensor data channel' })
  sensorChannelId?: string;

  // Constraints
  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
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

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { defaultValue: 0 })
  varOrder?: number;
}

@InputType()
export class UpdateVariableInput {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsEnum(VariableDataType)
  @Field(() => VariableDataType, { nullable: true })
  dataType?: VariableDataType;

  @IsOptional()
  @IsEnum(VariableScope)
  @Field(() => VariableScope, { nullable: true })
  scope?: VariableScope;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Field({ nullable: true })
  initialValue?: string;

  @IsOptional()
  @IsUUID()
  @Field({ nullable: true })
  ioConfigId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  ioTagName?: string;

  @IsOptional()
  @IsUUID()
  @Field({ nullable: true })
  equipmentNodeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Field({ nullable: true })
  equipmentProperty?: string;

  @IsOptional()
  @IsUUID()
  @Field({ nullable: true })
  sensorChannelId?: string;

  @Field(() => Float, { nullable: true })
  minValue?: number;

  @Field(() => Float, { nullable: true })
  maxValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
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

  @IsOptional()
  @IsInt()
  @Min(0)
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
  @Field(() => [AutomationProgram])
  items!: AutomationProgram[];

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
  @IsUUID()
  @Field(() => ID, { description: 'Program ID to deploy' })
  programId!: string;

  @IsUUID()
  @Field(() => ID, { description: 'Target edge device ID' })
  deviceId!: string;

  @IsOptional()
  @IsBoolean()
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

// ============================================
// Deployment History Types
// ============================================

@ObjectType()
export class DeploymentLogConnection {
  @Field(() => [DeploymentLog])
  items!: DeploymentLog[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field()
  hasMore!: boolean;
}

// Re-export entity types for convenience
export {
  ProgramType,
  ExecutionMode,
  ProgramStatus,
  DeployTarget,
  StepType,
  TimeoutBehavior,
  ActionQualifier,
  ActionType,
  ConditionType,
  VariableDataType,
  VariableScope,
};
