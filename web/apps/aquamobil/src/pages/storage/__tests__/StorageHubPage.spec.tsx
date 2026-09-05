/**
 * StorageHubPage — the warehouse feed renders EVERY MovementType the server
 * can emit (FARM-HIGH-300).
 *
 * The movement-type config used to be keyed by the three kinds the mobile
 * wizard records while the wire carried the lowercase entity value, so any
 * real movement row threw on `config.icon`. The config is now total over the
 * generated MovementType enum; this spec pins that a feed with all six kinds
 * renders, and that only actionable feed-coverage rows (not OK) are listed.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

import { StorageHubPage } from '../StorageHubPage';

import type { MovementType, WarehouseFeedCoverageStatus } from '@/generated/graphql';
import type { WarehouseSummary } from '@/types';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/useMobilePermissions', () => ({
  useMobilePermissions: () => ({ canAccess: () => true }),
}));

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ isOnline: true }),
}));

const h = vi.hoisted(() => {
  const state: { summary: WarehouseSummary | undefined } = { summary: undefined };
  return state;
});

vi.mock('@/hooks/useWarehouseSummary', () => ({
  useWarehouseSummary: () => ({ summary: h.summary, isLoading: false }),
}));

const MOVEMENT_TYPES: readonly MovementType[] = [
  'IN',
  'OUT',
  'TRANSFER',
  'WASTE',
  'ADJUSTMENT',
  'RETURN',
];

function coverageRow(
  feedId: string,
  coverageStatus: WarehouseFeedCoverageStatus,
): WarehouseSummary['feedCoverage'][number] {
  return {
    feedId,
    feedCode: `FEED-${feedId}`,
    feedName: `Feed ${feedId}`,
    daysOfCover: coverageStatus === 'OK' ? null : 2,
    stockoutDate: null,
    coverageStatus,
  };
}

function summaryWith(overrides: Partial<WarehouseSummary>): WarehouseSummary {
  return {
    totalItems: 0,
    lowStockAlertCount: 0,
    todaysMovementCount: 0,
    lowStockItems: [],
    recentMovements: [],
    feedCoverage: [],
    ...overrides,
  };
}

describe('StorageHubPage (FARM-HIGH-300 — total MovementType config)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a movement row for every MovementType the schema declares', () => {
    h.summary = summaryWith({
      recentMovements: MOVEMENT_TYPES.map((movementType, index) => ({
        id: `m-${index}`,
        movementType,
        itemName: `Item ${movementType}`,
        quantity: index + 1,
        unit: 'kg',
        createdAt: new Date().toISOString(),
      })),
    });

    render(<StorageHubPage />);

    // The feed caps at MAX_MOVEMENTS (5); the first five kinds must all render
    // without the config lookup throwing.
    for (const movementType of MOVEMENT_TYPES.slice(0, 5)) {
      expect(screen.getByText(`Item ${movementType}`)).toBeTruthy();
    }
  });

  it('lists only the feed-coverage rows that need action (CRITICAL/WARNING)', () => {
    h.summary = summaryWith({
      feedCoverage: [
        coverageRow('ok', 'OK'),
        coverageRow('warn', 'WARNING'),
        coverageRow('crit', 'CRITICAL'),
      ],
    });

    render(<StorageHubPage />);

    expect(screen.queryByText('FEED-ok')).toBeNull();
    expect(screen.getByText('FEED-warn')).toBeTruthy();
    expect(screen.getByText('FEED-crit')).toBeTruthy();
  });
});
