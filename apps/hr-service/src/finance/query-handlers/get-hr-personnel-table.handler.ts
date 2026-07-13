/**
 * GetHrPersonnelTableHandler — headcount-only workforce projection.
 *
 * The salary-free counterpart to GetHrLabourCostHandler (HR-MEDIUM-005): a
 * MODULE_MANAGER always sees headcounts (Personnel Table), while the
 * salary-bearing `hrLabourCost` is gated by the tenant-assignable
 * `hr_finance:view_salary` permission. This handler never reads `baseSalary`,
 * so there is no salary to leak — the boundary is structural, not a field the
 * query merely omits.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import { LaborCategory } from '../../hr/entities/employee.entity';
import { HrPersonnelRow, HrPersonnelTable } from '../dto/hr-finance-outputs.dto';
import { GetHrPersonnelTableQuery } from '../queries/hr-finance.queries';

interface HeadcountRow {
  laborCategory: LaborCategory | null;
  headcount: string;
}

@Injectable()
@QueryHandler(GetHrPersonnelTableQuery)
export class GetHrPersonnelTableHandler
  implements IQueryHandler<GetHrPersonnelTableQuery, HrPersonnelTable>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHrPersonnelTableQuery): Promise<HrPersonnelTable> {
    const { tenantId } = query;

    return runInTenantRead(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const countRows = (await queryRunner.manager.query(
        `SELECT "laborCategory", COUNT(*) AS "headcount"
         FROM employees
         WHERE "tenantId" = $1 AND status = 'active' AND "isDeleted" = false
         GROUP BY "laborCategory"`,
        [tenantId],
      )) as HeadcountRow[];

      const byCategory = new Map<LaborCategory | null, number>(
        countRows.map((row) => [row.laborCategory, Number(row.headcount)]),
      );

      // Stable row shape: every workforce category present (zero included);
      // an UNCLASSIFIED row appears only when unclassified employees exist.
      const rows: HrPersonnelRow[] = [
        LaborCategory.MANAGER,
        LaborCategory.TECHNICAL,
        LaborCategory.UNSKILLED,
      ].map((category) => ({ category, headcount: byCategory.get(category) ?? 0 }));

      const unclassifiedCount = byCategory.get(null) ?? 0;
      if (unclassifiedCount > 0) {
        rows.push({ category: null, headcount: unclassifiedCount });
      }

      return {
        rows,
        totalHeadcount: rows.reduce((sum, r) => sum + r.headcount, 0),
        unclassifiedCount,
      };
    });
  }
}
