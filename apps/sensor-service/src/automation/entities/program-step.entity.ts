import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';

/**
 * Step type in SFC
 */
export enum StepType {
  INITIAL = 'initial',   // Entry point (one per program)
  NORMAL = 'normal',     // Regular step
  FINAL = 'final',       // Exit point (can have multiple)
}

registerEnumType(StepType, {
  name: 'StepType',
  description: 'Type of SFC step',
});

/**
 * Timeout behavior
 */
export enum TimeoutBehavior {
  ABORT = 'abort',       // Stop program execution
  SKIP = 'skip',         // Move to next step
  ALARM = 'alarm',       // Raise alarm but continue
  GOTO = 'goto',         // Jump to specific step
}

registerEnumType(TimeoutBehavior, {
  name: 'TimeoutBehavior',
  description: 'Behavior when step times out',
});

/**
 * ProgramStep entity - represents a step in SFC
 *
 * Note: This entity is for detailed editing and auditing.
 * The main SFC definition is stored as JSONB in AutomationProgram.
 */
@ObjectType()
@Entity('program_steps')
@Index(['programId', 'stepCode'], { unique: true })
@Index(['programId', 'stepType'])
export class ProgramStep {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ name: 'program_id' })
  @Index()
  programId: string;

  // Step Identity
  @Field()
  @Column({ name: 'step_code', length: 30 })
  stepCode: string;

  @Field()
  @Column({ name: 'step_name', length: 100 })
  stepName: string;

  @Field(() => StepType)
  @Column({
    name: 'step_type',
    type: 'enum',
    enum: StepType,
    default: StepType.NORMAL,
  })
  stepType: StepType;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // Visual Position (for editor)
  @Field(() => Int)
  @Column({ name: 'position_x', type: 'int', default: 0 })
  positionX: number;

  @Field(() => Int)
  @Column({ name: 'position_y', type: 'int', default: 0 })
  positionY: number;

  // IEC 61131-3 Actions (Structured Text code)
  @Field({ nullable: true, description: 'N qualifier - executed while step is active' })
  @Column({ name: 'entry_action', type: 'text', nullable: true })
  entryAction?: string;

  @Field({ nullable: true, description: 'P1 qualifier - executed once on step exit' })
  @Column({ name: 'exit_action', type: 'text', nullable: true })
  exitAction?: string;

  // Timeout Configuration
  @Field(() => Int, { nullable: true })
  @Column({ name: 'timeout_ms', type: 'int', nullable: true })
  timeoutMs?: number;

  @Field(() => TimeoutBehavior, { nullable: true })
  @Column({
    name: 'on_timeout',
    type: 'enum',
    enum: TimeoutBehavior,
    nullable: true,
  })
  onTimeout?: TimeoutBehavior;

  @Field({ nullable: true, description: 'Target step code for GOTO timeout behavior' })
  @Column({ name: 'timeout_target_step', length: 30, nullable: true })
  timeoutTargetStep?: string;

  // Ordering
  @Field(() => Int)
  @Column({ name: 'step_order', type: 'int', default: 0 })
  stepOrder: number;

  // Timestamps
  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // Relations (will be resolved in GraphQL)
  @Field(() => Int, { nullable: true })
  actionCount?: number;

  @Field(() => Int, { nullable: true })
  incomingTransitionCount?: number;

  @Field(() => Int, { nullable: true })
  outgoingTransitionCount?: number;
}
