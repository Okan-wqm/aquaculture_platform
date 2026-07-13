/**
 * HR finance read-model GraphQL types.
 *
 * HrLabourCost is the single consistent snapshot behind the three
 * user-facing tables — Personnel Table (headcounts), Personnel Salary
 * (per-person annual salary per category) and Labour Cost (salary
 * totals + fund projections + total payroll).
 */
import { Field, Float, Int, ObjectType } from '@nestjs/graphql';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';

import { LaborCategory } from '../../hr/entities/employee.entity';

// ADR-0004 / DATA-MEDIUM-009 additive coexistence: each money `Float` field gains
// a parallel `*Decimal` field (exact decimal string via the Decimal scalar). The
// Float fields are deprecated and stay through the window; a resolver-boundary
// mapper (hr-finance-decimal.mapper.ts) populates the `*Decimal` fields from the
// existing numeric ones, so no handler/calculator change is needed.

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
  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use annualSalaryTotalDecimal (exact decimal string, ADR-0004).',
  })
  annualSalaryTotal!: number | null;

  /** Exact-decimal annual salary total (string). Coexists with the deprecated Float. */
  @Field(() => DecimalScalar, { nullable: true })
  annualSalaryTotalDecimal?: number | null;

  /** Null when withheld for small-cell privacy (salarySuppressed = true). */
  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use avgAnnualSalaryDecimal (exact decimal string, ADR-0004).',
  })
  avgAnnualSalary!: number | null;

  /** Exact-decimal average annual salary (string). Coexists with the deprecated Float. */
  @Field(() => DecimalScalar, { nullable: true })
  avgAnnualSalaryDecimal?: number | null;

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

  @Field(() => Float, { deprecationReason: 'Use annualSalaryTotalDecimal (ADR-0004).' })
  annualSalaryTotal!: number;

  @Field(() => DecimalScalar)
  annualSalaryTotalDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use pensionFundDecimal (ADR-0004).' })
  pensionFund!: number;

  @Field(() => DecimalScalar)
  pensionFundDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use socialInsuranceFundDecimal (ADR-0004).' })
  socialInsuranceFund!: number;

  @Field(() => DecimalScalar)
  socialInsuranceFundDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use medicalInsuranceFundDecimal (ADR-0004).' })
  medicalInsuranceFund!: number;

  @Field(() => DecimalScalar)
  medicalInsuranceFundDecimal?: number;

  @Field(() => Float, { deprecationReason: 'Use otherCostDecimal (ADR-0004).' })
  otherCost!: number;

  @Field(() => DecimalScalar)
  otherCostDecimal?: number;

  /** Salaries + funds + other cost. */
  @Field(() => Float, { deprecationReason: 'Use totalPayrollDecimal (ADR-0004).' })
  totalPayroll!: number;

  @Field(() => DecimalScalar)
  totalPayrollDecimal?: number;

  /** Actual gross pay booked in payrolls for the requested year. */
  @Field(() => Float, { deprecationReason: 'Use actualGrossPayYtdDecimal (ADR-0004).' })
  actualGrossPayYtd!: number;

  @Field(() => DecimalScalar)
  actualGrossPayYtdDecimal?: number;

  /** Manual HR expense entries total for the requested year. */
  @Field(() => Float, { deprecationReason: 'Use hrExpensesYtdDecimal (ADR-0004).' })
  hrExpensesYtd!: number;

  @Field(() => DecimalScalar)
  hrExpensesYtdDecimal?: number;
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
  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use payrollGrossDecimal (exact decimal string, ADR-0004).',
  })
  payrollGross!: number | null;

  @Field(() => DecimalScalar, { nullable: true })
  payrollGrossDecimal?: number | null;

  /** Manual HR expense entries. */
  @Field(() => Float, { deprecationReason: 'Use hrExpensesDecimal (ADR-0004).' })
  hrExpenses!: number;

  @Field(() => DecimalScalar)
  hrExpensesDecimal?: number;
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
  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use annualSalaryTotalDecimal (exact decimal string, ADR-0004).',
  })
  annualSalaryTotal!: number | null;

  @Field(() => DecimalScalar, { nullable: true })
  annualSalaryTotalDecimal?: number | null;

  /** True when the department salary is withheld because the department has
   *  too few active employees to disclose without revealing individual pay. */
  @Field()
  salarySuppressed!: boolean;

  @Field(() => Float, { deprecationReason: 'Use hrExpensesDecimal (ADR-0004).' })
  hrExpenses!: number;

  @Field(() => DecimalScalar)
  hrExpensesDecimal?: number;
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
