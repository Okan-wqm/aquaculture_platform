import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';

export enum HolidayType {
  NATIONAL = 'national', // Resmi tatil
  RELIGIOUS = 'religious', // Dini bayram
  REGIONAL = 'regional', // Bolgesel tatil
  COMPANY = 'company', // Sirket tatili
}

registerEnumType(HolidayType, { name: 'HolidayType' });

/**
 * Public/Company holidays entity
 * Tracks holidays that affect work scheduling
 */
@ObjectType()
@Entity('holidays')
@Index(['tenantId', 'date'])
@Index(['tenantId', 'startDate', 'endDate'])
@Index(['tenantId', 'isActive', 'affectsScheduling']) // For conflict detection queries
export class Holiday {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  @Index()
  tenantId!: string;

  @Field()
  @Column()
  name!: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  localName?: string; // Turkish name

  @Field(() => Date)
  @Column({ type: 'date' })
  date!: Date; // For single-day holidays

  @Field(() => Date)
  @Column({ type: 'date' })
  startDate!: Date;

  @Field(() => Date)
  @Column({ type: 'date' })
  endDate!: Date;

  @Field(() => HolidayType)
  @Column({ type: 'enum', enum: HolidayType, default: HolidayType.NATIONAL })
  type!: HolidayType;

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field()
  @Column({ default: false })
  isPaidLeave!: boolean; // Does it count as paid leave?

  @Field()
  @Column({ default: true })
  affectsScheduling!: boolean; // Should it block work assignments?

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
}
