/**
 * GetHrFinanceSummaryHandler — HR cost time series + per-department
 * breakdown for the HR finance charts.
 *
 * Series buckets combine actual payroll gross (approved/processing/
 * paid) with manual HR expense entries; departments aggregate active
 * employees' annualised salaries + their department-linked expenses.
 * Granularity is an enum → date_trunc literal whitelist — user input is
 * never interpolated into SQL.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { registerEnumType } from '@nestjs/graphql';
import { DataSource } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import {
  HrDepartmentCost,
  HrFinanceSummary,
  HrFinanceTimeBucket,
} from '../dto/hr-finance-outputs.dto';
import { GetHrFinanceSummaryQuery } from '../queries/hr-finance.queries';
import { PayrollCostSettingsService } from '../services/payroll-cost-settings.service';
import { SMALL_CELL_MIN_HEADCOUNT } from '../services/labour-cost-calculator.service';

export enum HrFinanceGranularity {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
  YEAR = 'YEAR',
}

registerEnumType(HrFinanceGranularity, {
  name: 'HrFinanceGranularity',
  description: 'Time bucket size for HR finance aggregation',
});

const GRANULARITY_SQL: Record<HrFinanceGranularity, string> = {
  [HrFinanceGranularity.DAY]: 'day',
  [HrFinanceGranularity.WEEK]: 'week',
  [HrFinanceGranularity.MONTH]: 'month',
  [HrFinanceGranularity.YEAR]: 'year',
};

const MONTHS_PER_YEAR = 12;

/** Active-employee salary aggregate for one department (departmentHrId key). */
export interface DepartmentSalaryRow {
  departmentHrId: string | null;
  departmentName: string;
  headcount: number;
  /** Σ monthly baseSalary of the department's active employees. */
  monthlySalaryTotal: number;
}

/** Manual HR-expense aggregate for one department (departmentHrId key). */
export interface DepartmentExpenseRow {
  departmentHrId: string | null;
  departmentName: string;
  total: number;
}

/**
 * Merge per-department salaries and expenses on a SINGLE key
 * (`departmentHrId`, null → `'none'`) so every expense is attributed to
 * exactly one department (HR-HIGH-002). The employee side is already grouped
 * by `departmentHrId` (one row per key, including a single null "Unassigned"
 * row), so a null-FK expense pool can no longer fan out across several
 * enum-department rows; and an expense-only department (a `departmentHrId`
 * with no active employees) surfaces as its own row instead of being dropped.
 * Applies per-cell small-cell salary suppression (HR-HIGH-001).
 */
export function mergeDepartmentCosts(
  salaryRows: readonly DepartmentSalaryRow[],
  expenseRows: readonly DepartmentExpenseRow[],
  includeSalary = true,
): HrDepartmentCost[] {
  const keyOf = (id: string | null): string => id ?? 'none';
  const merged = new Map<string, HrDepartmentCost>();

  for (const row of salaryRows) {
    const annualSalaryTotal = Math.round(row.monthlySalaryTotal * MONTHS_PER_YEAR * 100) / 100;
    // Withhold salary entirely if the caller lacks the salary permission
    // (HR-MEDIUM-005), else per-cell small-cell suppression (HR-HIGH-001).
    // HrFinanceSummary publishes no grand salary total, so per-cell suppression
    // (no complementary pass) is sufficient to protect a small department.
    const salarySuppressed =
      !includeSalary || (row.headcount > 0 && row.headcount < SMALL_CELL_MIN_HEADCOUNT);
    merged.set(keyOf(row.departmentHrId), {
      departmentHrId: row.departmentHrId,
      departmentName: row.departmentName,
      headcount: row.headcount,
      annualSalaryTotal: salarySuppressed ? null : annualSalaryTotal,
      salarySuppressed,
      hrExpenses: 0,
    });
  }

  for (const row of expenseRows) {
    const key = keyOf(row.departmentHrId);
    const existing = merged.get(key);
    if (existing) {
      existing.hrExpenses = row.total;
    } else {
      merged.set(key, {
        departmentHrId: row.departmentHrId,
        departmentName: row.departmentName,
        headcount: 0,
        annualSalaryTotal: 0,
        salarySuppressed: false,
        hrExpenses: row.total,
      });
    }
  }

  return [...merged.values()].sort(
    (a, b) => (b.annualSalaryTotal ?? 0) - (a.annualSalaryTotal ?? 0),
  );
}

