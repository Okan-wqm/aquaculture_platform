/**
 * Dashboard overview — Industry console fit (README §6 "Köşe: 0", §7.8).
 *
 * The console scope squares every radius token, but `rounded-full` reads none:
 * the meter bars, the badge skeleton and the activity icon tiles stayed pills
 * and circles. Only a status dot keeps its round shape.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { RecentActivity } from '../../hooks/useDashboardData';

// recharts' ResponsiveContainer measures its parent; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const query = <T,>(data: T, isLoading = false) => ({
  data,
  isLoading,
  isError: false,
  refetch: vi.fn(),
});

let loading = false;
const activities: RecentActivity[] = [
  {
    id: 'a1',
    type: 'alert',
    title: 'Low oxygen',
    description: 'Tank 3',
    timestamp: new Date(),
    severity: 'error',
  },
];

vi.mock('../../hooks/useDashboardData', () => ({
  useTaskStats: () =>
    query(
      { totalToday: 4, completedToday: 2, overdueCount: 1, upcomingCount: 1, completionRate: 50 },
      loading,
    ),
  useTodaysTasks: () =>
    query(
      [{ id: 't1', title: 'Feed', status: 'COMPLETED', priority: 'LOW', dueTime: '09:00' }],
      loading,
    ),
  useStorageOverview: () =>
    query(
      {
        lowStockAlertCount: 1,
        lowStockAlerts: [
          {
            itemId: 's1',
            itemName: 'Feed 3mm',
            itemType: 'FEED',
            currentQuantity: 5,
            minStock: 10,
            unit: 'kg',
          },
        ],
      },
      loading,
    ),
  useCriticalWaterQuality: () =>
    query(
      [
        {
          id: 'w1',
          tankId: 't1',
          temperature: 22,
          dissolvedOxygen: 7,
          pH: 7.2,
          ammonia: null,
          nitrite: null,
          overallStatus: 'OPTIMAL',
          measuredAt: new Date().toISOString(),
        },
      ],
      loading,
    ),
  useRecentActivity: () => query(activities, loading),
}));

import OverviewWidgets from '../OverviewWidgets';
import RecentActivityList from '../RecentActivityList';

/**
 * The package's own round boxes, a status dot excepted (the one round mark
 * Industry keeps). Only `div`s: shared-ui's Badge renders a `span` whose pill
 * shape is the primitive's, not this package's.
 */
function roundedNonDots(root: HTMLElement): Element[] {
  return [...root.querySelectorAll('div.rounded-full')].filter(
    (el) => !(el.classList.contains('w-2') && el.classList.contains('h-2')),
  );
}

describe('OverviewWidgets — Industry shapes', () => {
  it('draws the meter bars square', () => {
    loading = false;
    const { container } = render(<OverviewWidgets />);

    expect(screen.getByText('Su Kalitesi')).toBeInTheDocument();
    expect(roundedNonDots(container)).toEqual([]);
  });

  it('draws the loading skeleton square', () => {
    loading = true;
    const { container } = render(<OverviewWidgets />);

    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(roundedNonDots(container)).toEqual([]);
  });
});

describe('RecentActivityList — Industry shapes', () => {
  it('draws the activity icon tiles square', () => {
    loading = false;
    const { container } = render(<RecentActivityList />);

    expect(screen.getByText('Low oxygen')).toBeInTheDocument();
    expect(roundedNonDots(container)).toEqual([]);
  });

  it('draws the loading skeleton square', () => {
    loading = true;
    const { container } = render(<RecentActivityList />);

    expect(roundedNonDots(container)).toEqual([]);
  });
});
