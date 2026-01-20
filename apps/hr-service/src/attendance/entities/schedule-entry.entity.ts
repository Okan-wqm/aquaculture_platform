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
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Schedule } from './schedule.entity';
import { Shift } from './shift.entity';

export enum ScheduleEntryStatus {
  SCHEDULED = 'scheduled',
  COMPLETED = 'completed',
  ABSENT = 'absent',
  LEAVE = 'leave',
  HOLIDAY = 'holiday',
  MODIFIED = 'modified',
}

registerEnumType(ScheduleEntryStatus, { name: 'ScheduleEntryStatus' });

@ObjectType()
@Entity('schedule_entries', { schema: 'hr' })
@Index(['tenantId', 'scheduleId', 'date'])
@Index(['tenantId', 'employeeId', 'date'])
@Index(['tenantId', 'date', 'status'])
export class ScheduleEntry {
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
  scheduleId!: string;

  @ManyToOne(() => Schedule, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scheduleId' })
  schedule?: Schedule;

  @Field()
  @Column()
  @Index()
  employeeId!: string;

  @Field()
  @Column({ type: 'date' })
  date!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  shiftId?: string;

  @ManyToOne(() => Shift, { nullable: true })
  @JoinColumn({ name: 'shiftId' })
  shift?: Shift;

  @Field({ nullable: true })
  @Column({ type: 'time', nullable: true })
  plannedStartTime?: string;

  @Field({ nullable: true })
  @Column({ type: 'time', nullable: true })
  plannedEndTime?: string;

  @Field(() => ScheduleEntryStatus)
  @Column({ type: 'enum', enum: ScheduleEntryStatus, default: ScheduleEntryStatus.SCHEDULED })
  status!: ScheduleEntryStatus;

  @Field()
  @Column({ default: false })
  isOffDay!: boolean;

  @Field()
  @Column({ default: false })
  isOverride!: boolean; // Manual override from original schedule

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
}