@Injectable()
@QueryHandler(GetHrFinanceSummaryQuery)
export class GetHrFinanceSummaryHandler
  implements IQueryHandler<GetHrFinanceSummaryQuery, HrFinanceSummary>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly settingsService: PayrollCostSettingsService,
  ) {}

  async execute(query: GetHrFinanceSummaryQuery): Promise<HrFinanceSummary> {
    const { tenantId, from, to, granularity, includeSalary } = query;
    const truncUnit = GRANULARITY_SQL[granularity];

    return runInTenantRead(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const settings = await this.settingsService.getSettingsInTx(manager, tenantId);

      // Time series — payroll gross per bucket.
      const payrollRows = (await manager.query(
        `SELECT date_trunc('${truncUnit}', "payPeriodStart") AS "bucket",
                SUM("earningsGrossPay") AS "gross"
         FROM payrolls
         WHERE "tenantId" = $1
           AND status IN ('approved', 'processing', 'paid')
           AND "payPeriodStart" >= $2 AND "payPeriodStart" <= $3
         GROUP BY 1`,
        [tenantId, from, to],
      )) as Array<{ bucket: Date; gross: string }>;

      // Time series — manual HR expenses per bucket.
      const expenseRows = (await manager.query(
        `SELECT date_trunc('${truncUnit}', "entryDate") AS "bucket",
                SUM("amount") AS "total"
         FROM hr_finance_entries
         WHERE "tenantId" = $1 AND "isDeleted" = false
           AND "entryDate" >= $2 AND "entryDate" <= $3
         GROUP BY 1`,
        [tenantId, from, to],
      )) as Array<{ bucket: Date; total: string }>;

      // Internal accumulator keeps payrollGross a plain number; the output series
      // below nulls it when the caller lacks the salary permission.
      const buckets = new Map<
        string,
        { bucketStart: Date; payrollGross: number; hrExpenses: number }
      >();
      const bucketFor = (
        raw: Date,
      ): { bucketStart: Date; payrollGross: number; hrExpenses: number } => {
        const iso = new Date(raw).toISOString();
        let bucket = buckets.get(iso);
        if (!bucket) {
          bucket = { bucketStart: new Date(iso), payrollGross: 0, hrExpenses: 0 };
          buckets.set(iso, bucket);
        }
        return bucket;
      };
      for (const row of payrollRows) {
        bucketFor(row.bucket).payrollGross += Number(row.gross);
      }
      for (const row of expenseRows) {
        bucketFor(row.bucket).hrExpenses += Number(row.total);
      }

      // Per-department: active headcount + annualised salary + expenses.
      // Group by the real FK `departmentHrId` ONLY (not the legacy free-text
      // `department` enum): employees with a NULL FK but different enum values
      // used to fan out into several rows that ALL shared the single `'none'`
      // expense bucket, attributing the whole unassigned-expense pool to each
      // one (HR-HIGH-002). One key per distinct departmentHrId → a single
      // "Unassigned" row that carries the null-FK salaries and expenses once.
      const departmentRows = (await manager.query(
        `SELECT e."departmentHrId" AS "departmentHrId",
                COALESCE(d."name", 'Unassigned') AS "departmentName",
                COUNT(*) AS "headcount",
                SUM(e."baseSalary") AS "monthlySalaryTotal"
         FROM employees e
         LEFT JOIN departments_hr d ON d."id" = e."departmentHrId"
         WHERE e."tenantId" = $1 AND e.status = 'active' AND e."isDeleted" = false
         GROUP BY e."departmentHrId", d."name"`,
        [tenantId],
      )) as Array<{
        departmentHrId: string | null;
        departmentName: string;
        headcount: string;
        monthlySalaryTotal: string | null;
      }>;

      // Expenses joined to their department name so an expense-only department
      // (a departmentHrId with no active employees) still surfaces exactly once
      // instead of being silently dropped by the employee-driven breakdown.
      const departmentExpenseRows = (await manager.query(
        `SELECT fe."departmentHrId" AS "departmentHrId",
                COALESCE(d."name", 'Unassigned') AS "departmentName",
                SUM(fe."amount") AS "total"
         FROM hr_finance_entries fe
         LEFT JOIN departments_hr d ON d."id" = fe."departmentHrId"
         WHERE fe."tenantId" = $1 AND fe."isDeleted" = false
           AND fe."entryDate" >= $2 AND fe."entryDate" <= $3
         GROUP BY fe."departmentHrId", d."name"`,
        [tenantId, from, to],
      )) as Array<{ departmentHrId: string | null; departmentName: string; total: string }>;

      // Merge salary + expenses on a single key so every expense is attributed
      // to exactly one department (HR-HIGH-002) and small cells are suppressed.
      const byDepartment = mergeDepartmentCosts(
        departmentRows.map((row) => ({
          departmentHrId: row.departmentHrId,
          departmentName: row.departmentName,
          headcount: Number(row.headcount),
          monthlySalaryTotal: Number(row.monthlySalaryTotal ?? 0),
        })),
        departmentExpenseRows.map((row) => ({
          departmentHrId: row.departmentHrId,
          departmentName: row.departmentName,
          total: Number(row.total),
        })),
        includeSalary,
      );

      const series = [...buckets.values()]
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
        // Aggregate payroll is salary-sensitive: withhold it (null) unless the
        // caller holds `hr_finance:view_salary` (HR-MEDIUM-005). Expenses stay.
        .map((bucket) => ({ ...bucket, payrollGross: includeSalary ? bucket.payrollGross : null }));

      return {
        currency: settings.defaultCurrency,
        series,
        byDepartment,
      };
    });
  }
}
