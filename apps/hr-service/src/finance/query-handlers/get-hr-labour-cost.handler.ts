/**
 * GetHrLabourCostHandler — the single consistent snapshot behind the
 * Personnel Table, Personnel Salary and Labour Cost surfaces.
 *
 * Planned figures: active employees grouped by laborCategory
 * (headcount + Σ monthly baseSalary → annualised by the pure
 * LabourCostCalculator using the tenant's fund percentages).
 * Actual figures: Σ payrolls.earningsGrossPay (approved/processing/
 * paid) + Σ manual hr_finance_entries for the requested year.
 *
 * All three workforce categories are always present in `rows` (zero
 * headcount included) so the Personnel Table renders a complete,
 * stable shape; an UNCLASSIFIED row appears only when unclassified
 * employees exist.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import { LaborCategory } from '../../hr/entities/employee.entity';
import { HrLabourCost } from '../dto/hr-finance-outputs.dto';
import { GetHrLabourCostQuery } from '../queries/hr-finance.queries';
import {
  CategorySalaryAggregate,
  LabourCostCalculator,
} from '../services/labour-cost-calculator.service';
import { PayrollCostSettingsService } from '../services/payroll-cost-settings.service';

interface CategoryRow {
  laborCategory: LaborCategory | null;
  headcount: string;
  monthlySalaryTotal: string | null;
}

@Injectable()
@QueryHandler(GetHrLabourCostQuery)
export class GetHrLabourCostHandler
  implements IQueryHandler<GetHrLabourCostQuery, HrLabourCost>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly calculator: LabourCostCalculator,
    private readonly settingsService: PayrollCostSettingsService,
  ) {}

  async execute(query: GetHrLabourCostQuery): Promise<HrLabourCost> {
    const { tenantId, year } = query;
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    return runInTenantRead(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const settings = await this.settingsService.getSettingsInTx(manager, tenantId);

      const categoryRows = (await manager.query(
        `SELECT "laborCategory",
                COUNT(*) AS "headcount",
                SUM("baseSalary") AS "monthlySalaryTotal"
         FROM employees
         WHERE "tenantId" = $1 AND status = 'active' AND "isDeleted" = false
         GROUP BY "laborCategory"`,
        [tenantId],
      )) as CategoryRow[];

      // Stable row shape: every category present, unclassified only if real.
      const byCategory = new Map<LaborCategory | null, CategorySalaryAggregate>(
        categoryRows.map((row) => [
          row.laborCategory,
          {
            category: row.laborCategory,
            headcount: Number(row.headcount),
            monthlySalaryTotal: Number(row.monthlySalaryTotal ?? 0),
          },
        ]),
      );
      const aggregates: CategorySalaryAggregate[] = [
        LaborCategory.MANAGER,
        LaborCategory.TECHNICAL,
        LaborCategory.UNSKILLED,
      ].map(
        (category) =>
          byCategory.get(category) ?? { category, headcount: 0, monthlySalaryTotal: 0 },
      );
      const unclassified = byCategory.get(null);
      if (unclassified) {
        aggregates.push(unclassified);
      }

      const result = this.calculator.compute(
        aggregates,
        {
          pensionFundPct: Number(settings.pensionFundPct),
          socialInsurancePct: Number(settings.socialInsurancePct),
          medicalInsurancePct: Number(settings.medicalInsurancePct),
          otherCostPct: Number(settings.otherCostPct),
        },
        settings.defaultCurrency,
      );

      const [grossRow] = (await manager.query(
        `SELECT COALESCE(SUM("earningsGrossPay"), 0) AS "gross"
         FROM payrolls
         WHERE "tenantId" = $1
           AND status IN ('approved', 'processing', 'paid')
           AND "payPeriodStart" >= $2 AND "payPeriodStart" <= $3`,
        [tenantId, yearStart, yearEnd],
      )) as Array<{ gross: string }>;

      const [expenseRow] = (await manager.query(
        `SELECT COALESCE(SUM("amount"), 0) AS "total"
         FROM hr_finance_entries
         WHERE "tenantId" = $1 AND "isDeleted" = false
           AND "entryDate" >= $2 AND "entryDate" <= $3`,
        [tenantId, yearStart, yearEnd],
      )) as Array<{ total: string }>;

      return {
        ...result,
        actualGrossPayYtd: Number(grossRow?.gross ?? 0),
        hrExpensesYtd: Number(expenseRow?.total ?? 0),
      };
    });
  }
}
