/**
 * Dashboard stock widget — one row per short stock TIER (plan K8, V-B1-6).
 *
 * `storageOverview.lowStockAlerts` lists the tenant pool of an item and each
 * site below its site policy as separate rows. The widget used to key rows by
 * `itemId` and label neither tier nor site, so one item short in the pool and
 * at a site rendered as two indistinguishable rows under one React key, and
 * the badge called the tier count "critical items".
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { StorageOverviewData } from '../../hooks/useDashboardData';

const storageOverview = vi.fn();

// Only the storage query carries data; the other widgets stay in their
// loading skeleton so the spec renders the stock widget alone.
vi.mock('../../hooks/useDashboardData', () => {
  const loading = (): Record<string, unknown> => ({
    data: undefined,
    isLoading: true,
    isError: false,
    refetch: vi.fn(),
  });
  return {
    useTaskStats: loading,
    useTodaysTasks: loading,
    useCriticalWaterQuality: loading,
    useStorageOverview: (): Record<string, unknown> => ({
      data: storageOverview(),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});

import OverviewWidgets from '../OverviewWidgets';

const OVERVIEW: StorageOverviewData = {
  totalStockValue: 0,
  totalItems: 3,
  lowStockAlertCount: 2,
  recentMovementsCount: 0,
  lowStockAlerts: [
    {
      itemId: 'feed-1',
      itemName: 'Pellet 3mm',
      itemType: 'feed',
      level: 'SITE',
      siteId: 'site-1',
      siteName: 'Bergen',
      currentQuantity: 30,
      minStock: 40,
      onOrderQuantity: 0,
      unit: 'kg',
    },
    {
      itemId: 'feed-1',
      itemName: 'Pellet 3mm',
      itemType: 'feed',
      level: 'POOL',
      siteId: null,
      siteName: null,
      currentQuantity: 110,
      minStock: 120,
      onOrderQuantity: 5,
      unit: 'kg',
    },
  ],
};

describe('StockWidget — low-stock tiers', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    storageOverview.mockReturnValue(OVERVIEW);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.clearAllMocks();
  });

  it('renders the pool row and the site row of one item separately, each with its tier', () => {
    // SCENARIO: feed-1 is short at site Bergen (30 / 40) and in the tenant pool
    // (110 / 120, 5 kg on order). EXPECTS: two rows, one labelled with the site,
    // one with the pool (plus its open orders), and no duplicate-key warning
    // from React — the rows are keyed by (item, tier, site).
    render(<OverviewWidgets />);

    expect(screen.getAllByText('Pellet 3mm')).toHaveLength(2);
    expect(screen.getByText(/Site: Bergen/)).toBeInTheDocument();
    expect(screen.getByText(/All sites \(pool\)/)).toBeInTheDocument();
    expect(screen.getByText('+5 kg on order')).toBeInTheDocument();
    const duplicateKeyWarnings = consoleError.mock.calls.filter((call) =>
      String(call[0]).includes('same key'),
    );
    expect(duplicateKeyWarnings).toEqual([]);
  });

  it('badges the server tier count as low-stock alerts, the number farm-module shows', () => {
    // SCENARIO: the server reports lowStockAlertCount = 2 (one per tier row).
    // EXPECTS: the badge says "2 low-stock alerts", not a "critical" item count.
    render(<OverviewWidgets />);

    const heading = screen.getByText('Stok Durumu');
    const header = heading.parentElement;
    if (header === null) throw new Error('stock widget header missing');
    expect(within(header).getByText('2 low-stock alerts')).toBeInTheDocument();
    expect(screen.queryByText(/Kritik/)).not.toBeInTheDocument();
  });
});
