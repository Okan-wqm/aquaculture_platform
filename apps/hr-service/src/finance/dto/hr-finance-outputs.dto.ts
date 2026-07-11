/**
 * HR finance read-model GraphQL types.
 *
 * HrLabourCost is the single consistent snapshot behind the three
 * user-facing tables — Personnel Table (headcounts), Personnel Salary
 * (per-person annual salary per category) and Labour Cost (salary
 * totals + fund projections + total payroll).
 */
import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

import { LaborCategory } from '../../hr/entities/employee.entity';

/**
 * Headcount-only projection of the workforce, with NO salary (HR-MEDIUM-005).
 * A MODULE_MANAGER always sees this; the salary-bearing `hrLabourCost` is gated
 * by the tenant-assignable `hr_finance:view_salary` permission. Keeping the two
 * read models separate makes the salary boundary a guard verdict, not a field
 * the manager query happens not to select.
 */
@ObjectType()
export class HrPersonnelRow {
  /** Null = unclassified employees (no laborCategory assigned yet). */
  @Field(() => LaborCategory, { nullable: true })
  category?: LaborCategory | null;

  @Field(() => Int)
  headcount!: number;
}

@ObjectType()
export class HrPersonnelTable {
  @Field(() => [HrPersonnelRow])
  rows!: HrPersonnelRow[];

  @Field(() => Int)
  totalHeadcount!: number;

  /** Employees without a laborCategory — surface a classify-me warning. */
  @Field(() => Int)
  unclassifiedCount!: number;
}

@ObjectType()
export class HrLabourCostRow {
  /** Null = unclassified employees (no laborCategory assigned yet). */
  @Field(() => LaborCategory, { nullable: true })
  category?: LaborCategory | null;

  @Field(() => Int)
  headcount!: number;

  /** Null when withheld for small-cell privacy (salarySuppressed = true). */
  @Field(() => Float, { nullable: true })
  annualSalaryTotal!: number | null;

  /** Null when withheld for small-cell privacy (salarySuppressed = true). */
  @Field(() => Float, { nullable: true })
  avgAnnualSalary!: number | null;

  /** True when the per-category salary is withheld because the cell is too
   *  small to disclose without revealing an individual's pay (HR-HIGH-001). */
  @Field()
  salarySuppressed!: boolean;
}

@ObjectType()
export class HrLabourCost {
  @Field()
  currency!: string;

  @Field(() => [HrLabourCostRow])
  rows!: HrLabourCostRow[];

  @Field(() => Int)
  totalHeadcount!: number;

  /** Employees without a laborCategory — surface a classify-me warning. */
  @Field(() => Int)
  unclassifiedCount!: number;

  @Field(() => Float)
  annualSalaryTotal!: number;

  @Field(() => Float)
  pensionFund!: number;

  @Field(() => Float)
  socialInsuranceFund!: number;

  @Field(() => Float)
  medicalInsuranceFund!: number;

  @Field(() => Float)
  otherCost!: number;

  /** Salaries + funds + other cost. */
  @Field(() => Float)
  totalPayroll!: number;

  /** Actual gross pay booked in payrolls for the requested year. */
  @Field(() => Float)
  actualGrossPayYtd!: number;

  /** Manual HR expense entries total for the requested year. */
  @Field(() => Float)
  hrExpensesYtd!: number;
}

@ObjectType()
export class HrFinanceTimeBucket {
  @Field()
  bucketStart!: Date;

  /**
   * Gross pay from payroll records (approved/processing/paid). Null when the
   * caller lacks `hr_finance:view_salary` (HR-MEDIUM-005) — aggregate payroll is
   * salary-sensitive, so the trend withholds it while expenses stay visible.
   */
  @Field(() => Float, { nullable: true })
  payrollGross!: number | null;

  /** Manual HR expense entries. */
  @Field(() => Float)
  hrExpenses!: number;
}

@ObjectType()
export class HrDepartmentCost {
  @Field(() => String, { nullable: true })
  departmentHrId?: string | null;

  @Field()
  departmentName!: string;

  @Field(() => Int)
  headcount!: number;

  /** Null when withheld for small-cell privacy (salarySuppressed = true). */
  @Field(() => Float, { nullable: true })
  annualSalaryTotal!: number | null;

  /** True when the department salary is withheld because the department has
   *  too few active employees to disclose without revealing individual pay. */
  @Field()
  salarySuppressed!: boolean;

  @Field(() => Float)
  hrExpenses!: number;
}

@ObjectType()
export class HrFinanceSummary {
  @Field()
  currency!: string;

  @Field(() => [HrFinanceTimeBucket])
  series!: HrFinanceTimeBucket[];

  @Field(() => [HrDepartmentCost])
  byDepartment!: HrDepartmentCost[];
}
