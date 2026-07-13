/**
 * Resolver-boundary mappers that populate the `*Decimal` fields (ADR-0004 /
 * DATA-MEDIUM-009 additive coexistence) from the existing numeric fields.
 *
 * The `Decimal` scalar serialises a JS number to an exact decimal string, so the
 * `*Decimal` field simply carries the SAME value as its deprecated `Float` sibling
 * — no recomputation, no precision change. Applied once at the resolver so no
 * handler/calculator needs to know about the wire representation.
 */
import { HrFinanceSummary, HrLabourCost } from '../dto/hr-finance-outputs.dto';

/** Add the `*Decimal` fields to an HrLabourCost snapshot. */
export function withLabourCostDecimals(lc: HrLabourCost): HrLabourCost {
  return {
    ...lc,
    rows: lc.rows.map((r) => ({
      ...r,
      annualSalaryTotalDecimal: r.annualSalaryTotal,
      avgAnnualSalaryDecimal: r.avgAnnualSalary,
    })),
    annualSalaryTotalDecimal: lc.annualSalaryTotal,
    pensionFundDecimal: lc.pensionFund,
    socialInsuranceFundDecimal: lc.socialInsuranceFund,
    medicalInsuranceFundDecimal: lc.medicalInsuranceFund,
    otherCostDecimal: lc.otherCost,
    totalPayrollDecimal: lc.totalPayroll,
    actualGrossPayYtdDecimal: lc.actualGrossPayYtd,
    hrExpensesYtdDecimal: lc.hrExpensesYtd,
  };
}

/** Add the `*Decimal` fields to an HrFinanceSummary (series + per-department). */
export function withSummaryDecimals(s: HrFinanceSummary): HrFinanceSummary {
  return {
    ...s,
    series: s.series.map((b) => ({
      ...b,
      payrollGrossDecimal: b.payrollGross,
      hrExpensesDecimal: b.hrExpenses,
    })),
    byDepartment: s.byDepartment.map((d) => ({
      ...d,
      annualSalaryTotalDecimal: d.annualSalaryTotal,
      hrExpensesDecimal: d.hrExpenses,
    })),
  };
}
