/**
 * TodayPage — the Team area's "who is in today" view, on real reads only.
 *
 * The page is a join of five existing queries: dailyAttendanceOverview (KPI
 * counts), todaysAttendance for the whole workspace (every record of today),
 * teamWeeklyOverview (today's planned shifts, narrowed server-side by site),
 * teamLeaveCalendar(today, today) (approved and pending leave covering today)
 * and farm's activeSites { contacts } (sites nobody is responsible for).
 * These tests mock those hooks and pin what the page reads from each and how
 * the site filter narrows the roster and the leave list. The hooks follow the
 * workspace's module themselves; the page's own part of the scope is that farm
 * sites (filter chips, unassigned-sites panel) only appear where they apply.
 *
 * Fixtures use the wire shape: absent nullable fields arrive as `null`, and a
 * leave's dates arrive as DateTime — the stored calendar day at UTC midnight.
 */
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AttendanceStatus,
  LeaveRequestStatus,
  type AttendanceRecord,
  type DailyAttendanceOverview,
  type LeaveCalendarEntry,
} from '../../../types';
import type {
  DayEntry,
  EmployeeWeekSummary,
  TeamWeeklyOverview,
} from '../../../types/scheduling.types';
import type { SiteResponsibility } from '../../../hooks/useSiteResponsibility';
import { TodayPage } from '../TodayPage';

const TODAY = '2026-10-16';
const WEEK_START = '2026-10-12';

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

function ok<T>(data: T): QueryState<T> {
  return { data, isLoading: false, isError: false, refetch: vi.fn() };
}

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  todays: vi.fn(),
  team: vi.fn(),
  leave: vi.fn(),
  sites: vi.fn(),
}));

vi.mock('../../../hooks/useAttendance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAttendance')>();
  return {
    ...actual,
    useDailyAttendanceOverview: mocks.overview,
    useTeamTodaysAttendance: mocks.todays,
  };
});

vi.mock('../../../hooks/useScheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useScheduling')>();
  return { ...actual, useTeamWeeklyOverview: mocks.team };
});

vi.mock('../../../hooks/useLeaves', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useLeaves')>();
  return { ...actual, useTeamLeaveCalendar: mocks.leave };
});

vi.mock('../../../hooks/useSiteResponsibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useSiteResponsibility')>();
  return { ...actual, useSiteResponsibility: mocks.sites };
});

function day(overrides: Partial<DayEntry>): DayEntry {
  return {
    dayOfWeek: 'FRIDAY',
    date: TODAY,
    entryType: 'WORK',
    shiftCode: 'D',
    shiftName: 'Day',
    startTime: '07:00:00',
    endTime: '15:00:00',
    plannedMinutes: 480,
    ...overrides,
  };
}

function plan(employeeId: string, employeeName: string, today: DayEntry): EmployeeWeekSummary {
  return {
    employeeId,
    employeeName,
    position: 'Technician',
    weeklyPlanId: `plan-${employeeId}`,
    planStatus: 'draft',
    days: [today],
    totalWorkDays: 1,
    totalMinutes: 480,
    overtimeMinutes: 0,
  };
}

function teamOverview(
  employeePlans: EmployeeWeekSummary[],
  workingCount: number,
): TeamWeeklyOverview {
  return {
    weekStartDate: WEEK_START,
    weekEndDate: '2026-10-18',
    totalEmployees: employeePlans.length,
    employeePlans,
    daysSummary: [{ dayOfWeek: 'FRIDAY', date: TODAY, workingCount, offCount: 0, leaveCount: 0 }],
  };
}

function record(
  employeeId: string,
  status: AttendanceStatus,
  overrides: Partial<AttendanceRecord> = {},
): AttendanceRecord {
  return {
    id: `att-${employeeId}`,
    tenantId: 'tenant-1',
    createdAt: '2026-10-16T04:00:00.000Z',
    updatedAt: '2026-10-16T04:00:00.000Z',
    isDeleted: false,
    employeeId,
    date: TODAY,
    clockIn: '2026-10-16T06:52:00',
    status,
    isLate: false,
    lateMinutes: 0,
    isEarlyDeparture: false,
    earlyLeaveMinutes: 0,
    workedMinutes: 0,
    overtimeMinutes: 0,
    isOffshore: false,
    ...overrides,
  };
}

const OVERVIEW: DailyAttendanceOverview = {
  totalEmployees: 12,
  present: 6,
  absent: 3,
  late: 2,
  onLeave: 1,
  offshore: 0,
  attendanceRate: 67,
};

