/**
 * FeedingProgramForm specs (FARM-MEDIUM-120).
 *
 * In create mode (no :programId) the multi-step form mounts on step 1 with the
 * per-program fetch disabled; the tank/feed selectors load from the backend
 * (EquipmentList + Feeds) only on later steps, so those routes are installed as
 * guards. The spec proves the create form mounts and renders step 1 without
 * crashing — the coverage the original campaign never had for this 2.5k-line form.
 */
import { screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import FeedingProgramForm from '../FeedingProgramForm';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query EquipmentList',
      result: { equipmentList: { items: [], total: 0, page: 1, limit: 200, totalPages: 0 } },
    },
    {
      match: 'query Feeds',
      result: { feeds: { items: [], total: 0, page: 1, limit: 200, totalPages: 0 } },
    },
  ]);
});

describe('FeedingProgramForm', () => {
  it('mounts the create form and renders step 1 without crashing', async () => {
    renderWithProviders(<FeedingProgramForm />, { route: '/feeding/programs/new' });

    expect((await screen.findAllByText(/Besleme program/i)).length).toBeGreaterThan(0);
  });
});
