import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';

export enum TrainingType {
  ONLINE = 'online',
  IN_PERSON = 'in_person',
  BLENDED = 'blended',
  ON_THE_JOB = 'on_the_job',
  SELF_PACED = 'self_paced',
}

export enum TrainingLevel {
  BEGINNER = 'beginner',
  INTERMEDIATE = 'intermediate',
  ADVANCED = 'advanced',
  EXPERT = 'expert',
}

registerEnumType(TrainingType, { name: 'TrainingType' });
registerEnumType(TrainingLevel, { name: 'TrainingLevel' });

@ObjectType()
@Entity('training_courses', { schema: 'hr' })
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'isMandatory'])
@Index(['tenantId', 'isActive'])
export class TrainingCourse {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 30 })
  code!: string;

  @Field()
  @Column({ length: 200 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => TrainingType)
  @Column({ type: 'enum', enum: TrainingType, default: TrainingType.IN_PERSON })
  trainingType!: TrainingType;

  @Field(() => TrainingLevel)
  @Column({ type: 'enum', enum: TrainingLevel, default: TrainingLevel.BEGINNER })
  level!: TrainingLevel;

  @Field(() => Int)
  @Column({ type: 'int', default: 60 })
  durationMinutes!: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 8, scale: 2, nullable: true })
  cost?: number;

  @Field()
  @Column({ default: false })
  isMandatory!: boolean;

  @Field()
  @Column({ default: false })
  requiresAssessment!: boolean;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  passingScore?: number; // Percentage

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  maxAttempts?: number;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  validityMonths?: number; // If needs renewal

  @Field({ nullable: true })
  @Column({ nullable: true })
  certificationTypeId?: string; // Links to certification

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  prerequisites?: string[]; // Other courses required first

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  targetRoles?: string[]; // Job roles this applies to

  @Field(() => [String], { nullable: true })
  @Column('simple-array', { nullable: true })
  targetDepartments?: string[];

  @Field()
  @Column({ default: false })
  isOffshoreRequired!: boolean;

  @Field({ nullable: true })
  @Column({ length: 500, nullable: true })
  externalUrl?: string; // For online courses

  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  provider?: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  displayOrder!: number;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

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
