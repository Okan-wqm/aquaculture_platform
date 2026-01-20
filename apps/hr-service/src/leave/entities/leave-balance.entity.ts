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
import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';
import { Employee } from '../../hr/entities/employee.entity';
import { LeaveType } from './leave-type.entity';

@ObjectType()
@Entity('leave_balances', { schema: 'hr' })
@Index(['tenantId', 'employeeId', 'leaveTypeId', 'year'], { unique: true })
@Index(['tenantId', 'employeeId', 'year'])
@Index(['tenantId', 'leaveTypeId', 'year'])
export class LeaveBalance {
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
  leaveTypeId!: string;

  @ManyToOne(() => LeaveType, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'leaveTypeId' })
  leaveType?: LeaveType;

  @Field(() => Int)
  @Column({ type: 'int' })
  year!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  openingBalance!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  accrued!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  used!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  pending!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  adjustment!: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  carriedOver!: number;

  @Field(() => Float)
  get currentBalance(): number {
    return (
      Number(this.openingBalance) +
      Number(this.accrued) +
      Number(this.carriedOver) +
      Number(this.adjustment) -
      Number(this.used) -
      Number(this.pending)
    );
  }

  @Field(() => Float)
  get availableBalance(): number {
    return (
      Number(this.openingBalance) +
      Number(this.accrued) +
      Number(this.carriedOver) +
      Number(this.adjustment) -
      Number(this.used) -
      Number(this.pending)
    );
  }

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  lastAccrualDate?: Date;

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
