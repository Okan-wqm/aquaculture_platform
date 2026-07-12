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
import { DecimalTransformer } from '@aquaculture/backend-common/database';
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
@Entity('payrolls')
@Index(['tenantId', 'employeeId', 'payPeriodStart', 'payPeriodEnd'], { unique: true })
@Index(['tenantId', 'payrollNumber'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'paymentDate'])
@Index(['tenantId', 'payPeriodStart'])
export class Payroll {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // REMOVED: @Index() on tenantId — redundant with composite indexes
  // that start with tenantId (e.g., the unique composite on tenantId+employeeId+payPeriod).
  // @see DB-MEDIUM-002
  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  // REMOVED: @Index() on employeeId — redundant with the unique composite index
  // on (tenantId, employeeId, payPeriodStart, payPeriodEnd).
  // @see DB-MEDIUM-002
  @Field()
  @Column()
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

  // ── Flattened Earnings Columns ──
  // IMPORTANT: Earnings breakdown previously stored as a single JSONB column.
  // Flattened to typed numeric columns for:
  // 1. Type safety: prevents NaN from string arithmetic on JSONB values
  // 2. Query performance: direct column aggregation (SUM, AVG) without JSON extraction
  // 3. Schema enforcement: database rejects invalid types at write time
  // @see DB-MEDIUM-004

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  earningsBaseSalary!: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  earningsOvertime?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  earningsBonus?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  earningsCommission?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  earningsAllowances?: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  earningsGrossPay!: number;

  // ── Flattened Deductions Columns ──
  // @see DB-MEDIUM-004

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  deductionsTax?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  deductionsSocialSecurity?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  deductionsHealthInsurance?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  deductionsRetirement?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  deductionsOther?: number;

  @Field(() => Float)
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
  deductionsTotal!: number;

  /**
   * Virtual getter providing the legacy EarningsBreakdown shape for backward compatibility.
   * GraphQL resolvers can use this to maintain the nested response structure.
   *
   * DB-PEOPLE-HIGH-001: the @Field was missing, so the `hr` subgraph exposed only
   * the flat earnings* columns while the hr-module PAYROLL_FRAGMENT selects the
   * nested `earnings { baseSalary … grossPay }` — gateway-validation-400 on all
   * payroll ops. Exposing this getter (its shape already matches EarningsBreakdown
   * @ObjectType field-for-field) completes the intended design; storage stays flat.
   */
  @Field(() => EarningsBreakdown)
  get earnings(): EarningsBreakdown {
    return {
      baseSalary: this.earningsBaseSalary,
      overtime: this.earningsOvertime,
      bonus: this.earningsBonus,
      commission: this.earningsCommission,
      allowances: this.earningsAllowances,
      grossPay: this.earningsGrossPay,
    };
  }

  /**
   * Virtual getter providing the legacy DeductionsBreakdown shape for backward compatibility.
   * DB-PEOPLE-HIGH-001: @Field was missing (same defect as `earnings` above) — the
   * hr-module fragment selects nested `deductions { tax … totalDeductions }`.
   */
  @Field(() => DeductionsBreakdown)
  get deductions(): DeductionsBreakdown {
    return {
      tax: this.deductionsTax,
      socialSecurity: this.deductionsSocialSecurity,
      healthInsurance: this.deductionsHealthInsurance,
      retirement: this.deductionsRetirement,
      otherDeductions: this.deductionsOther,
      totalDeductions: this.deductionsTotal,
    };
  }

  @Field(() => Float)
  // DecimalTransformer: netPay = earningsGrossPay - deductionsTotal.
  // Both operands are now typed decimal columns (not JSONB), eliminating
  // the NaN risk from string arithmetic.
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: new DecimalTransformer() })
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