const ALL_SITES_PLANS = [
  plan('e1', 'Ayşe Kara', day({})),
  plan('e2', 'Emre Koç', day({})),
  plan('e3', 'Burak Şen', day({})),
  plan(
    'e6',
    'Zeynep Arslan',
    day({
      entryType: 'LEAVE',
      shiftCode: null,
      shiftName: null,
      startTime: null,
      endTime: null,
      plannedMinutes: 0,
    }),
  ),
];
const BODRUM_PLANS = [plan('e3', 'Burak Şen', day({}))];

const LEAVE: LeaveCalendarEntry[] = [
  {
    id: 'l1',
    employeeId: 'e6',
    employeeName: 'Zeynep Arslan',
    leaveTypeName: 'Annual leave',
    leaveTypeColor: 'teal',
    startDate: '2026-10-12T00:00:00.000Z',
    endDate: '2026-10-18T00:00:00.000Z',
    totalDays: 5,
    status: LeaveRequestStatus.PENDING,
    isHalfDayStart: false,
    isHalfDayEnd: false,
  },
];

const SITES: SiteResponsibility[] = [
  { id: 's1', name: 'Ayvalık', contacts: [{ id: 'c1', isPrimary: true }] },
  { id: 's2', name: 'Bodrum', contacts: [] },
];

/** The page as a workspace shows it: `null` is Company (no module scope). */
function pageIn(workspace: HrModuleCode | null): ReactElement {
  return (
    <MemoryRouter>
      <WorkforceScopeProvider moduleCode={workspace}>
        <TodayPage />
      </WorkforceScopeProvider>
    </MemoryRouter>
  );
}

function renderPage(workspace: HrModuleCode | null = null): ReturnType<typeof render> {
  return render(pageIn(workspace));
}

function kpi(label: string): string | null {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? null;
}

