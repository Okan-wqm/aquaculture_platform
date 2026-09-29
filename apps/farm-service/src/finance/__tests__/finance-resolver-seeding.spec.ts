/**
 * Finance aggregations seed before they read (K10 layer 4, PR-T1).
 *
 * WHY: the summary and per-batch aggregations now read on a READ-ONLY tenant
 * scope (FinanceLedgerReader), which cannot insert the default category
 * catalogue and fails closed when it is missing — a missing catalogue would
 * otherwise report "this farm spent nothing". The GraphQL path therefore seeds
 * (idempotent write, its own boundary) BEFORE it opens the read scope. This
 * spec pins that order; dropping the seed turns every fresh tenant's finance
 * tab into an error.
 */
import { collaborator } from '@platform/testing';
import type { CommandBus, QueryBus } from '@platform/cqrs';

import { createFarmScopeHarness } from '../../__tests__/helpers/farm-tenant-scope.helper';
import { GetFinanceBatchTotalsQuery, GetFinanceSummaryQuery } from '../queries';
import { FinanceResolver } from '../resolvers/finance.resolver';
import { FinanceGranularity } from '../services/finance-ledger-model';
import type { FinanceLedgerQueryService } from '../services/finance-ledger-query.service';

const TENANT = '4b0b1f63-5d1a-4a55-9a0e-2f7a8c1d3e10';
const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-03-01T00:00:00Z');

describe('FinanceResolver — seed before the read-only aggregation scope', () => {
  function build(): { resolver: FinanceResolver; order: string[]; seeded: jest.Mock } {
    const order: string[] = [];
    const seeded = jest.fn(async (): Promise<void> => {
      order.push('seed');
    });
    const queryBus = collaborator<QueryBus>(
      {
        execute: jest.fn().mockImplementation(async (query: unknown) => {
          order.push(query instanceof GetFinanceSummaryQuery ? 'summary' : 'batchTotals');
          if (query instanceof GetFinanceBatchTotalsQuery) return [];
          return {
            currency: 'NOK',
            totalExpense: 0,
            totalRevenue: 0,
            netResult: 0,
            byCategory: [],
            series: [],
          };
        }),
      },
      'QueryBus',
    );
    const ledger = collaborator<FinanceLedgerQueryService>(
      { ensureDefaultCategories: seeded },
      'FinanceLedgerQueryService',
    );
    const resolver = new FinanceResolver(
      collaborator<CommandBus>({}, 'CommandBus'),
      queryBus,
      createFarmScopeHarness().scopes,
      ledger,
    );
    return { resolver, order, seeded };
  }

  it('financeSummary seeds the tenant catalogue, then reads', async () => {
    const { resolver, order, seeded } = build();
    await resolver.financeSummary(TENANT, FROM, TO, FinanceGranularity.MONTH);
    expect(seeded).toHaveBeenCalledWith(TENANT);
    expect(order).toEqual(['seed', 'summary']);
  });

  it('financeBatchTotals seeds the tenant catalogue, then reads', async () => {
    const { resolver, order, seeded } = build();
    await resolver.financeBatchTotals(TENANT, FROM, TO);
    expect(seeded).toHaveBeenCalledWith(TENANT);
    expect(order).toEqual(['seed', 'batchTotals']);
  });
});
