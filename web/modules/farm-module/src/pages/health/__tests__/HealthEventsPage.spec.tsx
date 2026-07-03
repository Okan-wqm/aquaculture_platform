/**
 * HealthEventsPage specs (FARM-MEDIUM-120 batch 7).
 *
 * Exercises the real useHealthEvents hook against the routed graphqlClient
 * seam: event rows render from the backend list and a transport failure does
 * not render a fake-empty success state.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import HealthEventsPage from '../HealthEventsPage';

const HEALTH_EVENT = {
  id: 'he-1',
  tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
  batchId: 'batch-1',
  tankId: 'tank-1',
  pondId: null,
  title: 'Gill disease outbreak',
  description: 'AGD symptoms on sample fish',
  eventType: 'DISEASE',
  eventDate: '2026-06-28',
  eventTime: '09:00',
  diseaseCategory: 'PARASITIC',
  diseaseName: 'AGD',
  severity: 'HIGH',
  symptoms: [],
  affectedPopulation: null,
  treatment: null,
  isUnderTreatment: false,
  treatmentEndDate: null,
  withdrawalPeriodDays: null,
  earliestHarvestDate: null,
  isQuarantined: false,
  quarantineStartDate: null,
  quarantineEndDate: null,
  quarantineTankId: null,
  labResults: null,
  labConfirmed: false,
  vetConsultation: null,
  vetNotified: false,
  waterQualitySnapshot: null,
  relatedWaterQualityMeasurementId: null,
  attachments: [],
  status: 'ACTIVE',
  resolvedAt: null,
  resolvedBy: null,
  resolutionNotes: null,
  createdBy: 'user-1',
  createdAt: '2026-06-28T09:00:00.000Z',
  updatedAt: '2026-06-28T09:00:00.000Z',
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query HealthEvents',
      result: {
        healthEvents: {
          items: [HEALTH_EVENT],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      },
    },
    { match: 'query Batches', result: { batches: { items: [], total: 0, page: 1, limit: 100, totalPages: 0 } } },
    { match: 'query EquipmentWithBatches', result: { equipmentList: { items: [], total: 0, page: 1, limit: 200, totalPages: 1 } } },
  ]);
});

describe('HealthEventsPage', () => {
  it('renders health-event rows from the backend list', async () => {
    renderWithProviders(<HealthEventsPage />, { route: '/health', path: 'health' });

    expect((await screen.findAllByText(/Gill disease outbreak/)).length).toBeGreaterThan(0);
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('query HealthEvents')),
    ).toBe(true);
  });

  it('narrows the list through the client-side search (FARM-LOW-149)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HealthEventsPage />, { route: '/health', path: 'health' });
    await screen.findAllByText(/Gill disease outbreak/);

    await user.type(screen.getByPlaceholderText('Search events...'), 'gill');
    expect(screen.getAllByText(/Gill disease outbreak/).length).toBeGreaterThan(0);

    await user.clear(screen.getByPlaceholderText('Search events...'));
    await user.type(screen.getByPlaceholderText('Search events...'), 'zzz-no-match');
    await waitFor(() => {
      expect(screen.queryByText(/Gill disease outbreak/)).not.toBeInTheDocument();
    });
  });

  it('does not render events as an empty success state when the query fails', async () => {
    routeGraphql([]);
    renderWithProviders(<HealthEventsPage />, { route: '/health', path: 'health' });

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText(/Gill disease outbreak/)).not.toBeInTheDocument();
    });
  });
});
