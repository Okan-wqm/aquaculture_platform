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
    const { tenantId, from, to, granularity } = query;
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

      const buckets = new Map<string, HrFinanceTimeBucket>();
      const bucketFor = (raw: Date): HrFinanceTimeBucket => {
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
      const departmentRows = (await manager.query(
        `SELECT e."departmentHrId" AS "departmentHrId",
                COALESCE(d."name", initcap(replace(e."department"::text, '_', ' '))) AS "departmentName",
                COUNT(*) AS "headcount",
                SUM(e."baseSalary") AS "monthlySalaryTotal"
         FROM employees e
         LEFT JOIN departments_hr d ON d."id" = e."departmentHrId"
         WHERE e."tenantId" = $1 AND e.status = 'active' AND e."isDeleted" = false
         GROUP BY e."departmentHrId", "departmentName"`,
        [tenantId],
      )) as Array<{
        departmentHrId: string | null;
        departmentName: string;
        headcount: string;
        monthlySalaryTotal: string | null;
      }>;

      const departmentExpenseRows = (await manager.query(
        `SELECT "departmentHrId", SUM("amount") AS "total"
         FROM hr_finance_entries
         WHERE "tenantId" = $1 AND "isDeleted" = false
           AND "entryDate" >= $2 AND "entryDate" <= $3
         GROUP BY "departmentHrId"`,
        [tenantId, from, to],
      )) as Array<{ departmentHrId: string | null; total: string }>;

      const expensesByDepartment = new Map(
        departmentExpenseRows.map((row) => [row.departmentHrId ?? 'none', Number(row.total)]),
      );

      const byDepartment: HrDepartmentCost[] = departmentRows
        .map((row) => ({
          departmentHrId: row.departmentHrId,
          departmentName: row.departmentName ?? 'Unassigned',
          headcount: Number(row.headcount),
          annualSalaryTotal:
            Math.round(Number(row.monthlySalaryTotal ?? 0) * MONTHS_PER_YEAR * 100) / 100,
          hrExpenses: expensesByDepartment.get(row.departmentHrId ?? 'none') ?? 0,
        }))
        .sort((a, b) => b.annualSalaryTotal - a.annualSalaryTotal);

      return {
        currency: settings.defaultCurrency,
        series: [...buckets.values()].sort(
          (a, b) => a.bucketStart.getTime() - b.bucketStart.getTime(),
        ),
        byDepartment,
      };
    });
  }
}
