import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { WeekDay } from '../../attendance/entities/shift.entity';

@ObjectType()
@Entity('scheduling_settings')
export class SchedulingSettings {
  @Field(() => ID)
  @PrimaryColumn('uuid')
  tenantId!: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 2700 }) // 45 hours in minutes
  standardWeeklyMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 720 }) // 12 hours in minutes
  maxOvertimeMinutesPerWeek!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 2880 }) // 48 hours in minutes
  maxOvertimeMinutesPerMonth!: number;

  @Field({ nullable: true })
  @Column({ nullable: true })
  defaultShiftId?: string;

  @Field(() => WeekDay)
  @Column({ type: 'enum', enum: WeekDay, default: WeekDay.MONDAY })
  workWeekStartDay!: WeekDay;

  @Field()
  @Column({ default: true })
  autoNotifyEmployees!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 2 }) // Days before week starts
  notifyDaysBefore!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 6 }) // Max consecutive work days
  maxConsecutiveWorkDays!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 660 }) // 11 hours minimum rest between shifts
  minRestMinutesBetweenShifts!: number;

  @Field()
  @Column({ default: true })
  allowOvertimeWithoutApproval!: boolean;

  @Field()
  @CreateDateColumn()
  createdAt!: Date;

  @Field()
  @UpdateDateColumn()
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column({ nullable: true })
  updatedBy?: string;

  @Field(() => Int)
  @VersionColumn()
  version!: number;
}
