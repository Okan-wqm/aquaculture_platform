/**
 * StorageHubPage outage specs (ORPHAN-MEDIUM-592).
 *
 * WHY THIS EXISTS AS A TEST RATHER THAN A CODE REVIEW: this defect class has
 * now appeared five times in this app — a failed fetch rendering as an
 * authoritative claim about the farm. It survived every previous review because
 * reading the code shows a plausible empty state; only rendering it under a
 * FAILED query shows the lie. So these specs drive the real error path and
 * assert what a warehouse worker actually sees.
 *
 * The distinction under test: "0 Items, 0 Low Stock, 0 Today, no recent
 * movements" is a clean bill of health. An outage must never produce it.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { StorageHubPage } from '../StorageHubPage';

const h = vi.hoisted(() => ({
  isError: false,
  isLoading: false,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useWarehouseSummary', () => ({
  useWarehouseSummary: () => ({
    // The zeroed shape the hook really returns when the query fails and the
    // IndexedDB fallback also misses — DEFAULT_SUMMARY.
    summary: {
      totalItems: 0,
      lowStockAlertCount: 0,
      todaysMovementCount: 0,
      lowStockItems: [],
      recentMovements: [],
      feedCoverage: [],
    },
    isLoading: h.isLoading,
    isError: h.isError,
    refetch: h.refetch,
  }),
}));

vi.mock('@/hooks/useMobilePermissions', () => ({
  useMobilePermissions: () => ({ canAccess: () => true, permissionsDegraded: false }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { name: 'Ola Nordvik', role: 'MODULE_MANAGER' }, tenantId: 't1' }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// The hub renders inside the app shell in production; here it is mounted bare,
// so its shell-provided contexts are stubbed rather than wrapped in providers.
vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ pendingCount: 0, isOnline: true, isSyncing: false }),
}));

afterEach(() => {
  h.isError = false;
  h.isLoading = false;
  cleanup();
});

describe('StorageHubPage — an outage is not an empty warehouse', () => {
  it('does NOT present zeroes as a clean bill of health when the fetch failed', () => {
    h.isError = true;
    render(<StorageHubPage />);

    // The exact wording may change; what must not is that the screen states the
    // figures are unavailable rather than showing them as real.
    expect(screen.getByText(/could not load the warehouse/i)).toBeInTheDocument();
    expect(screen.getByText(/unavailable, not zero/i)).toBeInTheDocument();
  });

  it('offers a retry rather than a dead end', () => {
    h.isError = true;
    render(<StorageHubPage />);

    const retry = screen.getByRole('button', { name: /try again/i });
    retry.click();
    expect(h.refetch).toHaveBeenCalled();
  });

  it('says the movement history is unavailable, not that nothing happened', () => {
    // "No recent movements" on a failed fetch tells a worker the warehouse was
    // quiet. It may have been extremely busy.
    h.isError = true;
    render(<StorageHubPage />);

    expect(screen.queryByText(/no recent movements/i)).not.toBeInTheDocument();
    expect(screen.getByText(/could not load movements/i)).toBeInTheDocument();
  });

  it('still shows the ordinary empty state when the fetch SUCCEEDED and the warehouse is idle', () => {
    // The other half of the contract: a genuinely empty warehouse must not be
    // dressed up as an error either.
    h.isError = false;
    render(<StorageHubPage />);

    expect(screen.getByText(/no recent movements/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
  });
});