describe('TodayPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00'));
    mocks.overview.mockReturnValue(ok(OVERVIEW));
    mocks.todays.mockReturnValue(
      ok([
        record('e1', AttendanceStatus.PRESENT),
        record('e2', AttendanceStatus.LATE, { clockIn: '2026-10-16T07:38:00', lateMinutes: 38 }),
      ]),
    );
    mocks.team.mockImplementation((_week: string, _department?: string, siteId?: string) =>
      ok(siteId === 's2' ? teamOverview(BODRUM_PLANS, 1) : teamOverview(ALL_SITES_PLANS, 3)),
    );
    mocks.leave.mockReturnValue(ok(LEAVE));
    mocks.sites.mockReturnValue(ok(SITES));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('asks each source for today: the overview by date, every record, this week, leave covering today', () => {
    renderPage();

    expect(mocks.overview).toHaveBeenCalledWith(TODAY);
    expect(mocks.todays).toHaveBeenCalledWith();
    expect(mocks.team).toHaveBeenCalledWith(WEEK_START, undefined, undefined);
    expect(mocks.leave).toHaveBeenCalledWith(undefined, TODAY, TODAY);
  });

  it('shows the KPI band from the attendance overview and today’s planned count', () => {
    renderPage();

    expect(kpi('Scheduled today')).toBe('3');
    // Present counts everyone who came, late arrivals included.
    expect(kpi('Present')).toBe('8');
    expect(kpi('Late')).toBe('2');
    expect(kpi('Absent')).toBe('3');
    expect(kpi('Leave / sick')).toBe('1');
  });

  it('lists who is on shift with clock-in, lateness and the derived state', () => {
    renderPage();
    const roster = screen.getByRole('region', { name: 'On shift today' });

    const ayse = within(roster).getByText('Ayşe Kara').closest('tr');
    const emre = within(roster).getByText('Emre Koç').closest('tr');
    const burak = within(roster).getByText('Burak Şen').closest('tr');
    if (!ayse || !emre || !burak) throw new Error('roster rows missing');

    expect(within(ayse).getByText('06:52')).toBeInTheDocument();
    expect(within(ayse).getByText('Present')).toBeInTheDocument();
    expect(within(emre).getByText('+38 min')).toBeInTheDocument();
    expect(within(emre).getByText('Late')).toBeInTheDocument();
    expect(within(burak).getByText('Not clocked in')).toBeInTheDocument();
  });

  it('lists approved and pending leave covering today', () => {
    renderPage();
    const leave = screen.getByRole('region', { name: 'Open leave today' });

    expect(within(leave).getByText('Zeynep Arslan')).toBeInTheDocument();
    expect(within(leave).getByText('Annual leave')).toBeInTheDocument();
    expect(within(leave).getByText('Awaiting approval')).toBeInTheDocument();
    // The DateTime's UTC day is the stored leave day, whatever the browser's zone.
    expect(within(leave).getByText(/12 Oct–18 Oct/)).toBeInTheDocument();
  });

  it('shows no clock-out while a person is still on shift, and a dash for no clock-in', () => {
    mocks.todays.mockReturnValue(
      ok([
        record('e1', AttendanceStatus.PRESENT, { clockOut: null }),
        record('e2', AttendanceStatus.ABSENT, { clockIn: null, clockOut: null }),
      ]),
    );
    renderPage();
    const roster = screen.getByRole('region', { name: 'On shift today' });
    const ayse = within(roster).getByText('Ayşe Kara').closest('tr');
    const emre = within(roster).getByText('Emre Koç').closest('tr');
    if (!ayse || !emre) throw new Error('roster rows missing');

    expect(within(ayse).getByText('06:52')).toBeInTheDocument();
    expect(within(roster).queryByText(/^Out /)).not.toBeInTheDocument();
    expect(within(emre).getByText('—')).toBeInTheDocument();
    expect(within(emre).getByText('Absent')).toBeInTheDocument();
  });

  it('lists only the active sites without a primary responsible person', () => {
    renderPage();
    const sites = screen.getByRole('region', { name: 'Sites without a responsible person' });

    expect(within(sites).getByText('Bodrum')).toBeInTheDocument();
    expect(within(sites).getByText('No responsible person')).toBeInTheDocument();
    expect(within(sites).queryByText('Ayvalık')).not.toBeInTheDocument();
  });

  it('narrows the plan server-side by site and keeps the roster and leave list to that site', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Bodrum' }));

    expect(mocks.team).toHaveBeenLastCalledWith(WEEK_START, undefined, 's2');
    expect(screen.getByRole('button', { name: 'Bodrum' })).toHaveAttribute('aria-pressed', 'true');
    const roster = screen.getByRole('region', { name: 'On shift today' });
    expect(within(roster).getByText('Burak Şen')).toBeInTheDocument();
    expect(within(roster).queryByText('Ayşe Kara')).not.toBeInTheDocument();
    expect(kpi('Scheduled today')).toBe('1');
    // dailyAttendanceOverview takes no site, so the band says its counts are tenant-wide.
    expect(screen.getByText(/Attendance counts cover every site/)).toBeInTheDocument();
    const leave = screen.getByRole('region', { name: 'Open leave today' });
    expect(within(leave).queryByText('Zeynep Arslan')).not.toBeInTheDocument();
  });

  describe('farm sites by workspace', () => {
    it.each<[string, HrModuleCode | null]>([
      ['Production', 'FARM'],
      ['Company', null],
    ])('offers the site filter and the unassigned-sites panel in %s', (_label, workspace) => {
      renderPage(workspace);

      expect(screen.getByRole('button', { name: 'Bodrum' })).toBeInTheDocument();
      expect(
        screen.getByRole('region', { name: 'Sites without a responsible person' }),
      ).toBeInTheDocument();
    });

    it.each<[string, HrModuleCode]>([
      ['Greenhouse', 'HYDROPONICS'],
      ['Control & sensors', 'SENSOR'],
    ])('shows no farm sites in %s', (_label, workspace) => {
      renderPage(workspace);

      expect(screen.queryByRole('button', { name: 'Bodrum' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: 'Sites without a responsible person' }),
      ).not.toBeInTheDocument();
      expect(mocks.team).toHaveBeenLastCalledWith(WEEK_START, undefined, undefined);
    });

    it('drops a site picked in Production once the reader moves to a workspace without sites', () => {
      const { rerender } = renderPage('FARM');
      fireEvent.click(screen.getByRole('button', { name: 'Bodrum' }));
      expect(mocks.team).toHaveBeenLastCalledWith(WEEK_START, undefined, 's2');

      rerender(pageIn('HYDROPONICS'));

      expect(mocks.team).toHaveBeenLastCalledWith(WEEK_START, undefined, undefined);
      expect(screen.queryByRole('button', { name: 'Bodrum' })).not.toBeInTheDocument();
    });
  });

  it('says a panel failed instead of rendering it empty', () => {
    mocks.sites.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    renderPage();
    const sites = screen.getByRole('region', { name: 'Sites without a responsible person' });

    expect(within(sites).getByText('This panel could not be loaded.')).toBeInTheDocument();
  });
});
