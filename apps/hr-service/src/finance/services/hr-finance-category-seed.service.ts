/**
 * HrFinanceCategorySeedService — idempotent default HR expense taxonomy.
 *
 * Same mechanism as the farm finance seed: ON CONFLICT DO NOTHING keyed
 * on the (tenantId, code) partial unique index; lazily invoked by
 * finance handlers so both new AND existing tenants get the defaults
 * with zero backfill scripts.
 *
 * The pension/social/medical fund lines are NOT seeded as categories —
 * they are computed projections of hr_payroll_cost_settings.
 */
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { HrFinanceComputedRule } from '../entities/hr-finance-category.entity';

export interface DefaultHrFinanceCategory {
  code: string;
  name: string;
  computedRule?: HrFinanceComputedRule;
  displayOrder: number;
}

export const DEFAULT_HR_FINANCE_CATEGORIES: readonly DefaultHrFinanceCategory[] = [
  { code: 'TRAINING', name: 'Training & certification', displayOrder: 10 },
  { code: 'RECRUITMENT', name: 'Recruitment', displayOrder: 20 },
  { code: 'PPE_EQUIPMENT', name: 'PPE & work equipment', displayOrder: 30 },
  { code: 'TRAVEL', name: 'Travel & accommodation', displayOrder: 40 },
  {
    code: 'OTHER_HR',
    name: 'Other cost (5% of annual salaries)',
    computedRule: { type: 'PERCENT_OF_ANNUAL_SALARIES', percent: 5 },
    displayOrder: 50,
  },
] as const;

@Injectable()
export class HrFinanceCategorySeedService {
  private readonly logger = new Logger(HrFinanceCategorySeedService.name);

  /** Per-process fast path; correctness comes from ON CONFLICT. */
  private readonly seededTenants = new Set<string>();

  async ensureDefaults(manager: EntityManager, tenantId: string): Promise<void> {
    if (this.seededTenants.has(tenantId)) {
      return;
    }
    for (const def of DEFAULT_HR_FINANCE_CATEGORIES) {
      await manager.query(
        `INSERT INTO hr_finance_categories
           ("tenantId", "name", "code", "computedRule", "isSystem", "isActive", "displayOrder")
         VALUES ($1, $2, $3, $4, true, true, $5)
         ON CONFLICT ("tenantId", "code") WHERE "code" IS NOT NULL
         DO NOTHING`,
        [
          tenantId,
          def.name,
          def.code,
          def.computedRule ? JSON.stringify(def.computedRule) : null,
          def.displayOrder,
        ],
      );
    }
    this.seededTenants.add(tenantId);
    this.logger.log(`HR finance categories ensured for tenant ${tenantId.slice(0, 8)}…`);
  }
}
