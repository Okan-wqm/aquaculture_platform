/**
 * MaintenanceSchedulesPage specs (FARM-MEDIUM-120).
 *
 * The schedules list is driven by the backend MaintenanceSchedules query —
 * the page renders its result (here an empty result → empty state) rather
 * than a mock table.
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
import { MaintenanceSchedulesPage } from '../MaintenanceSchedulesPage';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query MaintenanceSchedules',
      result: {
        maintenanceSchedules: { items: [], total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    },
  ]);
});

describe('MaintenanceSchedulesPage', () => {
  it('renders the schedules page from the backend list query', async () => {
    renderWithProviders(<MaintenanceSchedulesPage />);

    expect(await screen.findByText('Bakım Planları')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([q]) => (q as string).includes('query MaintenanceSchedules')),
      ).toBe(true);
    });
  });
});
