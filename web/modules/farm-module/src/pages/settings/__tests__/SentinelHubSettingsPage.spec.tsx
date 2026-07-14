/**
 * SentinelHubSettingsPage specs (FARM-MEDIUM-120).
 *
 * The page reads the current Sentinel Hub configuration status from the
 * backend (SentinelHubStatus) and renders the settings form around it.
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
import { SentinelHubSettingsPage } from '../SentinelHubSettingsPage';

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query SentinelHubStatus',
      result: {
        sentinelHubStatus: {
          isConfigured: false,
          clientIdMasked: null,
          instanceIdMasked: null,
          lastUsed: null,
          usageCount: 0,
        },
      },
    },
  ]);
});

describe('SentinelHubSettingsPage', () => {
  it('renders the settings page and reads the backend configuration status', async () => {
    renderWithProviders(<SentinelHubSettingsPage />);

    expect((await screen.findAllByText(/Sentinel Hub/)).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([q]) => (q as string).includes('query SentinelHubStatus')),
      ).toBe(true);
    });
  });
});
