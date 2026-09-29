import type { EntityManager } from 'typeorm';

import { FinanceSettings, PLATFORM_DEFAULT_CURRENCY } from '../entities/finance-settings.entity';

/**
 * The tenant's default currency, read through the manager the caller holds.
 *
 * WHY a function and not only a FinanceSettingsService method: readers that
 * run on a TenantScope (the AI finance subjects, K10 layer 4) must not depend
 * on a service that holds a DataSource. FinanceSettingsService delegates here,
 * so both paths read the same row the same way.
 */
export async function readFinanceDefaultCurrency(
  manager: EntityManager,
  tenantId: string,
): Promise<string> {
  const settings = await manager.findOne(FinanceSettings, { where: { tenantId } });
  return settings?.defaultCurrency ?? PLATFORM_DEFAULT_CURRENCY;
}
