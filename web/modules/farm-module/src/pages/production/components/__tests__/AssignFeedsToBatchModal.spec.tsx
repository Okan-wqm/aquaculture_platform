/**
 * AssignFeedsToBatchModal — which feeds can be planned for a batch (FARM-HIGH-337).
 *
 * Stock bands are derived from the storage ledger now, so a feed that has not
 * been received yet reads OUT_OF_STOCK. Assigning a feed plans future feeding
 * and consumes no stock; only the operator lifecycle (EXPIRED/DISCONTINUED)
 * may exclude a feed.
 */
import { screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import { AssignFeedsToBatchModal } from '../AssignFeedsToBatchModal';

function feed(id: string, code: string, status: string): Record<string, unknown> {
  return { id, code, name: `Feed ${code}`, status, isActive: true, unit: 'kg' };
}

describe('AssignFeedsToBatchModal feed options', () => {
  it('offers feeds in any stock band and hides only lifecycle-retired feeds', async () => {
    // SCENARIO: a new feed (OUT_OF_STOCK, never received), a LOW_STOCK feed, an
    // AVAILABLE feed, and a DISCONTINUED and an EXPIRED feed.
    // EXPECTS: the three stock-band feeds are options; the two retired ones are not;
    // the list is requested as active feeds, not by stock status.
    routeGraphql([
      {
        match: 'query Feeds',
        result: {
          feeds: {
            items: [
              feed('f1', 'NEW', 'OUT_OF_STOCK'),
              feed('f2', 'LOW', 'LOW_STOCK'),
              feed('f3', 'OK', 'AVAILABLE'),
              feed('f4', 'GONE', 'DISCONTINUED'),
              feed('f5', 'OLD', 'EXPIRED'),
            ],
            total: 5,
            page: 1,
            limit: 100,
            totalPages: 1,
          },
        },
      },
    ]);

    renderWithProviders(
      <AssignFeedsToBatchModal isOpen onClose={vi.fn()} batchId="batch-1" batchNumber="B-1" />,
    );

    await waitFor(() => expect(screen.getByText('NEW — Feed NEW')).toBeInTheDocument());
    expect(screen.getByText('LOW — Feed LOW')).toBeInTheDocument();
    expect(screen.getByText('OK — Feed OK')).toBeInTheDocument();
    expect(screen.queryByText('GONE — Feed GONE')).not.toBeInTheDocument();
    expect(screen.queryByText('OLD — Feed OLD')).not.toBeInTheDocument();

    const [, variables] =
      requestMock.mock.calls.find(([query]) => String(query).includes('query Feeds')) ?? [];
    expect(variables).toMatchObject({ filter: { isActive: true } });
    expect(variables).not.toHaveProperty('filter.status');
  });
});
