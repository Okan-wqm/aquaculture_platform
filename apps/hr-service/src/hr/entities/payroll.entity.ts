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
import { ObjectType, Field, ID, Int, registerEnumType, Float } from '@nestjs/graphql';
import { Employee } from './employee.entity';

export enum PayrollStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  PROCESSING = 'processing',
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

export enum PayPeriodType {
  WEEKLY = 'weekly',
  BI_WEEKLY = 'bi_weekly',
  SEMI_MONTHLY = 'semi_monthly',
  MONTHLY = 'monthly',
}

registerEnumType(PayrollStatus, { name: 'PayrollStatus' });
registerEnumType(PayPeriodType, { name: 'PayPeriodType' });

@ObjectType()
export class EarningsBreakdown {
  @Field(() => Float)
  baseSalary!: number;

  @Field(() => Float, { nullable: true })
  overtime?: number;

  @Field(() => Float, { nullable: true })
  bonus?: number;

  @Field(() => Float, { nullable: true })
  commission?: number;

  @Field(() => Float, { nullable: true })
  allowances?: number;

  @Field(() => Float)
  grossPay!: number;
}

@ObjectType()
export class DeductionsBreakdown {
  @Field(() => Float, { nullable: true })
  tax?: number;

  @Field(() => Float, { nullable: true })
  socialSecurity?: number;

  @Field(() => Float, { nullable: true })
  healthInsurance?: number;

  @Field(() => Float, { nullable: true })
  retirement?: number;

  @Field(() => Float, { nullable: true })
  otherDeductions?: number;

  @Field(() => Float)
  totalDeductions!: number;
}

@ObjectType()
export class WorkHours {
  @Field(() => Float)
  regularHours!: number;

  @Field(() => Float, { nullable: true })
  overtimeHours?: number;

  @Field(() => Float, { nullable: true })
  holidayHours?: number;

  @Field(() => Float, { nullable: true })
  sickLeaveHours?: number;

  @Field(() => Float, { nullable: true })
  vacationHours?: number;
}

@ObjectType()
@Entity('payrolls', { schema: 'hr' })
@Index(['tenantId', 'employeeId', 'payPeriodStart', 'payPeriodEnd'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'paymentDate'])
@Index(['tenantId', 'payPeriodStart'])
export class Payroll {
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

  @Field(() => Employee)
  @ManyToOne(() => Employee, (employee) => employee.payrolls)
  @JoinColumn({ name: 'employeeId' })
  employee!: Employee;

  @Field()
  @Column()
  payrollNumber!: string;

  @Field(() => PayPeriodType)
  @Column({ type: 'enum', enum: PayPeriodType })
  payPeriodType!: PayPeriodType;

  @Field(() => Date)
  @Column({ type: 'date' })
  payPeriodStart!: Date;

  @Field(() => Date)
  @Column({ type: 'date' })
  payPeriodEnd!: Date;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'date', nullable: true })
  paymentDate?: Date;

  @Field(() => WorkHours)
  @Column('jsonb')
  workHours!: WorkHours;

  @Field(() => EarningsBreakdown)
  @Column('jsonb')
  earnings!: EarningsBreakdown;

  @Field(() => DeductionsBreakdown)
  @Column('jsonb')
  deductions!: DeductionsBreakdown;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2 })
  netPay!: number;

  @Field()
  @Column({ default: 'USD' })
  currency!: string;

  @Field(() => PayrollStatus)
  @Column({ type: 'enum', enum: PayrollStatus, default: PayrollStatus.DRAFT })
  status!: PayrollStatus;

  @Field({ nullable: true })
  @Column({ nullable: true })
  approvedBy?: string;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field({ nullable: true })
  @Column({ nullable: true })
  paymentReference?: string;

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
}
