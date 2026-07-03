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
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { TrainingCourse } from './training-course.entity';

/**
 * Lifecycle of a scheduled training session.
 *
 * SCHEDULED   — published on the calendar, accepting enrolments
 * IN_PROGRESS — running now
 * COMPLETED   — finished
 * CANCELLED   — called off; freed slots, no longer on the active calendar
 */
export enum TrainingSessionStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

registerEnumType(TrainingSessionStatus, { name: 'TrainingSessionStatus' });

/**
 * A scheduled occurrence of a TrainingCourse — the unit the training calendar is
 * built from. Per-tenant (no `schema:` — routed into tenant_<uuid> at runtime,
 * like the sibling training_courses / training_enrollments tables). Enrolments
 * reference a session via TrainingEnrollment.sessionId; enrolledCount /
 * availableSlots are derived in GetTrainingCalendarHandler, never stored.
 */
@ObjectType()
@Entity('training_sessions')
@Index(['tenantId', 'sessionDate'])
@Index(['tenantId', 'trainingCourseId'])
@Index(['tenantId', 'status'])
export class TrainingSession {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  trainingCourseId!: string;

  @ManyToOne(() => TrainingCourse)
  @JoinColumn({ name: 'trainingCourseId' })
  trainingCourse?: TrainingCourse;

  @Field()
  @Column({ type: 'date' })
  sessionDate!: Date;

  @Field()
  @Column({ type: 'time' })
  startTime!: string;

  @Field()
  @Column({ type: 'time' })
  endTime!: string;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  location?: string;

  // Free-text instructor name OR an employee id reference — kept as a string so a
  // session can name an external trainer who is not an Employee row.
  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  instructor?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  maxParticipants?: number;

  @Field(() => TrainingSessionStatus)
  @Column({ type: 'enum', enum: TrainingSessionStatus, default: TrainingSessionStatus.SCHEDULED })
  status!: TrainingSessionStatus;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

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

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedBy?: string;

  // ---------------------------------------------------------------------------
  // Non-persisted projection fields (assembled by GetTrainingCalendarHandler).
  // No @Column — enrolledCount counts TrainingEnrollment rows whose sessionId
  // references this session; availableSlots = maxParticipants - enrolledCount.
  // courseId/courseName are the FE-facing calendar field names: courseId aliases
  // the stored trainingCourseId; courseName is resolved from the linked course.
  // ---------------------------------------------------------------------------

  /** FE-facing alias of trainingCourseId for the calendar item shape. */
  @Field(() => ID)
  get courseId(): string {
    return this.trainingCourseId;
  }

  /** Linked course name, resolved by the calendar query handler. */
  @Field({ nullable: true })
  courseName?: string;

  @Field(() => Int, { nullable: true })
  enrolledCount?: number;

  @Field(() => Int, { nullable: true })
  availableSlots?: number;
}
