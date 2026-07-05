/**
 * SetupPage specs (FARM-MEDIUM-120 batch 8).
 *
 * Exercises the real useSiteList hook against the routed graphqlClient seam:
 * the sites tab renders site rows from the backend, and nested-route tab
 * navigation loads the departments tab with its own query.
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
import SetupPage from '../SetupPage';

const SITE = {
  id: 'site-1',
  name: 'Main Site',
  code: 'MAIN',
  type: 'SEA',
  status: 'ACTIVE',
  description: null,
  location: { latitude: 60.39, longitude: 5.32, altitude: null },
  address: { street: null, city: 'Bergen', state: null, postalCode: null, country: 'NO' },
  country: 'NO',
  region: 'Vestland',
  timezone: 'Europe/Oslo',
  totalArea: null,
  siteManager: null,
  contactEmail: null,
  contactPhone: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query Sites',
      result: { sites: { items: [SITE], total: 1, page: 1, limit: 100 } },
    },
    { match: 'query Departments', result: { departments: { items: [], total: 0, page: 1, limit: 100 } } },
  ]);
});

describe('SetupPage', () => {
  it('renders site rows from the backend on the sites tab', async () => {
    renderWithProviders(<SetupPage />, { route: '/sites/setup/sites', path: 'sites/setup/*' });

    expect((await screen.findAllByText(/Main Site/)).length).toBeGreaterThan(0);
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('query Sites')),
    ).toBe(true);
  });

  it('navigates to the departments tab and fires its query', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SetupPage />, { route: '/sites/setup/sites', path: 'sites/setup/*' });
    await screen.findAllByText(/Main Site/);

    const departmentsLink = screen.getAllByRole('button').find((el) =>
      /Departments|Departman|Üniteler|Units/i.test(el.textContent ?? ''),
    );
    if (!departmentsLink) throw new Error('Departments tab trigger not found');
    await user.click(departmentsLink);

    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          (query as string).includes('query Departments'),
        ),
      ).toBe(true);
    });
  });
});
