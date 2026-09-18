/**
 * JobQueuePage on the admin data layer (ADMIN-HIGH-121), and the six zeros it
 * showed for a dashboard that had not loaded (ADMIN-HIGH-127).
 *
 * `defaultDashboard` was `{ totalJobs: 0, pendingJobs: 0, runningJobs: 0,
 * completedToday: 0, failedToday: 0, avgDuration: 0 }`, installed by the catch
 * whenever `/system/jobs/dashboard` failed. On a job-queue screen "0 failed
 * today" is the one number an operator reads to decide nothing is wrong, and
 * it sat above a table with an error line the same handler had set — easy to
 * miss beneath four confident cards.
 *
 * The writes were worse than stale: each handler patched local state
 * (`setJobs(jobs.map(...))` after a retry, `setDashboard({...})` after a pause)
 * so the row showed a status the server had never confirmed.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { JobQueuePage } from '../JobQueuePage';
import { systemSettingsApi } from '../../../services/adminApi';
import type { BackgroundJob, JobQueue } from '../../../services/types';

vi.mock('../../../services/adminApi', () => ({
  systemSettingsApi: {
    getJobDashboard: vi.fn(),
    getJobs: vi.fn(),
    retryJob: vi.fn(),
    cancelJob: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
  },
}));

const dashboardMock = vi.mocked(systemSettingsApi.getJobDashboard);
const jobsMock = vi.mocked(systemSettingsApi.getJobs);
const retryMock = vi.mocked(systemSettingsApi.retryJob);

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1',
    name: 'nightly-rollup',
    queueName: 'analytics',
    jobType: 'scheduled',
    status: 'failed',
    priority: 10,
    attempts: 2,
    maxAttempts: 3,
    timeoutMs: 60000,
    isRecurring: false,
    isPaused: false,
    createdAt: '2026-09-08T23:00:00.000Z',
    updatedAt: '2026-09-08T23:05:00.000Z',
    ...overrides,
  } as BackgroundJob;
}

function queue(): JobQueue {
  return {
    id: 'queue-1',
    name: 'analytics',
    isActive: true,
    isPaused: false,
    concurrency: 4,
    maxJobsPerSecond: 20,
    defaultMaxRetries: 3,
    defaultTimeoutMs: 60000,
    pendingCount: 5,
    runningCount: 1,
    completedCount: 900,
    failedCount: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-08T23:00:00.000Z',
  } as JobQueue;
}

function dashboard() {
  return {
    totalJobs: 1204,
    pendingJobs: 5,
    runningJobs: 1,
    completedToday: 318,
    failedToday: 7,
    avgDuration: 2400,
    queues: [queue()],
    recentJobs: [job()],
  };
}

function jobPage(rows: BackgroundJob[]) {
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
      <JobQueuePage />
    </QueryClientProvider>,
  );
}

describe('JobQueuePage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboardMock.mockResolvedValue(dashboard());
    jobsMock.mockResolvedValue(jobPage([job()]));
    retryMock.mockResolvedValue(job({ status: 'pending', attempts: 0 }));
  });

  it('forwards the abort signal to both reads', async () => {
    renderPage();

    await waitFor(() => expect(dashboardMock).toHaveBeenCalled());
    expect(dashboardMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(jobsMock).toHaveBeenCalled());
    expect(jobsMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('shows the counts the server reported', async () => {
    renderPage();

    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(screen.getByText('1204')).toBeInTheDocument();
  });

  it('reports the failure instead of showing zero failed jobs today', async () => {
    dashboardMock.mockRejectedValue(new Error('job dashboard unavailable'));
    renderPage();

    // The regression: four cards of zeros, including "0 failed today", for a
    // dashboard that had not loaded.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('job dashboard unavailable');
    expect(screen.queryByText('Failed Today')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('re-reads the server after a retry instead of patching the row locally', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('nightly-rollup');
    // The failed row's own Retry button; the failure notice is not rendered
    // while every read has answered.
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(retryMock).toHaveBeenCalledWith('job-1'));
    // The old handler wrote `status: 'pending'` into local state and never
    // asked the server, so the row claimed a state the backend had not
    // acknowledged and the queue counters stayed stale beside it.
    await waitFor(() => expect(dashboardMock).toHaveBeenCalledTimes(2));
  });

  it('reports a rejected action next to the table it concerns', async () => {
    const user = userEvent.setup();
    retryMock.mockRejectedValue(new Error('retry rejected by the queue'));
    renderPage();

    await screen.findByText('nightly-rollup');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    // It used to land in a fixed-position toast in the bottom-right corner.
    expect(await screen.findByRole('alert')).toHaveTextContent('retry rejected by the queue');
  });
});
