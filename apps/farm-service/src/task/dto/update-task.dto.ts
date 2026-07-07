/**
 * Update Task DTO
 * @module Task/DTO
 */
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { InputType, Field, Int, ID } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsDateString,
  IsBoolean,
  IsArray,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import { TaskCategory, TaskPriority, TaskStatus } from '../entities/task.entity';
import { TaskChecklistItemInput } from './create-task.dto';

/**
 * FARM-HIGH-057 — offline-queued task lifecycle input (complete / start).
 *
 * WHY: the mobile app queues complete/start offline and replays on reconnect.
 * Without an idempotency key, a replay double-applies (complete throws "already
 * completed"; start re-transitions). Extending the mobile command envelope makes
 * the `clientCommandId` + `payloadHash` mandatory transport for these paths so the
 * server can dedupe via the at-most-once receipt — same mechanism mortality/cull use.
 */
@InputType()
export class TaskLifecycleInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;
}

/**
 * FARM-HIGH-057 — idempotent checklist SET (replaces the lost-update toggle).
 *
 * WHY: `toggleChecklistItem` FLIPPED the item, so a replayed offline toggle
 * REVERTED it (lost update). Carrying the ABSOLUTE target `isCompleted` plus the
 * idempotency envelope makes any number of replays converge to the same state.
 */
@InputType()
export class SetChecklistItemInput extends MobileCommandEnvelopeInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  taskId!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  itemId!: string;

  @Field()
  @IsNotEmpty()
  @IsBoolean()
  isCompleted!: boolean;
}

/**
 * Görev güncelleme input
 */
@InputType()
export class UpdateTaskInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Field(() => TaskCategory, { nullable: true })
  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @Field(() => TaskPriority, { nullable: true })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @Field(() => TaskStatus, { nullable: true })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  assignedToName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  dueTime?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(1)
  estimatedMinutes?: number;

  @Field(() => [TaskChecklistItemInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskChecklistItemInput)
  checklistItems?: TaskChecklistItemInput[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  notes?: any;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  recurringTemplateId?: string;
}
