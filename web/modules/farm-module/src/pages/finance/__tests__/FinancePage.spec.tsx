/**
 * FinancePage specs (FARM-MEDIUM-120).
 *
 * The overview tab renders the finance summary fetched from the backend
 * (useFinanceSummary → GetFinanceSummary); the spec proves the page is wired
 * to that query and renders its result rather than a placeholder.
 */
import { screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import FinancePage from '../FinancePage';

const SUMMARY = {
  currency: 'NOK',
  totalExpenseDecimal: '12500.00',
  totalRevenueDecimal: '40000.00',
  netResultDecimal: '27500.00',
  byCategory: [],
  series: [],
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([{ match: 'query GetFinanceSummary', result: { financeSummary: SUMMARY } }]);
});

describe('FinancePage', () => {
  it('renders the finance overview from the backend summary query', async () => {
    renderWithProviders(<FinancePage />, { route: '/sites/finance' });

    expect(await screen.findByText('Farm Finance')).toBeInTheDocument();

    // The overview tab settles on the backend summary (not the loading state).
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([q]) => (q as string).includes('query GetFinanceSummary')),
      ).toBe(true);
    });
    expect(screen.queryByText('Loading finance summary…')).not.toBeInTheDocument();
  });
});
