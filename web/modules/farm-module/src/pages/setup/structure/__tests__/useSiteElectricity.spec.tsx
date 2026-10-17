/**
 * useSiteElectricity — the electricity a site booked this month, read from
 * the finance ledger (FARM-MEDIUM-440 review: the site's cost tile is real
 * data, not a preview).
 *
 * farm-service seeds a system ELECTRICITY expense category and a manual
 * expense carries its site, so the hook resolves that category (archived
 * included — its booked lines still count) and totals the site's manual
 * lines in it from the first of the month to today. The GraphQL transport is
 * the only fake; the finance hooks under it run as in production.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { routeGraphql } from '../../../../test-utils/mockGraphqlClient';
import { requestMock } from '../../../../test-utils/sharedUiMock';
import { monthToDate, useSiteElectricity } from '../useSiteElectricity';

const CATEGORY = {
  scope: 'FARM_OPEX',
  kind: 'EXPENSE',
  isSystem: true,
  displayOrder: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CATEGORIES = [
  { ...CATEGORY, id: 'cat-feed', code: 'FEED', name: 'Feed', isActive: true },
  { ...CATEGORY, id: 'cat-power', code: 'ELECTRICITY', name: 'Electricity', isActive: false },
];

function ledgerLine(amountDecimal: string): Record<string, unknown> {
  return {
    id: `line-${amountDecimal}`,
    origin: 'MANUAL',
    categoryId: 'cat-power',
    categoryName: 'Electricity',
    kind: 'EXPENSE',
    amount: Number(amountDecimal),
    amountDecimal,
    currency: 'TRY',
    entryDate: '2026-10-03',
    siteId: 'site-a',
    estimated: false,
    editable: true,
  };
}

function wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function ledgerCalls(): Array<Record<string, unknown> | undefined> {
  return requestMock.mock.calls
    .filter(([query]) => String(query).includes('query GetFinanceLedger'))
    .map(([, variables]) => variables as Record<string, unknown> | undefined);
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('monthToDate', () => {
  it('spans the first of the local month to today', () => {
    expect(monthToDate(new Date(2026, 9, 16, 23, 30))).toEqual({
      from: '2026-10-01',
      to: '2026-10-16',
    });
    expect(monthToDate(new Date(2027, 0, 1, 0, 5))).toEqual({
      from: '2027-01-01',
      to: '2027-01-01',
    });
  });
});

describe('useSiteElectricity', () => {
  it('totals the site’s manual ELECTRICITY lines booked this month', async () => {
    routeGraphql([
      { match: 'query GetFinanceCategories', result: { financeCategories: CATEGORIES } },
      {
        match: 'query GetFinanceLedger',
        result: { financeLedger: [ledgerLine('12000.40'), ledgerLine('345.20')] },
      },
    ]);

    const { result } = renderHook(() => useSiteElectricity('site-a'), { wrapper });

    await waitFor(() =>
      expect(result.current).toEqual({
        status: 'ready',
        totals: [{ currency: 'TRY', amount: 12345.6 }],
      }),
    );
    const categoriesCall = requestMock.mock.calls.find(([query]) =>
      String(query).includes('query GetFinanceCategories'),
    );
    expect(categoriesCall?.[1]).toEqual({ scope: 'FARM_OPEX', includeArchived: true });
    expect(ledgerCalls()).toEqual([
      {
        ...monthToDate(new Date()),
        siteId: 'site-a',
        categoryId: 'cat-power',
        includeDerived: false,
        limit: 200,
        offset: 0,
      },
    ]);
  });

  it('reports nothing booked when the tenant has no ELECTRICITY category, without a ledger read', async () => {
    routeGraphql([
      { match: 'query GetFinanceCategories', result: { financeCategories: [CATEGORIES[0]] } },
    ]);

    const { result } = renderHook(() => useSiteElectricity('site-a'), { wrapper });

    await waitFor(() => expect(result.current).toEqual({ status: 'ready', totals: [] }));
    expect(ledgerCalls()).toEqual([]);
  });

  it('reports a failed read as an error, never as zero', async () => {
    routeGraphql([
      { match: 'query GetFinanceCategories', result: { financeCategories: CATEGORIES } },
      {
        match: 'query GetFinanceLedger',
        result: () => {
          throw new Error('Forbidden');
        },
      },
    ]);

    const { result } = renderHook(() => useSiteElectricity('site-a'), { wrapper });

    await waitFor(() => expect(result.current).toEqual({ status: 'error' }));
  });
});
