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
import { DecimalTransformer } from '@aquaculture/backend-common';
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';

export enum ReviewPeriodType {
  ANNUAL = 'ANNUAL',
  SEMI_ANNUAL = 'SEMI_ANNUAL',
  QUARTERLY = 'QUARTERLY',
  PROBATION = 'PROBATION',
  PROJECT = 'PROJECT',
}

export enum ReviewStatus {
  DRAFT = 'DRAFT',
  SELF_ASSESSMENT = 'SELF_ASSESSMENT',
  MANAGER_REVIEW = 'MANAGER_REVIEW',
  CALIBRATION = 'CALIBRATION',
  FINALIZED = 'FINALIZED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
}

registerEnumType(ReviewPeriodType, { name: 'ReviewPeriodType' });
registerEnumType(ReviewStatus, { name: 'ReviewStatus' });

@ObjectType()
export class CompetencyRating {
  @Field()
  competencyId!: string;

  @Field()
  competencyName!: string;

  @Field(() => Float, { nullable: true })
  selfRating?: number;

  @Field(() => Float, { nullable: true })
  managerRating?: number;

  @Field(() => Float, { nullable: true })
  finalRating?: number;

  @Field({ nullable: true })
  comments?: string;
}

@ObjectType()
@Entity('performance_reviews', { schema: 'hr' })
@Index('idx_perf_review_tenant_employee', ['tenantId', 'employeeId'])
@Index('idx_perf_review_tenant_reviewer', ['tenantId', 'reviewerId'])
@Index('idx_perf_review_tenant_status', ['tenantId', 'status'])
@Index('idx_perf_review_tenant_period', ['tenantId', 'periodType', 'periodStart', 'periodEnd'])
export class PerformanceReview {
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
  reviewerId!: string;

  @Field(() => Employee, { nullable: true })
  @ManyToOne(() => Employee, { nullable: true })
  @JoinColumn({ name: 'reviewerId' })
  reviewer?: Employee;

  @Field(() => ReviewPeriodType)
  @Column({ type: 'enum', enum: ReviewPeriodType })
  periodType!: ReviewPeriodType;

  @Field()
  @Column({ type: 'date' })
  periodStart!: Date;

  @Field()
  @Column({ type: 'date' })
  periodEnd!: Date;

  @Field(() => ReviewStatus)
  @Column({ type: 'enum', enum: ReviewStatus, default: ReviewStatus.DRAFT })
  status!: ReviewStatus;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  selfAssessment?: string;

  @Field(() => Float, { nullable: true })
  // DecimalTransformer: rating scores (selfRating, managerRating, overallScore) are averaged
  // to produce the final performance review score. String averaging produces NaN.
  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true , transformer: new DecimalTransformer() })
  selfRating?: number;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  managerAssessment?: string;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true , transformer: new DecimalTransformer() })
  managerRating?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true , transformer: new DecimalTransformer() })
  finalRating?: number;

  @Field(() => [CompetencyRating], { nullable: true })
  @Column('jsonb', { nullable: true })
  competencyRatings?: CompetencyRating[];

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  strengths?: string[];

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  areasForImprovement?: string[];

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  developmentPlan?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  employeeComments?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  reviewerComments?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  calibrationNotes?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  acknowledgedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  finalizedBy?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  finalizedAt?: Date;

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
