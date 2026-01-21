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
 * Transition condition type
 */
export enum ConditionType {
  EXPRESSION = 'expression',   // IEC 61131-3 ST expression
  TIMEOUT = 'timeout',         // Timer-based transition
  ALWAYS = 'always',           // Always fires (TRUE)
  EVENT = 'event',             // External event trigger
}

registerEnumType(ConditionType, {
  name: 'ConditionType',
  description: 'Type of transition condition',
});

/**
 * ProgramTransition entity - represents a transition between SFC steps
 *
 * Transitions define the conditions under which execution moves from
 * one step to another.
 */
@ObjectType()
@Entity('program_transitions')
@Index(['programId', 'transitionCode'], { unique: true })
@Index(['programId', 'fromStepId'])
@Index(['programId', 'toStepId'])
export class ProgramTransition {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ name: 'program_id' })
  @Index()
  programId: string;

  // Transition Identity
  @Field()
  @Column({ name: 'transition_code', length: 30 })
  transitionCode: string;

  @Field({ nullable: true })
  @Column({ name: 'transition_name', length: 100, nullable: true })
  transitionName?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // Step References
  @Field()
  @Column({ name: 'from_step_id' })
  fromStepId: string;

  @Field()
  @Column({ name: 'to_step_id' })
  toStepId: string;

  // For convenience, also store step codes
  @Field({ nullable: true })
  @Column({ name: 'from_step_code', length: 30, nullable: true })
  fromStepCode?: string;

  @Field({ nullable: true })
  @Column({ name: 'to_step_code', length: 30, nullable: true })
  toStepCode?: string;

  // Condition
  @Field(() => ConditionType)
  @Column({
    name: 'condition_type',
    type: 'enum',
    enum: ConditionType,
    default: ConditionType.EXPRESSION,
  })
  conditionType: ConditionType;

  @Field({ description: 'IEC 61131-3 Structured Text expression' })
  @Column({ name: 'condition_expression', type: 'text' })
  conditionExpression: string;

  // Transpiled condition (JavaScript for Node-RED)
  @Column({ name: 'transpiled_condition', type: 'text', nullable: true })
  transpiledCondition?: string;

  // Priority for divergence (multiple transitions from same step)
  @Field(() => Int, { description: 'Priority for parallel transitions (lower = higher priority)' })
  @Column({ type: 'int', default: 1 })
  priority: number;

  // Visual representation (control points for curved lines)
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ name: 'control_points', type: 'jsonb', nullable: true })
  controlPoints?: {
    x: number;
    y: number;
  }[];

  // Timing (for TIMEOUT condition type)
  @Field(() => Int, { nullable: true, description: 'Timeout in milliseconds' })
  @Column({ name: 'timeout_ms', type: 'int', nullable: true })
  timeoutMs?: number;

  // Event reference (for EVENT condition type)
  @Field({ nullable: true })
  @Column({ name: 'event_type', length: 50, nullable: true })
  eventType?: string;

  // Flags
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

  // Computed fields
  @Field({ nullable: true })
  fromStepName?: string;

  @Field({ nullable: true })
  toStepName?: string;
}
