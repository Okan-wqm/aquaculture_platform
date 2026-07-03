/**
 * AnalyticsPage specs (FARM-MEDIUM-120 batch 8).
 *
 * The tanks analytics tab derives its KPIs from the real useTanksList hook —
 * the spec verifies the KPIs reflect the backend tank data rather than
 * placeholder values.
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
import AnalyticsPage from '../AnalyticsPage';

const TANK = {
  id: 'tank-1',
  tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
  name: 'Grow-out Tank A',
  code: 'GT-A',
  departmentId: 'dep-1',
  department: { id: 'dep-1', name: 'Grow-out', siteId: 'site-1', site: { id: 'site-1', name: 'Main Site' } },
  equipmentTypeId: 'et-1',
  equipmentType: { id: 'et-1', name: 'Tank', code: 'TANK', category: 'tank', icon: null },
  specifications: { maxBiomass: 1000 },
  volume: 100,
  isTank: true,
  currentBiomass: 250,
  currentCount: 1000,
  status: 'OPERATIONAL',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  batchMetrics: {
    batchNumber: 'B-2026-001',
    batchId: 'batch-1',
    pieces: 1000,
    avgWeight: 250,
    biomass: 250,
    density: 3.1,
    capacityUsedPercent: 25,
    isOverCapacity: false,
    isMixedBatch: false,
    mortalityRate: 2.5,
    cleanerFishQuantity: 0,
  },
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query EquipmentWithBatches',
      result: { equipmentList: { items: [TANK], total: 1, page: 1, limit: 200, totalPages: 1 } },
    },
  ]);
});

describe('AnalyticsPage', () => {
  it('derives tank analytics KPIs from the backend tank list', async () => {
    renderWithProviders(<AnalyticsPage />, { route: '/analytics', path: 'analytics/*' });

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query EquipmentWithBatches'),
        ),
      ).toBe(true);
    });

    // FARM-MEDIUM-132: assert the KPIs the docstring promises are DERIVED from the
    // fixture, not merely that a query fired — a broken rollup must fail here.
    expect(await screen.findByText('Total Tanks')).toBeInTheDocument();
    // Single tank in the fixture with batchMetrics.mortalityRate 2.5.
    expect(await screen.findByText('2.5%')).toBeInTheDocument();
    expect(screen.getByText('Mortality Rate')).toBeInTheDocument();
  });
});
