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
  ManyToOne,
  JoinColumn,
} from 'typeorm';

/**
 * IEC 61131-3 Action Qualifiers
 */
export enum ActionQualifier {
  N = 'N',     // Non-stored (executed while step is active)
  R = 'R',     // Reset (overrides stored actions)
  S = 'S',     // Set (stored, persists after step deactivates)
  L = 'L',     // Time Limited (executes for duration)
  D = 'D',     // Time Delayed (executes after delay)
  P = 'P',     // Pulse (single execution on entry)
  P0 = 'P0',   // Pulse on deactivation
  P1 = 'P1',   // Pulse on activation
  SD = 'SD',   // Stored and time Delayed
  DS = 'DS',   // Delayed and Stored
  SL = 'SL',   // Stored and time Limited
}

registerEnumType(ActionQualifier, {
  name: 'ActionQualifier',
  description: 'IEC 61131-3 action qualifier determining when/how action executes',
});

/**
 * Action type
 */
export enum ActionType {
  SET_OUTPUT = 'set_output',       // Set digital/analog output
  CALL_FB = 'call_fb',             // Call function block
  ASSIGN = 'assign',               // Assign variable
  LOG = 'log',                     // Log message
  ALARM = 'alarm',                 // Raise/clear alarm
  TIMER = 'timer',                 // Timer operation
  CUSTOM_ST = 'custom_st',         // Custom Structured Text
}

registerEnumType(ActionType, {
  name: 'ActionType',
  description: 'Type of action to perform',
});

/**
 * StepAction entity - IEC 61131-3 compliant step actions
 *
 * Actions are associated with steps and execute based on their qualifier.
 */
@ObjectType()
@Entity('step_actions')
@Index(['stepId', 'actionOrder'])
export class StepAction {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ name: 'step_id' })
  @Index()
  stepId: string;

  // Action Identity
  @Field()
  @Column({ name: 'action_name', length: 50 })
  actionName: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // IEC 61131-3 Qualifier
  @Field(() => ActionQualifier)
  @Column({
    type: 'enum',
    enum: ActionQualifier,
    default: ActionQualifier.N,
  })
  qualifier: ActionQualifier;

  @Field(() => ActionType)
  @Column({
    name: 'action_type',
    type: 'enum',
    enum: ActionType,
    default: ActionType.CUSTOM_ST,
  })
  actionType: ActionType;

  // Action Content (Structured Text code)
  @Field()
  @Column({ name: 'action_code', type: 'text' })
  actionCode: string;

  // Target (for SET_OUTPUT, CALL_FB, ASSIGN)
  @Field({ nullable: true, description: 'Target variable/output/function block' })
  @Column({ name: 'target_ref', length: 100, nullable: true })
  targetRef?: string;

  // Parameters (for CALL_FB, etc.)
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  params?: Record<string, unknown>;

  // Timing (for L, D qualifiers)
  @Field(() => Int, { nullable: true, description: 'Delay in milliseconds (D qualifier)' })
  @Column({ name: 'delay_ms', type: 'int', nullable: true })
  delayMs?: number;

  @Field(() => Int, { nullable: true, description: 'Duration in milliseconds (L qualifier)' })
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs?: number;

  // Ordering
  @Field(() => Int)
  @Column({ name: 'action_order', type: 'int', default: 0 })
  actionOrder: number;

  // Active flag
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
