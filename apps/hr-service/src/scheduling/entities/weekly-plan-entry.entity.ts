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
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { WeekDay } from '../../attendance/entities/shift.entity';
import { Shift } from '../../attendance/entities/shift.entity';
import { WeeklyPlan } from './weekly-plan.entity';
import { LeaveRequest } from '../../leave/entities/leave-request.entity';

export enum WeeklyPlanEntryType {
  WORK = 'work',
  OFF = 'off',
  LEAVE = 'leave',
  HOLIDAY = 'holiday',
  TRAINING = 'training',
}

registerEnumType(WeeklyPlanEntryType, { name: 'WeeklyPlanEntryType' });

@ObjectType()
@Entity('weekly_plan_entries')
@Index(['tenantId', 'weeklyPlanId'])
@Index(['tenantId', 'employeeId', 'date'], { unique: true })
@Index(['tenantId', 'date'])
export class WeeklyPlanEntry {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  weeklyPlanId!: string;

  @Field(() => WeeklyPlan)
  @ManyToOne(() => WeeklyPlan, (plan) => plan.entries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'weeklyPlanId' })
  weeklyPlan!: WeeklyPlan;

  @Field()
  @Column()
  employeeId!: string; // Denormalized for query efficiency

  @Field(() => Date)
  @Column({ type: 'date' })
  date!: Date;

  @Field(() => WeekDay)
  @Column({ type: 'enum', enum: WeekDay })
  dayOfWeek!: WeekDay;

  @Field({ nullable: true })
  @Column({ nullable: true })
  shiftId?: string;

  @Field(() => Shift, { nullable: true })
  @ManyToOne(() => Shift, { nullable: true })
  @JoinColumn({ name: 'shiftId' })
  shift?: Shift;

  @Field()
  @Column({ default: false })
  isOffDay!: boolean;

  @Field()
  @Column({ default: false })
  isLeaveDay!: boolean;

  @Field({ nullable: true })
  @Column({ nullable: true })
  leaveRequestId?: string;

  @Field(() => LeaveRequest, { nullable: true })
  @ManyToOne(() => LeaveRequest, { nullable: true })
  @JoinColumn({ name: 'leaveRequestId' })
  leaveRequest?: LeaveRequest;

  /**
   * HR-MEDIUM-003: Changed from `time` (no timezone) to `timestamptz`.
   * When employees move between sites in different timezones, `time` without
   * timezone makes shift boundaries ambiguous. With `timestamptz`, PostgreSQL
   * stores the absolute UTC instant and converts to/from the session timezone.
   *
   * BREAKING CHANGE: Column type changed from `time` to `timestamptz`.
   * Migration required: ALTER COLUMN planned_start_time TYPE timestamptz.
   */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  plannedStartTime?: Date; // UTC instant, overrides shift if set

  /** HR-MEDIUM-003: See plannedStartTime for rationale. */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  plannedEndTime?: Date; // UTC instant, overrides shift if set

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  plannedMinutes!: number;

  @Field(() => WeeklyPlanEntryType)
  @Column({ type: 'enum', enum: WeeklyPlanEntryType, default: WeeklyPlanEntryType.WORK })
  entryType!: WeeklyPlanEntryType;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  displayOrder!: number;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;
}
