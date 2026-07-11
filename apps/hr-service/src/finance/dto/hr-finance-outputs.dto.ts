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

@ObjectType()
export class HrLabourCostRow {
  /** Null = unclassified employees (no laborCategory assigned yet). */
  @Field(() => LaborCategory, { nullable: true })
  category?: LaborCategory | null;

  @Field(() => Int)
  headcount!: number;

  @Field(() => Float)
  annualSalaryTotal!: number;

  @Field(() => Float)
  avgAnnualSalary!: number;
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

  /** Gross pay from payroll records (approved/processing/paid). */
  @Field(() => Float)
  payrollGross!: number;

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

  @Field(() => Float)
  annualSalaryTotal!: number;

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
