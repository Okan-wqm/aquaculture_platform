/**
 * Get Auto Rule Query Handler
 *
 * Reads a single automation rule through the fail-closed tenant boundary
 * (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { AutoRule } from '../entities/auto-rule.entity';
import { GetAutoRuleQuery } from '../queries/get-auto-rule.query';

@QueryHandler(GetAutoRuleQuery)
export class GetAutoRuleHandler implements IQueryHandler<GetAutoRuleQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetAutoRuleQuery): Promise<AutoRule> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const rule = await queryRunner.manager.findOne(AutoRule, { where: { id, tenantId } });
      if (!rule) {
        throw new NotFoundException(`Otomatik kural bulunamadı: ${id}`);
      }
      return rule;
    });
  }
}
