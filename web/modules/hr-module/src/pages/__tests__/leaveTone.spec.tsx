/**
 * Leave is a category, not a risk (design handoff "Tenant Console —
 * Industrial", README §7.8).
 *
 * Inside the console the warning scale paints the hazard amber, which
 * Industry keeps for alarm and risk. A count of people on leave, and the tile
 * that opens leave management, carry no risk, so they paint from the neutral
 * scales their sibling tiles use. What does ask for action keeps the amber:
 * the dashboard's "Pending Leave Approvals" banner. A missing person is a
 * risk, so Attendance's "Absent Today" keeps the red.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AttendancePage } from '../AttendancePage';
import HRAnalyticsPage from '../HRAnalyticsPage';
import { HRDashboardPage } from '../HRDashboardPage';

vi.mock('../../hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks')>();
  return {
    ...actual,
    useCurrentEmployeeId: () => 'employee-1',
    useHRDashboardStats: () => ({
      data: { totalEmployees: 12, activeEmployees: 11, onLeaveEmployees: 2 },
      isLoading: false,
    }),
    // The pending list is a paginated connection: the page counts `total` and previews `items[0]`.
    usePendingLeaveApprovals: () => ({
      data: {
        items: [
          {
            id: 'leave-1',
            createdAt: '2026-10-15T08:00:00Z',
            employee: { firstName: 'Ada', lastName: 'Berg' },
          },
        ],
        total: 1,
      },
      isLoading: false,
    }),
    useExpiringCertifications: () => ({ data: [], isLoading: false }),
    useCurrentlyOffshore: () => ({ data: [], isLoading: false }),
    useDepartments: () => ({ data: [], isLoading: false }),
    useWorkAreas: () => ({ data: [] }),
    useDailyAttendanceOverview: () => ({
      data: { present: 9, absent: 1, onLeave: 2, attendanceRate: 90 },
      isLoading: false,
    }),
    useAttendanceRecords: () => ({ data: { items: [], total: 0 }, isLoading: false }),
  };
});

vi.mock('../../hooks/useHrFinance', () => ({
  useHrFinanceSummary: () => ({ data: undefined }),
}));

// Each fetches its own data and is not under test here.
vi.mock('../../components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components')>();
  return {
    ...actual,
    CertificationExpiryAlert: () => null,
    SeaLandSplitView: () => null,
  };
});
vi.mock('../../components/attendance/TimeClockWidget', () => ({
  TimeClockWidget: () => null,
}));

/** A utility on a scale the console paints as an alarm (amber or red). */
const RISK_SCALE = /(?:^|[\s:])(?:bg|text|border)-(?:warning|accent|error)-\d/;

/** Every class name painted on `element` and under it, SVG icons included. */
function paint(element: Element): string {
  return [element, ...element.querySelectorAll('*')]
    .map((node) => node.getAttribute('class') ?? '')
    .join(' ');
}

/** The stat card that carries `label`. */
function card(label: string): Element {
  const found = screen.getByText(label).closest('.rounded-xl');
  if (found === null) throw new Error(`no card around "${label}"`);
  return found;
}

function renderPage(page: React.ReactElement): void {
  render(<MemoryRouter>{page}</MemoryRouter>);
}

describe('leave reads as a category on the HR pages', () => {
  it('HR dashboard: the On Leave stat and the Leave Management tile are neutral', () => {
    renderPage(<HRDashboardPage />);

    expect(paint(card('On Leave'))).not.toMatch(RISK_SCALE);
    const tile = screen.getByText('Leave Management').closest('a');
    if (tile === null) throw new Error('no Leave Management link');
    expect(paint(tile.firstElementChild ?? tile)).not.toMatch(RISK_SCALE);
  });

  it('HR dashboard: the pending approvals banner keeps the amber, it asks for action', () => {
    renderPage(<HRDashboardPage />);

    expect(paint(card('Pending Leave Approvals'))).toMatch(/(?:^|\s)bg-warning-50(?:\s|$)/);
  });

  it('Attendance: the On Leave count and icon are neutral, Absent keeps the red', () => {
    renderPage(<AttendancePage />);

    expect(paint(card('On Leave'))).not.toMatch(RISK_SCALE);
    expect(paint(card('Absent Today'))).toMatch(/(?:^|\s)text-error-600(?:\s|$)/);
  });

  it('HR analytics: the On Leave stat is neutral', () => {
    renderPage(<HRAnalyticsPage />);

    expect(paint(card('On Leave'))).not.toMatch(RISK_SCALE);
  });
});
