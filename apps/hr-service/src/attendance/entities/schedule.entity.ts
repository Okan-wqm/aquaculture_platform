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
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { Shift } from './shift.entity';

export enum ScheduleType {
  FIXED = 'fixed',
  ROTATING = 'rotating',
  FLEXIBLE = 'flexible',
  OFFSHORE_ROTATION = 'offshore_rotation',
}

export enum ScheduleStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

registerEnumType(ScheduleType, { name: 'ScheduleType' });
registerEnumType(ScheduleStatus, { name: 'ScheduleStatus' });

@ObjectType()
@Entity('schedules', { schema: 'hr' })
@Index(['tenantId', 'employeeId', 'startDate', 'endDate'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'departmentId', 'startDate'])
export class Schedule {
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

  @Field({ nullable: true })
  @Column({ nullable: true })
  departmentId?: string;

  @Field()
  @Column({ nullable: true })
  shiftId?: string;

  @ManyToOne(() => Shift, { nullable: true })
  @JoinColumn({ name: 'shiftId' })
  shift?: Shift;

  @Field(() => ScheduleType)
  @Column({ type: 'enum', enum: ScheduleType, default: ScheduleType.FIXED })
  scheduleType!: ScheduleType;

  @Field()
  @Column({ type: 'date' })
  startDate!: Date;

  @Field()
  @Column({ type: 'date' })
  endDate!: Date;

  @Field(() => ScheduleStatus)
  @Column({ type: 'enum', enum: ScheduleStatus, default: ScheduleStatus.DRAFT })
  status!: ScheduleStatus;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // For offshore rotations
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  rotationDaysOn?: number;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  rotationDaysOff?: number;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  nextRotationDate?: Date;

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
