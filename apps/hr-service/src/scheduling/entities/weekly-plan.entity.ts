import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { WeeklyPlanEntry } from './weekly-plan-entry.entity';

export enum WeeklyPlanStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  /** HR-HIGH-001: Terminal state — plan completed its week. No further edits allowed. */
  CLOSED = 'closed',
}

registerEnumType(WeeklyPlanStatus, { name: 'WeeklyPlanStatus' });

@ObjectType()
@Entity('weekly_plans')
@Index(['tenantId', 'employeeId', 'weekStartDate'], { unique: true })
@Index(['tenantId', 'weekStartDate'])
@Index(['tenantId', 'weekEndDate']) // For date range queries (overtime summary)
@Index(['tenantId', 'status'])
@Index(['tenantId', 'isDeleted']) // For soft delete filtering
export class WeeklyPlan {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  @Index()
  employeeId!: string;

  @Field(() => Employee, { nullable: true })
  @ManyToOne(() => Employee, { nullable: true })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field(() => Date)
  @Column({ type: 'date' })
  weekStartDate!: Date; // Always Monday (ISO week)

  @Field(() => Date)
  @Column({ type: 'date' })
  weekEndDate!: Date; // Always Sunday

  @Field(() => WeeklyPlanStatus)
  @Column({ type: 'enum', enum: WeeklyPlanStatus, default: WeeklyPlanStatus.DRAFT })
  status!: WeeklyPlanStatus;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  plannedWorkDays!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  plannedOffDays!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  plannedTotalMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 2700 }) // Default 45 hours
  standardWeeklyMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  plannedOvertimeMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  actualOvertimeMinutes!: number; // Calculated from attendance records

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  notifiedAt?: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field(() => [WeeklyPlanEntry], { nullable: true })
  @OneToMany(() => WeeklyPlanEntry, (entry) => entry.weeklyPlan, { cascade: true })
  entries?: WeeklyPlanEntry[];

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

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedAt?: Date;
}
