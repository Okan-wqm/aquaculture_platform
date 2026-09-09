/**
 * OnboardingPage on the admin data layer (ADMIN-HIGH-121), and two things it
 * showed that were not measurements.
 *
 * 1. **"0 Stalled" for a read that failed.** `stats` was initialised to
 *    `{notStarted: 0, inProgress: 0, completed: 0, stalled: 0,
 *    avgCompletionDays: 0}` and the catch left it there. Those five cards are
 *    how an operator finds the tenants that are stuck, so a failed request
 *    rendered as "nothing needs attention".
 *
 * 2. **Three writes that failed in silence.** `handleInitializeOnboarding`,
 *    `handleAssignGuide` and `handleSkipOnboarding` each patched
 *    `progressList` on success and, on failure, called `console.error` and
 *    nothing else — no banner, no revert. Pressing "Skip Onboarding" on a
 *    refused request did nothing at all and said nothing about it.
 *
 * The detail panel also held its own copy of the selected row alongside the
 * list, so the two could disagree; it reads out of the list now.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { OnboardingPage } from '../OnboardingPage';
import { supportApi } from '../../services/adminApi';
import type { TenantOnboarding } from '../../services/adminApi';

vi.mock('../../services/adminApi', () => ({
  supportApi: {
    getOnboardingSteps: vi.fn(),
    getTenantOnboardings: vi.fn(),
    getOnboardingStats: vi.fn(),
    getTrainingResources: vi.fn(),
    initializeOnboarding: vi.fn(),
    assignOnboardingGuide: vi.fn(),
    skipOnboarding: vi.fn(),
  },
}));

const stepsMock = vi.mocked(supportApi.getOnboardingSteps);
const listMock = vi.mocked(supportApi.getTenantOnboardings);
const statsMock = vi.mocked(supportApi.getOnboardingStats);
const resourcesMock = vi.mocked(supportApi.getTrainingResources);
const skipMock = vi.mocked(supportApi.skipOnboarding);

function onboarding(overrides: Partial<TenantOnboarding> = {}): TenantOnboarding {
  return {
    tenantId: 'tenant-1',
    tenantName: 'Ocean Farms',
    status: 'in_progress',
    completedSteps: [],
    startedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as TenantOnboarding;
}

function page<T>(rows: T[]): {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
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

function stats(): Awaited<ReturnType<typeof supportApi.getOnboardingStats>> {
  return {
    total: 263,
    notStarted: 12,
    inProgress: 34,
    completed: 210,
    skipped: 7,
    avgCompletionPercent: 62,
    avgCompletionDays: 9,
    completionByStep: {},
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OnboardingPage />
    </QueryClientProvider>,
  );
}

/**
 * The stat card carrying `label`, scoped to the card's own label class —
 * "Stalled" and "In Progress" are also status-filter options and row badges,
 * so a page-wide text match finds those first.
 */
function card(label: string): HTMLElement {
  const parent = screen.getByText(label, {
    selector: 'div.text-sm',
  }).parentElement;
  if (!parent) throw new Error(`no card for ${label}`);
  return parent;
}

describe('OnboardingPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stepsMock.mockResolvedValue([]);
    listMock.mockResolvedValue(page([onboarding()]));
    statsMock.mockResolvedValue(stats());
    resourcesMock.mockResolvedValue([]);
    skipMock.mockResolvedValue(onboarding({ status: 'skipped' }));
  });

  it('forwards the abort signal to all four reads', async () => {
    renderPage();

    await waitFor(() => expect(stepsMock).toHaveBeenCalled());
    expect(stepsMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(statsMock).toHaveBeenCalled());
    expect(statsMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(resourcesMock).toHaveBeenCalled());
    expect(resourcesMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("shows the server's onboarding counts", async () => {
    renderPage();

    await screen.findByText('263');
    expect(within(card('Skipped')).getByText('7')).toBeInTheDocument();
    expect(within(card('In Progress')).getByText('34')).toBeInTheDocument();
  });

  it('renders an em dash rather than "0 Skipped" when the counts fail', async () => {
    statsMock.mockRejectedValue(new Error('onboarding stats unavailable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('onboarding stats unavailable');
    expect(within(card('Skipped')).getByText('—')).toBeInTheDocument();
    expect(within(card('Total Tenants')).getByText('—')).toBeInTheDocument();
  });

  it('reports a refused skip instead of doing nothing', async () => {
    skipMock.mockRejectedValue(new Error('onboarding is locked for this tenant'));
    renderPage();

    const actor = userEvent.setup();
    await actor.click(await screen.findByText('Ocean Farms'));
    await actor.click(await screen.findByRole('button', { name: /Skip Onboarding/ }));

    // The regression: the catch logged to the console and the operator saw
    // the button stop spinning, with no other change on screen.
    await waitFor(() => expect(skipMock).toHaveBeenCalledWith('tenant-1'));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((node) => node.textContent?.includes('locked for this tenant'))).toBe(true);
  });

  it('refetches the counts after a skip, not just the list', async () => {
    renderPage();
    await screen.findByText('263');

    const statsCallsBefore = statsMock.mock.calls.length;
    const actor = userEvent.setup();
    await actor.click(screen.getByText('Ocean Farms'));
    await actor.click(await screen.findByRole('button', { name: /Skip Onboarding/ }));

    await waitFor(() => expect(skipMock).toHaveBeenCalled());
    await waitFor(() => expect(statsMock.mock.calls.length).toBeGreaterThan(statsCallsBefore));
  });
});
