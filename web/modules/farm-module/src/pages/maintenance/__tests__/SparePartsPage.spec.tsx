/**
 * SparePartsPage specs (FARM-MEDIUM-120).
 *
 * The page renders the spare-parts inventory list plus the stock-summary KPI
 * cards, both fetched from the backend (SpareParts + StockSummary).
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
import { SparePartsPage } from '../SparePartsPage';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query SpareParts',
      result: { spareParts: { items: [], total: 0, page: 1, limit: 20, totalPages: 0 } },
    },
    {
      match: 'query StockSummary',
      result: {
        stockSummary: {
          totalParts: 0,
          inStockCount: 0,
          lowStockCount: 0,
          outOfStockCount: 0,
          totalValueDecimal: '0.00',
        },
      },
    },
  ]);
});

describe('SparePartsPage', () => {
  it('renders the spare-parts page from the backend list + stock-summary queries', async () => {
    renderWithProviders(<SparePartsPage />);

    expect(await screen.findByText('Yedek Parçalar')).toBeInTheDocument();
    await waitFor(() => {
      expect(requestMock.mock.calls.some(([q]) => (q as string).includes('query SpareParts'))).toBe(
        true,
      );
    });
  });
});
