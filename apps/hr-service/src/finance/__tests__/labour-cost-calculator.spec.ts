/**
 * LabourCostCalculator — table-driven spec.
 *
 * Verifies the Labour Cost contract: annual = monthly × 12; fund lines
 * are percentages of the annual salary total; total payroll = salaries
 * + all funds + other cost; Money-based arithmetic rounds to 2 dp; and
 * small-cell salary suppression (HR-HIGH-001) withholds per-category
 * salary that would reveal an individual's pay.
 */
import { LabourCostCalculator } from '../services/labour-cost-calculator.service';
import { LaborCategory } from '../../hr/entities/employee.entity';

describe('LabourCostCalculator', () => {
  const calculator = new LabourCostCalculator();

  it('annualises monthly salaries (× 12) per category', () => {
    const result = calculator.compute(
      [
        { category: LaborCategory.MANAGER, headcount: 3, monthlySalaryTotal: 30000 },
        { category: LaborCategory.TECHNICAL, headcount: 3, monthlySalaryTotal: 15000 },
        { category: LaborCategory.UNSKILLED, headcount: 5, monthlySalaryTotal: 10000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    const manager = result.rows.find((r) => r.category === LaborCategory.MANAGER);
    expect(manager?.salarySuppressed).toBe(false);
    expect(manager?.annualSalaryTotal).toBe(360000); // 30000 × 12
    expect(manager?.avgAnnualSalary).toBe(120000); // 360000 / 3 headcount
    expect(result.annualSalaryTotal).toBe(660000); // (30000+15000+10000) × 12
    expect(result.totalHeadcount).toBe(11);
  });

  it('computes each fund as a percentage of the annual salary total', () => {
    const result = calculator.compute(
      [{ category: LaborCategory.MANAGER, headcount: 5, monthlySalaryTotal: 10000 }],
      {
        pensionFundPct: 11,
        socialInsurancePct: 9.5,
        medicalInsurancePct: 7.5,
        otherCostPct: 5,
      },
      'NOK',
    );

    // Annual = 10000 × 12 = 120000
    expect(result.annualSalaryTotal).toBe(120000);
    expect(result.pensionFund).toBe(13200); // 11%
    expect(result.socialInsuranceFund).toBe(11400); // 9.5%
    expect(result.medicalInsuranceFund).toBe(9000); // 7.5%
    expect(result.otherCost).toBe(6000); // 5%
    // Total = 120000 + 13200 + 11400 + 9000 + 6000
    expect(result.totalPayroll).toBe(159600);
  });

  it('defaults all funds to zero when rates are zero (product default)', () => {
    const result = calculator.compute(
      [{ category: LaborCategory.TECHNICAL, headcount: 4, monthlySalaryTotal: 5000 }],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 5 },
      'EUR',
    );

    expect(result.pensionFund).toBe(0);
    expect(result.socialInsuranceFund).toBe(0);
    expect(result.medicalInsuranceFund).toBe(0);
    expect(result.otherCost).toBe(3000); // 5% of 60000
    expect(result.totalPayroll).toBe(63000);
    expect(result.currency).toBe('EUR');
  });

  it('surfaces unclassified employees as a distinct bucket', () => {
    const result = calculator.compute(
      [
        { category: LaborCategory.MANAGER, headcount: 3, monthlySalaryTotal: 24000 },
        { category: null, headcount: 4, monthlySalaryTotal: 12000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    expect(result.unclassifiedCount).toBe(4);
    const unclassified = result.rows.find((r) => r.category === null);
    expect(unclassified?.salarySuppressed).toBe(false);
    expect(unclassified?.annualSalaryTotal).toBe(144000); // 12000 × 12
  });

  it('rounds fund arithmetic to 2 decimals (Money, banker’s rounding)', () => {
    const result = calculator.compute(
      [{ category: LaborCategory.UNSKILLED, headcount: 4, monthlySalaryTotal: 1234.56 }],
      { pensionFundPct: 3.33, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    // Annual = 1234.56 × 12 = 14814.72; pension = 3.33% = 493.330…
    expect(result.annualSalaryTotal).toBe(14814.72);
    expect(result.pensionFund).toBe(493.33);
  });

  // ==========================================================================
  // Small-cell salary suppression (HR-HIGH-001)
  // ==========================================================================

  it('suppresses a category salary below the k-anonymity threshold, keeping headcount', () => {
    const result = calculator.compute(
      [
        { category: LaborCategory.MANAGER, headcount: 1, monthlySalaryTotal: 9000 },
        { category: LaborCategory.TECHNICAL, headcount: 6, monthlySalaryTotal: 30000 },
        { category: LaborCategory.UNSKILLED, headcount: 8, monthlySalaryTotal: 40000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    const manager = result.rows.find((r) => r.category === LaborCategory.MANAGER);
    // headcount 1 → salary withheld, headcount still returned.
    expect(manager?.headcount).toBe(1);
    expect(manager?.salarySuppressed).toBe(true);
    expect(manager?.annualSalaryTotal).toBeNull();
    expect(manager?.avgAnnualSalary).toBeNull();
    // Grand totals are computed from all aggregates, so they stay exact.
    expect(result.annualSalaryTotal).toBe((9000 + 30000 + 40000) * 12);
  });

  it('applies complementary suppression so a lone small cell is not derivable from the total', () => {
    // Only MANAGER is below k. Without complementary suppression its salary would
    // equal total − technical, i.e. trivially recoverable. So the smallest
    // remaining disclosed cell (technical) is suppressed too.
    const result = calculator.compute(
      [
        { category: LaborCategory.MANAGER, headcount: 2, monthlySalaryTotal: 18000 },
        { category: LaborCategory.TECHNICAL, headcount: 10, monthlySalaryTotal: 50000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    const suppressed = result.rows.filter((r) => r.salarySuppressed);
    expect(suppressed).toHaveLength(2);
    expect(result.rows.every((r) => r.annualSalaryTotal === null)).toBe(true);
    // Total still exact and disclosed.
    expect(result.annualSalaryTotal).toBe((18000 + 50000) * 12);
  });

  it('does not suppress any cell when every category meets the threshold', () => {
    const result = calculator.compute(
      [
        { category: LaborCategory.MANAGER, headcount: 3, monthlySalaryTotal: 30000 },
        { category: LaborCategory.TECHNICAL, headcount: 4, monthlySalaryTotal: 20000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    expect(result.rows.every((r) => r.salarySuppressed === false)).toBe(true);
    expect(result.rows.every((r) => r.annualSalaryTotal !== null)).toBe(true);
  });

  it('never suppresses a zero-headcount row (no individual to protect)', () => {
    const result = calculator.compute(
      [
        { category: LaborCategory.MANAGER, headcount: 0, monthlySalaryTotal: 0 },
        { category: LaborCategory.TECHNICAL, headcount: 5, monthlySalaryTotal: 25000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    const manager = result.rows.find((r) => r.category === LaborCategory.MANAGER);
    const technical = result.rows.find((r) => r.category === LaborCategory.TECHNICAL);
    expect(manager?.salarySuppressed).toBe(false);
    expect(manager?.annualSalaryTotal).toBe(0);
    // A zero-headcount row is not a "suppressed cell", so no complementary pass fires.
    expect(technical?.salarySuppressed).toBe(false);
    expect(technical?.annualSalaryTotal).toBe(300000);
  });
});
