import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';

export enum GoalStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  DEFERRED = 'DEFERRED',
}

export enum GoalPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

registerEnumType(GoalStatus, { name: 'GoalStatus' });
registerEnumType(GoalPriority, { name: 'GoalPriority' });

@ObjectType()
export class KeyResult {
  @Field(() => ID)
  id!: string;

  @Field()
  description!: string;

  @Field(() => Float)
  targetValue!: number;

  @Field(() => Float)
  currentValue!: number;

  @Field({ nullable: true })
  unit?: string;

  @Field()
  isCompleted!: boolean;
}

@ObjectType()
export class GoalMilestone {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  targetDate!: string;

  @Field({ nullable: true })
  completedDate?: string;

  @Field()
  isCompleted!: boolean;
}

@ObjectType()
@Entity('goals')
@Index('idx_goal_tenant_employee', ['tenantId', 'employeeId'])
@Index('idx_goal_tenant_status', ['tenantId', 'status'])
@Index('idx_goal_tenant_priority', ['tenantId', 'priority'])
@Index('idx_goal_tenant_target_date', ['tenantId', 'targetDate'])
@Index('idx_goal_parent', ['parentGoalId'])
export class Goal {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  employeeId!: string;

  @Field(() => Employee, { nullable: true })
  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field()
  @Column()
  title!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  category?: string;

  @Field(() => GoalPriority)
  @Column({ type: 'enum', enum: GoalPriority, default: GoalPriority.MEDIUM })
  priority!: GoalPriority;

  @Field(() => GoalStatus)
  @Column({ type: 'enum', enum: GoalStatus, default: GoalStatus.NOT_STARTED })
  status!: GoalStatus;

  @Field()
  @Column({ type: 'date' })
  startDate!: Date;

  @Field()
  @Column({ type: 'date' })
  targetDate!: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  completedDate?: Date;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  progressPercent!: number;

  @Field(() => [KeyResult], { nullable: true })
  @Column('jsonb', { nullable: true })
  keyResults?: KeyResult[];

  @Field({ nullable: true })
  @Column({ nullable: true })
  alignedReviewId?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  parentGoalId?: string;

  @Field(() => Goal, { nullable: true })
  @ManyToOne(() => Goal, (goal) => goal.childGoals, { nullable: true })
  @JoinColumn({ name: 'parentGoalId' })
  parentGoal?: Goal;

  @Field(() => [Goal], { nullable: true })
  @OneToMany(() => Goal, (goal) => goal.parentGoal)
  childGoals?: Goal[];

  @Field(() => [GoalMilestone], { nullable: true })
  @Column('jsonb', { nullable: true })
  milestones?: GoalMilestone[];

  /**
   * Virtual field: number of days past target date.
   * Populated by query handlers for overdue goal queries, not persisted.
   */
  @Field(() => Int, { nullable: true })
  daysOverdue?: number;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;

  @Field()
  @Column({ default: false })
  isDeleted!: boolean;
}
