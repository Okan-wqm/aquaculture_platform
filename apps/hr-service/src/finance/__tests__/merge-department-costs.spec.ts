/**
 * mergeDepartmentCosts — pure per-department salary/expense merge.
 *
 * Guards the HR-HIGH-002 fix: a manual expense must be attributed to exactly
 * one department, an unassigned (null-departmentHrId) expense pool must not
 * fan out across multiple rows, an expense-only department must not be dropped,
 * and small department salaries are suppressed (HR-HIGH-001).
 */
import { mergeDepartmentCosts } from '../query-handlers/get-hr-finance-summary.handler';

describe('mergeDepartmentCosts', () => {
  it('attributes an unassigned expense pool to a SINGLE Unassigned row, not each null-FK row', () => {
    // Two enum-department groups both had a null departmentHrId in the buggy
    // version. Now the employee side is pre-grouped by departmentHrId, so there
    // is exactly one null ("Unassigned") salary row.
    const result = mergeDepartmentCosts(
      [
        { departmentHrId: 'd1', departmentName: 'Operations', headcount: 5, monthlySalaryTotal: 25000 },
        { departmentHrId: null, departmentName: 'Unassigned', headcount: 4, monthlySalaryTotal: 16000 },
      ],
      [
        // The whole unassigned-expense pool, under the single null key.
        { departmentHrId: null, departmentName: 'Unassigned', total: 9000 },
      ],
    );

    const unassigned = result.filter((r) => r.departmentHrId === null);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.hrExpenses).toBe(9000); // attributed exactly once
    // The named department gets none of the unassigned pool.
    expect(result.find((r) => r.departmentHrId === 'd1')?.hrExpenses).toBe(0);
    // Total expenses across all rows equals the input (no double-count).
    expect(result.reduce((s, r) => s + r.hrExpenses, 0)).toBe(9000);
  });

  it('surfaces an expense-only department (no active employees) as its own row', () => {
    const result = mergeDepartmentCosts(
      [{ departmentHrId: 'd1', departmentName: 'Operations', headcount: 5, monthlySalaryTotal: 25000 }],
      [
        { departmentHrId: 'd1', departmentName: 'Operations', total: 1000 },
        { departmentHrId: 'd2', departmentName: 'Closed Unit', total: 2000 },
      ],
    );

    const d2 = result.find((r) => r.departmentHrId === 'd2');
    expect(d2).toBeDefined();
    expect(d2?.headcount).toBe(0);
    expect(d2?.annualSalaryTotal).toBe(0);
    expect(d2?.hrExpenses).toBe(2000);
    // Nothing dropped: both expense rows are represented exactly once.
    expect(result.reduce((s, r) => s + r.hrExpenses, 0)).toBe(3000);
  });

  it('annualises salary (× 12) and attributes each expense once for assigned departments', () => {
    const result = mergeDepartmentCosts(
      [
        { departmentHrId: 'd1', departmentName: 'Ops', headcount: 5, monthlySalaryTotal: 20000 },
        { departmentHrId: 'd2', departmentName: 'Lab', headcount: 4, monthlySalaryTotal: 16000 },
      ],
      [
        { departmentHrId: 'd1', departmentName: 'Ops', total: 500 },
        { departmentHrId: 'd2', departmentName: 'Lab', total: 700 },
      ],
    );

    expect(result.find((r) => r.departmentHrId === 'd1')?.annualSalaryTotal).toBe(240000);
    expect(result.find((r) => r.departmentHrId === 'd1')?.hrExpenses).toBe(500);
    expect(result.find((r) => r.departmentHrId === 'd2')?.hrExpenses).toBe(700);
  });

  it('suppresses the salary of a department below the small-cell threshold', () => {
    const result = mergeDepartmentCosts(
      [
        { departmentHrId: 'd1', departmentName: 'Solo', headcount: 1, monthlySalaryTotal: 9000 },
        { departmentHrId: 'd2', departmentName: 'Ops', headcount: 6, monthlySalaryTotal: 30000 },
      ],
      [],
    );

    const solo = result.find((r) => r.departmentHrId === 'd1');
    expect(solo?.headcount).toBe(1);
    expect(solo?.salarySuppressed).toBe(true);
    expect(solo?.annualSalaryTotal).toBeNull();
    const ops = result.find((r) => r.departmentHrId === 'd2');
    expect(ops?.salarySuppressed).toBe(false);
    expect(ops?.annualSalaryTotal).toBe(360000);
  });

  it('sorts by annual salary descending, treating suppressed salary as lowest', () => {
    const result = mergeDepartmentCosts(
      [
        { departmentHrId: 'd1', departmentName: 'Solo', headcount: 1, monthlySalaryTotal: 9000 },
        { departmentHrId: 'd2', departmentName: 'Ops', headcount: 6, monthlySalaryTotal: 30000 },
      ],
      [],
    );

    expect(result[0]?.departmentHrId).toBe('d2'); // disclosed salary ranks above suppressed
  });
});
