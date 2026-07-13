/**
 * LabourCostCalculator — pure computation of the Labour Cost read model.
 *
 * Inputs: per-category headcounts + annual salary totals (aggregated in
 * SQL from active employees; baseSalary is the MONTHLY base — the same
 * convention create-payroll.handler.ts uses when deriving the hourly
 * rate as baseSalary/160 — so annual = monthly × 12), plus the tenant's
 * payroll-cost percentages.
 *
 * Output: the user-facing Labour Cost table —
 *   annual salaries per workforce category,
 *   pension fund            = pensionFundPct%      × salary total,
 *   social insurance fund   = socialInsurancePct%  × salary total,
 *   compulsory medical fund = medicalInsurancePct% × salary total,
 *   other cost              = otherCostPct%        × salary total,
 *   total payroll           = salary total + funds + other cost.
 *
 * All arithmetic goes through the Money value object (Decimal.js,
 * banker's rounding) — never raw IEEE 754 floats (HR-HIGH-005).
 * Pure function of its inputs; the table-driven spec covers it.
 */
import { Injectable } from '@nestjs/common';
import { Money } from '@aquaculture/backend-common/monetary';

import { LaborCategory } from '../../hr/entities/employee.entity';

export interface CategorySalaryAggregate {
  /** null = unclassified employees (no laborCategory assigned yet). */
  category: LaborCategory | null;
  headcount: number;
  /** Σ monthly baseSalary of active employees in the category. */
  monthlySalaryTotal: number;
}

export interface PayrollCostRates {
  pensionFundPct: number;
  socialInsurancePct: number;
  medicalInsurancePct: number;
  otherCostPct: number;
}

export interface LabourCostRow {
  category: LaborCategory | null;
  headcount: number;
  /** null when suppressed for small-cell privacy (see salarySuppressed). */
  annualSalaryTotal: number | null;
  /** null when suppressed for small-cell privacy (see salarySuppressed). */
  avgAnnualSalary: number | null;
  /**
   * True when this row's per-category salary is withheld because the cell is
   * too small to disclose without effectively revealing an individual's salary
   * (HR-HIGH-001). Headcount is always returned; only the money is suppressed.
   */
  salarySuppressed: boolean;
}

export interface LabourCostResult {
  currency: string;
  rows: LabourCostRow[];
  totalHeadcount: number;
  unclassifiedCount: number;
  annualSalaryTotal: number;
  pensionFund: number;
  socialInsuranceFund: number;
  medicalInsuranceFund: number;
  otherCost: number;
  totalPayroll: number;
}

const MONTHS_PER_YEAR = 12;

/**
 * k-anonymity threshold for per-category salary disclosure (HR-HIGH-001).
 * A category whose active headcount is below this reveals an individual's
 * (k=1) or a pair's (k=2) salary once combined with the headcount, so its
 * per-category salary is withheld. baseSalary is `@HideField()` on Employee
 * precisely so individual pay is never queryable — the aggregate must not
 * re-derive it through a small cell.
 */
export const SMALL_CELL_MIN_HEADCOUNT = 3;

/** GraphQL Float projection of a Money value, rounded to 2 decimals. */
const toNumber = (money: Money): number =>
  money.toDecimal().toDecimalPlaces(2).toNumber();

@Injectable()
export class LabourCostCalculator {
  compute(
    aggregates: readonly CategorySalaryAggregate[],
    rates: PayrollCostRates,
    currency: string,
  ): LabourCostResult {
    const rows: LabourCostRow[] = aggregates.map((aggregate) => {
      const annualTotal = Money.of(aggregate.monthlySalaryTotal, currency).multiply(MONTHS_PER_YEAR);
      const avg =
        aggregate.headcount > 0
          ? annualTotal.multiply(1 / aggregate.headcount)
          : Money.zero(currency);
      return {
        category: aggregate.category,
        headcount: aggregate.headcount,
        annualSalaryTotal: toNumber(annualTotal),
        avgAnnualSalary: toNumber(avg),
        salarySuppressed: false,
      };
    });

    // Small-cell suppression (HR-HIGH-001). Withhold per-category salary for any
    // cell with 0 < headcount < k. Complementary suppression: if EXACTLY one cell
    // is suppressed while the grand total (annualSalaryTotal below) is still
    // published, that one cell = total − Σ(visible), i.e. trivially derivable —
    // so also suppress the smallest remaining disclosed cell, leaving ≥2 unknowns.
    this.applySmallCellSuppression(rows);

    const annualSalaryTotal = aggregates.reduce(
      (sum, aggregate) =>
        sum.add(Money.of(aggregate.monthlySalaryTotal, currency).multiply(MONTHS_PER_YEAR)),
      Money.zero(currency),
    );

    const fund = (percent: number): Money => annualSalaryTotal.multiply(percent / 100);

    const pensionFund = fund(rates.pensionFundPct);
    const socialInsuranceFund = fund(rates.socialInsurancePct);
    const medicalInsuranceFund = fund(rates.medicalInsurancePct);
    const otherCost = fund(rates.otherCostPct);

    const totalPayroll = annualSalaryTotal
      .add(pensionFund)
      .add(socialInsuranceFund)
      .add(medicalInsuranceFund)
      .add(otherCost);

    return {
      currency,
      rows,
      totalHeadcount: aggregates.reduce((sum, a) => sum + a.headcount, 0),
      unclassifiedCount: aggregates.find((a) => a.category === null)?.headcount ?? 0,
      annualSalaryTotal: toNumber(annualSalaryTotal),
      pensionFund: toNumber(pensionFund),
      socialInsuranceFund: toNumber(socialInsuranceFund),
      medicalInsuranceFund: toNumber(medicalInsuranceFund),
      otherCost: toNumber(otherCost),
      totalPayroll: toNumber(totalPayroll),
    };
  }

  /**
   * Mutates `rows`, blanking the per-category salary of any cell too small to
   * disclose safely (HR-HIGH-001). Zero-headcount rows are never suppressed
   * (no individual to protect). Applies complementary suppression so a lone
   * small cell cannot be recovered from the published grand total.
   */
  private applySmallCellSuppression(rows: LabourCostRow[]): void {
    const suppress = (row: LabourCostRow): void => {
      row.annualSalaryTotal = null;
      row.avgAnnualSalary = null;
      row.salarySuppressed = true;
    };

    for (const row of rows) {
      if (row.headcount > 0 && row.headcount < SMALL_CELL_MIN_HEADCOUNT) {
        suppress(row);
      }
    }

    const disclosed = rows.filter((r) => !r.salarySuppressed && r.headcount > 0);
    const suppressedCount = rows.filter((r) => r.salarySuppressed).length;
    if (suppressedCount === 1 && disclosed.length > 0) {
      const smallest = disclosed.reduce((a, b) => (b.headcount < a.headcount ? b : a));
      suppress(smallest);
    }
  }
}
