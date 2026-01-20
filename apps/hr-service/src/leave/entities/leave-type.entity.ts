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

export enum LeaveCategory {
  ANNUAL = 'annual',
  SICK = 'sick',
  PARENTAL = 'parental',
  BEREAVEMENT = 'bereavement',
  PERSONAL = 'personal',
  STUDY = 'study',
  SABBATICAL = 'sabbatical',
  COMPENSATORY = 'compensatory',
  SHORE_LEAVE = 'shore_leave',
  ROTATION_BREAK = 'rotation_break',
  EMERGENCY = 'emergency',
  UNPAID = 'unpaid',
  OTHER = 'other',
}

registerEnumType(LeaveCategory, { name: 'LeaveCategory' });

@ObjectType()
@Entity('leave_types', { schema: 'hr' })
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'category'])
@Index(['tenantId', 'isActive'])
export class LeaveType {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 100 })
  name!: string;

  @Field()
  @Column({ length: 20 })
  code!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => LeaveCategory)
  @Column({ type: 'enum', enum: LeaveCategory, default: LeaveCategory.ANNUAL })
  category!: LeaveCategory;

  @Field()
  @Column({ default: true })
  isPaid!: boolean;

  @Field()
  @Column({ default: true })
  isAccrued!: boolean;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  defaultDaysPerYear?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  maxCarryOverDays?: number;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  maxConsecutiveDays?: number;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  minDaysNotice?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  accrualRate?: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  accrualStartAfterMonths!: number;

  @Field()
  @Column({ default: true })
  requiresApproval!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 1 })
  approvalLevels!: number;

  @Field()
  @Column({ default: false })
  isAquacultureSpecific!: boolean;

  @Field()
  @Column({ default: true })
  applicableForOffshore!: boolean;

  @Field({ nullable: true })
  @Column({ length: 7, nullable: true })
  color?: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

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

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  deletedBy?: string;
}
