/**
 * FinanceCategorySeedService — idempotency + registry parity.
 *
 *   1. ensureDefaults inserts every default with ON CONFLICT DO NOTHING
 *      (duplicates are impossible by construction, not by check).
 *   2. The per-process guard makes the second call a no-op.
 *   3. Every DERIVED_COST_SOURCES systemCode has a seeded default
 *      category — the registry can never point at a code the seed does
 *      not create (source-level parity; the invariant spec repeats this
 *      check platform-wide).
 */
import type { EntityManager, Repository } from 'typeorm';

import {
  DEFAULT_FARM_FINANCE_CATEGORIES,
  FinanceCategorySeedService,
} from '../services/finance-category-seed.service';
import { DERIVED_COST_SOURCES } from '../services/derived-cost-sources';
import type { FinanceCategory } from '../entities/finance-category.entity';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/** Fully-typed partial double (same helper pattern as the feeding spec). */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('FinanceCategorySeedService', () => {
  function makeService() {
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = mock<EntityManager>({ query });
    const repository = mock<Repository<FinanceCategory>>({
      find: jest.fn().mockResolvedValue([]),
      manager,
    });
    const service = new FinanceCategorySeedService(repository);
    return { service, manager, query };
  }

  it('inserts every default category with ON CONFLICT DO NOTHING', async () => {
    const { service, manager, query } = makeService();

    await service.ensureDefaults(manager, TENANT_ID);

    expect(query).toHaveBeenCalledTimes(DEFAULT_FARM_FINANCE_CATEGORIES.length);
    for (const call of query.mock.calls as Array<[string, unknown[]]>) {
      expect(call[0]).toContain('ON CONFLICT');
      expect(call[0]).toContain('DO NOTHING');
      expect(call[1][0]).toBe(TENANT_ID);
    }
  });

  it('is a per-process no-op on the second call for the same tenant', async () => {
    const { service, manager, query } = makeService();

    await service.ensureDefaults(manager, TENANT_ID);
    await service.ensureDefaults(manager, TENANT_ID);

    expect(query).toHaveBeenCalledTimes(DEFAULT_FARM_FINANCE_CATEGORIES.length);
  });

  it('seeds a default category for every derived cost source code', () => {
    const seededCodes = new Set(DEFAULT_FARM_FINANCE_CATEGORIES.map((c) => c.code));
    for (const source of DERIVED_COST_SOURCES) {
      expect(seededCodes).toContain(source.systemCode);
    }
  });

  it('marks exactly one category as computed with the 5% rule', () => {
    const computed = DEFAULT_FARM_FINANCE_CATEGORIES.filter((c) => c.computedRule);
    expect(computed).toHaveLength(1);
    expect(computed[0]?.code).toBe('OTHER_VARIABLE');
    expect(computed[0]?.computedRule).toEqual({
      type: 'PERCENT_OF_SCOPE_TOTAL',
      percent: 5,
      base: 'NON_COMPUTED',
    });
  });
});
