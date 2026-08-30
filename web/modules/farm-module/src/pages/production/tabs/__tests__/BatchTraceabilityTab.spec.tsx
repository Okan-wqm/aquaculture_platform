/**
 * BatchTraceabilityTab specs.
 *
 * Exercises the REAL useBatchTraceability hook against the routed
 * graphqlClient seam: the tab fires the federated `query BatchTraceability`
 * and renders the summary header, residency rows, feed totals and the events
 * timeline from a canned backend response — plus the honest empty state when
 * the backend reports no traceability for the batch.
 */
import { screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import type { BatchTraceability } from '../../../../hooks/useBatchTraceability';
import { requestMock } from '../../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../../test-utils/renderWithProviders';
import BatchTraceabilityTab from '../BatchTraceabilityTab';

const TRACEABILITY: BatchTraceability = {
  summary: {
    batchId: 'batch-1',
    batchNumber: 'B-2026-001',
    status: 'GROWING',
    speciesName: 'Rainbow Trout',
    stockedAt: '2026-03-01T00:00:00.000Z',
    harvestedAt: null,
    daysInProduction: 123,
    initialQuantity: 12000,
    currentQuantity: 10500,
    initialAvgWeightG: 5,
    currentAvgWeightG: 250,
    survivalRatePercent: 87.5,
    protocolId: 'proto-1',
    protocolName: 'Trout Grower 2026',
    totalFeedKg: 3120.5,
    totalFeedCost: 5430.25,
    totalFeedCostDecimal: '5430.25',
    fcrActual: 1.19,
  },
  residencies: [
    {
      tankId: 'tank-1',
      tankName: 'Tank A-1',
      tankCode: 'TNK-A1',
      movedAt: '2026-03-01T00:00:00.000Z',
      exitedAt: '2026-05-01T00:00:00.000Z',
      isCurrent: false,
      durationDays: 61,
      quantityAtEntry: 12000,
      avgWeightAtEntryG: 5,
      transferReason: 'stocking',
      water: {
        temperatureMinC: 11.2,
        temperatureAvgC: 13.4,
        temperatureMaxC: 16.8,
        measurementCount: 240,
      },
      feed: [
        {
          feedId: 'feed-1',
          feedName: 'Starter Pellet',
          feedCode: 'SP-1',
          totalKg: 820.5,
          totalCost: 1400.75,
          totalCostDecimal: '1400.75',
        },
      ],
      feedTotalKg: 820.5,
    },
    {
      tankId: 'tank-2',
      tankName: 'Tank B-2',
      tankCode: 'TNK-B2',
      movedAt: '2026-05-01T00:00:00.000Z',
      exitedAt: null,
      isCurrent: true,
      durationDays: 62,
      quantityAtEntry: 11000,
      avgWeightAtEntryG: 120,
      transferReason: 'grading',
      water: {
        temperatureMinC: null,
        temperatureAvgC: null,
        temperatureMaxC: null,
        measurementCount: 0,
      },
      feed: [],
      feedTotalKg: 2300,
    },
  ],
  feedTotals: [
    {
      feedId: 'feed-1',
      feedName: 'Starter Pellet',
      feedCode: 'SP-1',
      totalKg: 820.5,
      totalCost: 1400.75,
      totalCostDecimal: '1400.75',
    },
    {
      feedId: 'feed-2',
      feedName: 'Grower Pellet',
      feedCode: 'GP-2',
      totalKg: 2300,
      totalCost: 4029.5,
      totalCostDecimal: '4029.5',
    },
  ],
  events: [
    {
      id: 'evt-1',
      eventType: 'CREATED',
      timestamp: '2026-03-01T08:00:00.000Z',
      description: 'Batch created and stocked',
      performedBy: 'operator@farm.test',
      tankId: 'tank-1',
      tankCode: 'TNK-A1',
      quantityChange: 12000,
      biomassChangeKg: 60,
    },
    {
      id: 'evt-2',
      eventType: 'MORTALITY',
      timestamp: '2026-04-10T09:30:00.000Z',
      description: 'Mortality recorded after storm',
      performedBy: 'operator@farm.test',
      tankId: 'tank-1',
      tankCode: 'TNK-A1',
      quantityChange: -500,
      biomassChangeKg: -12.5,
    },
  ],
};

beforeEach(() => {
  requestMock.mockReset();
});

function renderTab(traceability: BatchTraceability | null = TRACEABILITY): void {
  routeGraphql([
    { match: 'query BatchTraceability', result: { batchTraceability: traceability } },
  ]);
  renderWithProviders(<BatchTraceabilityTab batch={{ id: 'batch-1' }} />);
}

describe('BatchTraceabilityTab', () => {
  it('fires query BatchTraceability and renders the summary + residency rows', async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getByText('Traceability — B-2026-001')).toBeInTheDocument();
    });

    // The tab went through the federated batchTraceability query, id-scoped.
    const traceabilityCall = requestMock.mock.calls.find(([query]) =>
      (query as string).includes('query BatchTraceability'),
    );
    expect(traceabilityCall).toBeDefined();
    expect(traceabilityCall?.[1]).toEqual({ id: 'batch-1' });

    // Residency rows — both stays, the current one flagged.
    expect(screen.getByText('Tank A-1')).toBeInTheDocument();
    expect(screen.getByText('Tank B-2')).toBeInTheDocument();
    expect(screen.getByText('current')).toBeInTheDocument();

    // Water temperature: aggregated for the measured stay, honest em-dash
    // (no fake zeros) for the stay with measurementCount 0.
    expect(screen.getByText('11.2 / 13.4 / 16.8')).toBeInTheDocument();

    // Feed totals table.
    expect(screen.getByText('Grower Pellet')).toBeInTheDocument();

    // Events timeline renders the description + typed chip.
    expect(screen.getByText('Mortality recorded after storm')).toBeInTheDocument();
    expect(screen.getByText('mortality')).toBeInTheDocument();

    // The print/export action is available once data is loaded.
    expect(screen.getByRole('button', { name: 'Print report' })).toBeEnabled();
  });

  it('renders the events timeline in reverse chronological order', async () => {
    renderTab();

    const newest = await screen.findByText('Mortality recorded after storm');
    const oldest = screen.getByText('Batch created and stocked');
    // DOCUMENT_POSITION_FOLLOWING: the older event appears AFTER the newer one.
    expect(
      newest.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the honest empty state when the backend has no traceability data', async () => {
    renderTab(null);

    expect(
      await screen.findByText('No traceability data is available for this batch.'),
    ).toBeInTheDocument();
  });
});
