/**
 * GetFinanceCategoriesHandler — the tenant's category catalogue.
 * Seeds the defaults on first touch so a fresh tenant always sees the
 * standard taxonomy (idempotent — ON CONFLICT DO NOTHING).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { FinanceCategory } from '../entities/finance-category.entity';
import { GetFinanceCategoriesQuery } from '../queries/get-finance-categories.query';
import { FinanceCategorySeedService } from '../services/finance-category-seed.service';

@Injectable()
@QueryHandler(GetFinanceCategoriesQuery)
export class GetFinanceCategoriesHandler
  implements IQueryHandler<GetFinanceCategoriesQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly seedService: FinanceCategorySeedService,
  ) {}

  async execute(query: GetFinanceCategoriesQuery): Promise<FinanceCategory[]> {
    const { tenantId, scope, includeArchived } = query;
    // Seed (idempotently) in its own committed write tx BEFORE opening the
    // read-only boundary — seeding is a write concern.
    await this.seedService.ensureDefaults(this.dataSource, tenantId);
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const qb = manager
        .createQueryBuilder(FinanceCategory, 'c')
        .where('c."tenantId" = :tenantId', { tenantId })
        .orderBy('c."displayOrder"', 'ASC')
        .addOrderBy('c."name"', 'ASC');
      if (scope) {
        qb.andWhere('c."scope" = :scope', { scope });
      }
      if (!includeArchived) {
        qb.andWhere('c."isActive" = true');
      }
      return qb.getMany();
    });
  }
}
