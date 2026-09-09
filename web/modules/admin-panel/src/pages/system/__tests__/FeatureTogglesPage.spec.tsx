/**
 * FeatureTogglesPage on the admin data layer (ADMIN-HIGH-121).
 *
 * Every write on this page edited the local array and never asked the server
 * what had happened. The flip was the worst of them:
 *
 *     await systemSettingsApi.toggleFeature(toggle.id, newEnabled);
 *     setToggles(toggles.map((t) =>
 *       t.id === toggle.id ? { ...t, status: newEnabled ? 'enabled' : 'disabled' } : t));
 *
 * The row showed the status the CLIENT had decided on, not the one the server
 * returned — so a flag the endpoint put into any other state, or refused to
 * change while returning 200, still read as flipped. Create pushed its own
 * optimistic row and closed the modal on it; update spliced; delete filtered.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { FeatureTogglesPage } from '../FeatureTogglesPage';
import { systemSettingsApi } from '../../../services/adminApi';
import type { FeatureToggle } from '../../../services/types';

vi.mock('../../../services/adminApi', () => ({
  systemSettingsApi: {
    getFeatureToggles: vi.fn(),
    toggleFeature: vi.fn(),
    createFeatureToggle: vi.fn(),
    updateFeatureToggle: vi.fn(),
    deleteFeatureToggle: vi.fn(),
  },
}));

const listMock = vi.mocked(systemSettingsApi.getFeatureToggles);
const flipMock = vi.mocked(systemSettingsApi.toggleFeature);

function toggle(overrides: Partial<FeatureToggle> = {}): FeatureToggle {
  return {
    id: 'toggle-1',
    key: 'new_billing_flow',
    name: 'New billing flow',
    scope: 'global',
    status: 'disabled',
    rolloutPercentage: 0,
    isExperimental: true,
    requiresRestart: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  } as FeatureToggle;
}

function page(rows: FeatureToggle[]) {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit: 20,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FeatureTogglesPage />
    </QueryClientProvider>,
  );
}

describe('FeatureTogglesPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(page([toggle()]));
    flipMock.mockResolvedValue(toggle({ status: 'enabled' }));
  });

  it('forwards the abort signal to the read', async () => {
    renderPage();

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('re-reads the list after a flip rather than writing the new status locally', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('New billing flow');
    await user.click(screen.getByRole('button', { name: /Enable/i }));

    await waitFor(() => expect(flipMock).toHaveBeenCalledWith('toggle-1', true));
    // The regression: the row took the status the client had decided on.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('reports a rejected flip on the page', async () => {
    const user = userEvent.setup();
    flipMock.mockRejectedValue(new Error('feature flag service unavailable'));
    renderPage();

    await screen.findByText('New billing flow');
    await user.click(screen.getByRole('button', { name: /Enable/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('feature flag service unavailable');
  });

  it('reports a failed read instead of an empty flag list', async () => {
    listMock.mockRejectedValue(new Error('feature toggles unavailable'));
    renderPage();

    // An empty table here reads as "this platform has no feature flags",
    // which is a different fact from "the list did not load".
    expect(await screen.findByRole('alert')).toHaveTextContent('feature toggles unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
