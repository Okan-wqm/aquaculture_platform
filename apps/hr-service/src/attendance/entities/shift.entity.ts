import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';

export enum ShiftType {
  REGULAR = 'regular',
  OFFSHORE = 'offshore',
  NIGHT = 'night',
  ROTATION = 'rotation',
  FLEXIBLE = 'flexible',
}

export enum WeekDay {
  MONDAY = 'monday',
  TUESDAY = 'tuesday',
  WEDNESDAY = 'wednesday',
  THURSDAY = 'thursday',
  FRIDAY = 'friday',
  SATURDAY = 'saturday',
  SUNDAY = 'sunday',
}

registerEnumType(ShiftType, { name: 'ShiftType' });
registerEnumType(WeekDay, { name: 'WeekDay' });

@ObjectType()
export class BreakPeriod {
  @Field()
  startTime!: string; // HH:mm format

  @Field()
  endTime!: string; // HH:mm format

  @Field()
  isPaid!: boolean;
}

@ObjectType()
@Entity('shifts', { schema: 'hr' })
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'isActive'])
@Index(['tenantId', 'shiftType'])
export class Shift {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column()
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 20 })
  code!: string;

  @Field()
  @Column({ length: 100 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => ShiftType)
  @Column({ type: 'enum', enum: ShiftType, default: ShiftType.REGULAR })
  shiftType!: ShiftType;

  @Field()
  @Column({ type: 'time' })
  startTime!: string;

  @Field()
  @Column({ type: 'time' })
  endTime!: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 480 }) // 8 hours in minutes
  totalMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  breakMinutes!: number;

  @Field(() => [BreakPeriod], { nullable: true })
  @Column('jsonb', { nullable: true })
  breakPeriods?: BreakPeriod[];

  @Field(() => [WeekDay])
  @Column('simple-array', { default: 'monday,tuesday,wednesday,thursday,friday' })
  workDays!: WeekDay[];

  @Field()
  @Column({ default: false })
  crossesMidnight!: boolean;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 }) // Grace period in minutes for late arrivals
  graceMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 }) // Early clock-in allowed before shift starts
  earlyClockInMinutes!: number;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 }) // Late clock-out allowed after shift ends
  lateClockOutMinutes!: number;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field({ nullable: true })
  @Column({ length: 7, nullable: true }) // Hex color code for UI
  colorCode?: string;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  displayOrder!: number;

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
