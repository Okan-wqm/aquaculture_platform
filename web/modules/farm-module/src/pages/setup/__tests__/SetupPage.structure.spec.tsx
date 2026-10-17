/**
 * SetupPage › Facility structure tab wiring.
 *
 * /sites/setup/structure is a SetupPage tab like the others: the tab bar shows
 * its (localized) label and the nested route mounts the structure tree, which
 * reads the same site / department / system queries as the flat tabs.
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

const STAMP = '2026-01-01T00:00:00.000Z';

const SITE = {
  id: 'site-1',
  name: 'Main Site',
  code: 'MAIN',
  type: 'SEA_CAGE',
  status: 'ACTIVE',
  siteManager: null,
  isActive: true,
  createdAt: STAMP,
  updatedAt: STAMP,
};

function page<T>(items: T[]): Record<string, unknown> {
  return {
    items,
    total: items.length,
    page: 1,
    limit: 100,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    { match: 'query Sites', result: { sites: page([SITE]) } },
    { match: 'query Departments', result: { departments: page([]) } },
    { match: 'query Systems', result: { systems: page([]) } },
    { match: 'query SiteContacts', result: { siteContacts: [] } },
    {
      match: 'query SiteDeletePreview',
      result: {
        siteDeletePreview: {
          site: { id: 'site-1', name: 'Main Site', code: 'MAIN' },
          canDelete: true,
          blockers: [],
          affectedItems: { departments: [], systems: [], equipment: [], tanks: [], totalCount: 0 },
        },
      },
    },
    { match: 'query FarmProcessFlows', result: { processes: { items: [], total: 0 } } },
  ]);
});

describe('SetupPage — facility structure tab', () => {
  it('mounts the structure tree at /sites/setup/structure', async () => {
    renderWithProviders(<SetupPage />, { route: '/sites/setup/structure', path: 'sites/setup/*' });

    expect(await screen.findByRole('treeitem', { name: /Main Site/ })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Facility structure' }),
    ).toBeInTheDocument();
    for (const operation of ['query Sites', 'query Departments', 'query Systems']) {
      expect(requestMock.mock.calls.some(([query]) => (query as string).includes(operation))).toBe(
        true,
      );
    }
  });

  it('opens the structure tab from the tab bar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SetupPage />, { route: '/sites/setup/sites', path: 'sites/setup/*' });
    await screen.findAllByText(/Main Site/);

    await user.click(screen.getByRole('button', { name: 'Facility structure' }));

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
  });
});
