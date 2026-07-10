/**
 * Catalogue/read query handlers for HR finance: categories, entries and
 * payroll-cost settings.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import {
  runInTenantRead,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';

import { HrFinanceCategory } from '../entities/hr-finance-category.entity';
import { HrFinanceEntry } from '../entities/hr-finance-entry.entity';
import { PayrollCostSettings } from '../entities/payroll-cost-settings.entity';
import {
  GetHrFinanceCategoriesQuery,
  GetHrFinanceEntriesQuery,
  GetPayrollCostSettingsQuery,
} from '../queries/hr-finance.queries';
import { HrFinanceCategorySeedService } from '../services/hr-finance-category-seed.service';
import { PayrollCostSettingsService } from '../services/payroll-cost-settings.service';

@Injectable()
@QueryHandler(GetHrFinanceCategoriesQuery)
export class GetHrFinanceCategoriesHandler
  implements IQueryHandler<GetHrFinanceCategoriesQuery, HrFinanceCategory[]>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly seedService: HrFinanceCategorySeedService,
  ) {}

  async execute(query: GetHrFinanceCategoriesQuery): Promise<HrFinanceCategory[]> {
    const { tenantId, includeArchived } = query;
    // Write transaction: the first call per tenant lazily seeds defaults.
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      await this.seedService.ensureDefaults(manager, tenantId);
      const qb = manager
        .createQueryBuilder(HrFinanceCategory, 'c')
        .where('c."tenantId" = :tenantId', { tenantId })
        .orderBy('c."displayOrder"', 'ASC')
        .addOrderBy('c."name"', 'ASC');
      if (!includeArchived) {
        qb.andWhere('c."isActive" = true');
      }
      return qb.getMany();
    });
  }
}

@Injectable()
@QueryHandler(GetHrFinanceEntriesQuery)
export class GetHrFinanceEntriesHandler
  implements IQueryHandler<GetHrFinanceEntriesQuery, HrFinanceEntry[]>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHrFinanceEntriesQuery): Promise<HrFinanceEntry[]> {
    const { tenantId, filter } = query;
    return runInTenantRead(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(HrFinanceEntry, 'e')
        .leftJoinAndSelect('e.category', 'category')
        .where('e."tenantId" = :tenantId', { tenantId })
        .andWhere('e."isDeleted" = false')
        .orderBy('e."entryDate"', 'DESC')
        .addOrderBy('e."createdAt"', 'DESC')
        .take(filter.limit)
        .skip(filter.offset);
      if (filter.from) qb.andWhere('e."entryDate" >= :from', { from: filter.from });
      if (filter.to) qb.andWhere('e."entryDate" <= :to', { to: filter.to });
      if (filter.categoryId) qb.andWhere('e."categoryId" = :categoryId', { categoryId: filter.categoryId });
      if (filter.departmentHrId) {
        qb.andWhere('e."departmentHrId" = :departmentHrId', {
          departmentHrId: filter.departmentHrId,
        });
      }
      return qb.getMany();
    });
  }
}

@Injectable()
@QueryHandler(GetPayrollCostSettingsQuery)
export class GetPayrollCostSettingsHandler
  implements IQueryHandler<GetPayrollCostSettingsQuery, PayrollCostSettings>
{
  constructor(private readonly settingsService: PayrollCostSettingsService) {}

  async execute(query: GetPayrollCostSettingsQuery): Promise<PayrollCostSettings> {
    return this.settingsService.getSettings(query.tenantId);
  }
}
