/**
 * APA-131 (frontend half) — an unmeasured system metric must render as an
 * explicit placeholder, never as a number and never as the string "null".
 *
 * `null` is silent in JSX/template literals: `${null}` prints "null" and `null`
 * in arithmetic coerces to 0, so making the contract nullable on the backend is
 * only half the fix — without this the dashboard would have shown "null%" or a
 * confident "0ms". The page also used to overwrite `uptimePercent` client-side
 * with the share of healthy services, inventing an uptime figure from a
 * different quantity entirely; that overwrite is gone.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-131
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import AnalyticsDashboardPage from '../AnalyticsDashboardPage';
import { analyticsApi } from '../../services/adminApi';

vi.mock('../../services/adminApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/adminApi')>('../../services/adminApi');
  return {
    ...actual,
    analyticsApi: {
      ...actual.analyticsApi,
      getDashboardSummary: vi.fn(),
      getTenantGrowthTrend: vi.fn(),
      getRevenueTrend: vi.fn(),
      getUserActivity: vi.fn(),
    },
  };
});

const api = vi.mocked(analyticsApi);

describe('AnalyticsDashboardPage unmeasured system metrics (APA-131)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDashboardSummary.mockResolvedValue({
      system: {
        totalStorageBytes: null,
        usedStorageBytes: null,
        storageUtilization: null,
        apiCallsToday: null,
        apiCallsThisMonth: null,
        avgResponseTimeMs: null,
        errorRate: null,
        uptimePercent: null,
        activeConnections: null,
        queuedJobs: null,
      },
    });
    api.getTenantGrowthTrend.mockResolvedValue({ data: [] });
    api.getRevenueTrend.mockResolvedValue({ data: [] });
    api.getUserActivity.mockResolvedValue({ data: [] });
  });

  it('renders "Not measured" for unmeasured metrics — never "null" or a fabricated number', async () => {
    render(
      <BrowserRouter>
        <AnalyticsDashboardPage />
      </BrowserRouter>,
    );

    await waitFor(() => expect(api.getDashboardSummary).toHaveBeenCalled());

    const placeholders = await screen.findAllByText(/Not measured/i);
    expect(placeholders.length).toBeGreaterThan(0);

    // The null-leak hazards: a raw "null" anywhere, or the retired constants.
    expect(document.body.textContent).not.toMatch(/\bnull\b/);
    expect(screen.queryByText(/^100%$/)).not.toBeInTheDocument();
  });

  it('renders unmeasured churn as a placeholder and shows no trend arrow (APA-135)', async () => {
    api.getDashboardSummary.mockResolvedValue({
      // Real counts alongside unmeasured churn — the card must not infer one
      // from the other, and must not fall back to the retired -0.5 delta.
      tenants: {
        total: 42,
        active: 30,
        inactive: 6,
        trial: 4,
        suspended: 6,
        newThisMonth: 5,
        churnedThisMonth: null,
        churnRate: null,
        growthRate: null,
        byPlan: {},
      },
    });

    render(
      <BrowserRouter>
        <AnalyticsDashboardPage />
      </BrowserRouter>,
    );

    await waitFor(() => expect(api.getDashboardSummary).toHaveBeenCalled());

    // No "null%", no "0%" masquerading as a measured churn rate.
    expect(document.body.textContent).not.toMatch(/\bnull\b/);
    expect(document.body.textContent).not.toMatch(/-0\.5/);
    expect(await screen.findByText(/No tenant-lifecycle ledger/i)).toBeInTheDocument();

    // The measured counts still render (the total appears on more than one card).
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
  });
});