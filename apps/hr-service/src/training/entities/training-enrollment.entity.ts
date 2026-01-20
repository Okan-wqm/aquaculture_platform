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
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { TrainingCourse } from './training-course.entity';

export enum EnrollmentStatus {
  ENROLLED = 'enrolled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  PASSED = 'passed',
  FAILED = 'failed',
  WITHDRAWN = 'withdrawn',
  EXPIRED = 'expired',
}

registerEnumType(EnrollmentStatus, { name: 'EnrollmentStatus' });

@ObjectType()
export class AssessmentAttempt {
  @Field(() => Int)
  attemptNumber!: number;

  @Field(() => Float)
  score!: number;

  @Field()
  passed!: boolean;

  @Field()
  attemptedAt!: Date;

  @Field(() => Int, { nullable: true })
  durationMinutes?: number;
}

@ObjectType()
@Entity('training_enrollments', { schema: 'hr' })
@Index(['tenantId', 'employeeId', 'trainingCourseId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'enrollmentDate'])
@Index(['tenantId', 'completedAt'])
export class TrainingEnrollment {
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

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employeeId' })
  employee?: Employee;

  @Field()
  @Column()
  trainingCourseId!: string;

  @ManyToOne(() => TrainingCourse)
  @JoinColumn({ name: 'trainingCourseId' })
  trainingCourse?: TrainingCourse;

  @Field(() => EnrollmentStatus)
  @Column({ type: 'enum', enum: EnrollmentStatus, default: EnrollmentStatus.ENROLLED })
  status!: EnrollmentStatus;

  @Field()
  @Column({ type: 'date' })
  enrollmentDate!: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  dueDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  progressPercent!: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  finalScore?: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  @Field(() => [AssessmentAttempt], { nullable: true })
  @Column('jsonb', { nullable: true })
  assessmentAttempts?: AssessmentAttempt[];

  @Field({ nullable: true })
  @Column({ nullable: true })
  certificateId?: string; // Generated certificate

  @Field({ nullable: true })
  @Column({ nullable: true })
  sessionId?: string; // For in-person training

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  instructor?: string;

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  location?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  feedback?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  feedbackRating?: number; // 1-5

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
}
