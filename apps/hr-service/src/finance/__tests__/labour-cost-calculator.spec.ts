/**
 * LabourCostCalculator — table-driven spec.
 *
 * Verifies the Labour Cost contract: annual = monthly × 12; fund lines
 * are percentages of the annual salary total; total payroll = salaries
 * + all funds + other cost; Money-based arithmetic rounds to 2 dp.
 */
import { LabourCostCalculator } from '../services/labour-cost-calculator.service';
import { LaborCategory } from '../../hr/entities/employee.entity';

describe('LabourCostCalculator', () => {
  const calculator = new LabourCostCalculator();

  it('annualises monthly salaries (× 12) per category', () => {
    const result = calculator.compute(
      [
        { category: LaborCategory.MANAGER, headcount: 2, monthlySalaryTotal: 20000 },
        { category: LaborCategory.TECHNICAL, headcount: 3, monthlySalaryTotal: 15000 },
        { category: LaborCategory.UNSKILLED, headcount: 5, monthlySalaryTotal: 10000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    const manager = result.rows.find((r) => r.category === LaborCategory.MANAGER);
    expect(manager?.annualSalaryTotal).toBe(240000); // 20000 × 12
    expect(manager?.avgAnnualSalary).toBe(120000); // 240000 / 2 headcount
    expect(result.annualSalaryTotal).toBe(540000); // (20000+15000+10000) × 12
    expect(result.totalHeadcount).toBe(10);
  });

  it('computes each fund as a percentage of the annual salary total', () => {
    const result = calculator.compute(
      [{ category: LaborCategory.MANAGER, headcount: 1, monthlySalaryTotal: 10000 }],
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
      [{ category: LaborCategory.TECHNICAL, headcount: 1, monthlySalaryTotal: 5000 }],
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
        { category: LaborCategory.MANAGER, headcount: 1, monthlySalaryTotal: 8000 },
        { category: null, headcount: 4, monthlySalaryTotal: 12000 },
      ],
      { pensionFundPct: 0, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    expect(result.unclassifiedCount).toBe(4);
    const unclassified = result.rows.find((r) => r.category === null);
    expect(unclassified?.annualSalaryTotal).toBe(144000); // 12000 × 12
  });

  it('rounds fund arithmetic to 2 decimals (Money, banker’s rounding)', () => {
    const result = calculator.compute(
      [{ category: LaborCategory.UNSKILLED, headcount: 1, monthlySalaryTotal: 1234.56 }],
      { pensionFundPct: 3.33, socialInsurancePct: 0, medicalInsurancePct: 0, otherCostPct: 0 },
      'NOK',
    );

    // Annual = 1234.56 × 12 = 14814.72; pension = 3.33% = 493.330…
    expect(result.annualSalaryTotal).toBe(14814.72);
    expect(result.pensionFund).toBe(493.33);
  });
});
