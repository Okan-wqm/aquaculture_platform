/**
 * The messaging monitoring dashboard, on the admin data layer
 * (ADMIN-MEDIUM-152).
 *
 * Recorded deliberately: this page was NOT lying. Every KPI already rendered
 * an em dash until the aggregate arrived, the outbox panel rendered only when
 * it had one, a null `oldestPendingAgeSeconds` already showed a dash rather
 * than "0s", and the error banner already carried the server's own message.
 *
 * So these tests exist to keep that standing, and to pin the two narrow things
 * the migration changed: the read now cancels and is keyed on the shell's
 * cache, and the tenant chart no longer says "No tenant messaging activity
 * recorded yet." when the read FAILED.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import MessagingMonitoringPage from '../MessagingMonitoringPage';
import { messagingApi } from '../../../services/api/messaging';
import type { MessagingMonitoringStats } from '../../../services/types/messaging';

vi.mock('../../../services/api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/messaging')>(
    '../../../services/api/messaging',
  );
  return { ...actual, messagingApi: { getMonitoringStats: vi.fn() } };
});

const monitoring = vi.mocked(messagingApi.getMonitoringStats);

/** Complete, as the contract declares it — no cast. */
function stats(overrides: Partial<MessagingMonitoringStats> = {}): MessagingMonitoringStats {
  return {
    totals: {
      totalMessages: 1_240_000,
      messages24h: 8_400,
      messages7d: 61_000,
      activeChannels: 312,
      tenantCount: 17,
    },
    perTenant: [
      {
        tenantId: '88888888-8888-4888-8888-888888888888',
        messageCount24h: 900,
        messageCount7d: 5_400,
        totalMessages: 120_000,
        activeChannels: 12,
      },
    ],
    outbox: { pendingCount: 4, failedCount: 0, oldestPendingAgeSeconds: null },
    generatedAt: '2026-09-10T09:00:00.000Z',
    ...overrides,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessagingMonitoringPage />
    </QueryClientProvider>,
  );
}

describe('MessagingMonitoringPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitoring.mockResolvedValue(stats());
  });

  it('forwards an abort signal, so leaving the page cancels the read', async () => {
    renderPage();

    await waitFor(() => expect(monitoring).toHaveBeenCalled());
    expect(monitoring.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('renders the totals it was given', async () => {
    renderPage();

    expect(await screen.findByText('1,240,000')).toBeInTheDocument();
    expect(screen.getByText('8,400')).toBeInTheDocument();
    expect(screen.getByText('312')).toBeInTheDocument();
  });

  it('keeps showing an em dash for a pending age of null, not "0s"', async () => {
    renderPage();

    expect(await screen.findByText('Oldest pending age')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0s')).not.toBeInTheDocument();
  });

  it('calls a dead-lettered outbox what it is', async () => {
    monitoring.mockResolvedValue(
      stats({ outbox: { pendingCount: 2, failedCount: 9, oldestPendingAgeSeconds: 4_200 } }),
    );
    renderPage();

    expect(await screen.findByText('Attention required')).toBeInTheDocument();
    expect(screen.getByText(/9 event\(s\) are dead-lettered/)).toBeInTheDocument();
    // 4200s = 1h 10m, and the helper must not print raw seconds.
    expect(screen.getByText('1h 10m')).toBeInTheDocument();
  });

  it('names a failed read and claims nothing about tenant activity', async () => {
    monitoring.mockRejectedValue(new Error('monitoring aggregate is unreachable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'monitoring aggregate is unreachable',
    );
    // The regression: this sentence rendered on a failed read too.
    expect(
      screen.queryByText('No tenant messaging activity recorded yet.'),
    ).not.toBeInTheDocument();
    // And no KPI invents a number.
    expect(screen.queryByText('1,240,000')).not.toBeInTheDocument();
  });

  it('still reports genuinely empty tenant activity as empty', async () => {
    monitoring.mockResolvedValue(stats({ perTenant: [] }));
    renderPage();

    expect(
      await screen.findByText('No tenant messaging activity recorded yet.'),
    ).toBeInTheDocument();
  });

  it('dates the numbers by when they were aggregated, not when they were fetched', async () => {
    renderPage();

    expect(await screen.findByText(/Last computed:/)).toBeInTheDocument();
  });
});
