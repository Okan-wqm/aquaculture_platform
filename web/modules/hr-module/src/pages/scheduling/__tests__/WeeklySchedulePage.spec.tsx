/**
 * WeeklySchedulePage — the roster reads and writes the scheduling API.
 *
 * HR-HIGH-010: "Kaydet" wrote the roster to localStorage and nothing reached
 * the API. These tests pin the replacement: the cells come from the team
 * weekly overview (one query per visible week), a choice in a cell calls the
 * assignment mutation with the employee's plan — or none, so the API creates
 * one — published weeks and leave days take no assignment, publishing goes
 * through the confirm gate, and browser storage is never written.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Shift } from '../../../types/attendance.types';
import type {
  DayEntry,
  EmployeeWeekSummary,
  TeamWeeklyOverview,
  WeekDay,
} from '../../../types/scheduling.types';
import { WeeklySchedulePage } from '../WeeklySchedulePage';

const WEEKDAYS: readonly WeekDay[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

type DayPattern = 'S' | 'A' | 'off' | 'leave';

/** A day of the week of 2026-09-14, as the overview query returns it. */
function entryOn(weekday: WeekDay, index: number, pattern: DayPattern): DayEntry {
  const date = `2026-09-${String(14 + index).padStart(2, '0')}`;
  if (pattern === 'off' || pattern === 'leave') {
    return { dayOfWeek: weekday, date, entryType: pattern, plannedMinutes: 0 };
  }
  return {
    dayOfWeek: weekday,
    date,
    entryType: 'work',
    shiftCode: pattern,
    shiftName: pattern === 'S' ? 'Sabah' : 'Akşam',
    startTime: pattern === 'S' ? '08:00:00' : '16:00:00',
    endTime: pattern === 'S' ? '16:00:00' : '00:00:00',
    plannedMinutes: 480,
  };
}

function week(pattern: readonly DayPattern[]): DayEntry[] {
  return WEEKDAYS.map((weekday, index) => entryOn(weekday, index, pattern[index] ?? 'off'));
}

function overviewFor(weekStartDate: string): TeamWeeklyOverview {
  const employeePlans: EmployeeWeekSummary[] = [
    {
      employeeId: 'e-ayse',
      employeeName: 'Ayşe Yılmaz',
      position: 'Teknisyen',
      weeklyPlanId: 'plan-ayse',
      planStatus: 'draft',
      days: week(['S', 'S', 'S', 'S', 'S', 'off', 'off']),
      totalWorkDays: 5,
      totalMinutes: 2400,
      overtimeMinutes: 0,
    },
    {
      employeeId: 'e-mehmet',
      employeeName: 'Mehmet Kaya',
      position: 'Vardiya Amiri',
      weeklyPlanId: 'plan-mehmet',
      planStatus: 'published',
      days: week(['A', 'A', 'A', 'A', 'A', 'off', 'off']),
      totalWorkDays: 5,
      totalMinutes: 2400,
      overtimeMinutes: 0,
    },
    {
      // No plan for the week: the API reports seven off days and no plan id.
      employeeId: 'e-fatma',
      employeeName: 'Fatma Demir',
      days: week(['off', 'off', 'off', 'off', 'off', 'off', 'off']),
      totalWorkDays: 0,
      totalMinutes: 0,
      overtimeMinutes: 0,
    },
    {
      employeeId: 'e-ali',
      employeeName: 'Ali Çelik',
      position: 'Bakımcı',
      weeklyPlanId: 'plan-ali',
      planStatus: 'draft',
      days: week(['S', 'S', 'leave', 'S', 'S', 'off', 'off']),
      totalWorkDays: 4,
      totalMinutes: 1920,
      overtimeMinutes: 0,
    },
  ];
  return {
    weekStartDate,
    weekEndDate: '2026-09-20',
    totalEmployees: employeePlans.length,
    employeePlans,
    daysSummary: [],
  };
}

const mocks = vi.hoisted(() => ({
  overviews: vi.fn(),
  assignMutate: vi.fn(),
  publishMutate: vi.fn(),
  confirm: vi.fn<(options: unknown) => Promise<boolean>>(),
}));

const SHIFTS: Shift[] = [
  {
    id: 'shift-s',
    tenantId: 't-1',
    code: 'S',
    name: 'Sabah',
    startTime: '08:00:00',
    endTime: '16:00:00',
    graceMinutes: 15,
    breakPeriods: [],
    workDays: [],
    isNightShift: false,
    isOffshoreShift: false,
    colorCode: '#0ea5e9',
    isActive: true,
    isDeleted: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'shift-a',
    tenantId: 't-1',
    code: 'A',
    name: 'Akşam',
    startTime: '16:00:00',
    endTime: '00:00:00',
    graceMinutes: 15,
    breakPeriods: [],
    workDays: [],
    isNightShift: true,
    isOffshoreShift: false,
    colorCode: '#6366f1',
    isActive: true,
    isDeleted: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

vi.mock('../../../hooks/useScheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useScheduling')>();
  return {
    ...actual,
    useTeamWeeklyOverviews: mocks.overviews,
    useAssignScheduleCell: () => ({
      mutate: mocks.assignMutate,
      isPending: false,
      variables: undefined,
    }),
    usePublishWeekPlans: () => ({ mutate: mocks.publishMutate, isPending: false }),
  };
});

vi.mock('../../../hooks/useAttendance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAttendance')>();
  return { ...actual, useShifts: () => ({ data: SHIFTS, isPending: false }) };
});

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return { ...actual, useConfirm: () => mocks.confirm };
});

function renderPage(): void {
  render(
    <MemoryRouter>
      <WeeklySchedulePage />
    </MemoryRouter>,
  );
}

function rowOf(employeeName: string): HTMLElement {
  const row = screen.getByText(employeeName).closest('tr');
  if (row === null) throw new Error(`No roster row for ${employeeName}`);
  return row;
}

function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`No item at ${index}`);
  return item;
}

describe('WeeklySchedulePage', () => {
  let setItem: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 16, 10, 0, 0)); // Wednesday → the week of Monday 2026-09-14
    mocks.overviews.mockImplementation((weekStarts: readonly string[]) =>
      weekStarts.map((weekStartDate) => ({
        data: overviewFor(weekStartDate),
        isError: false,
        error: null,
        refetch: vi.fn(),
      })),
    );
    mocks.assignMutate.mockReset();
    mocks.publishMutate.mockReset();
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
    setItem = vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the week from the team overview: shift codes, off days, leave and unplanned cells', () => {
    renderPage();

    expect(mocks.overviews).toHaveBeenLastCalledWith(['2026-09-14']);
    const ayse = rowOf('Ayşe Yılmaz');
    expect(within(ayse).getAllByText('S')).toHaveLength(5);
    expect(within(ayse).getAllByText('Tatil')).toHaveLength(2);
    expect(within(rowOf('Ali Çelik')).getByText('İzin')).toBeInTheDocument();
    expect(within(rowOf('Fatma Demir')).queryByText('Tatil')).toBeNull();
    expect(within(rowOf('Mehmet Kaya')).getByText('Yayınlandı')).toBeInTheDocument();
  });

  it('assigns a shift to a cell through the API with the employee’s plan', () => {
    renderPage();

    fireEvent.click(nth(within(rowOf('Ayşe Yılmaz')).getAllByRole('button'), 2));
    fireEvent.click(screen.getByRole('menuitem', { name: /Akşam/ }));

    expect(mocks.assignMutate).toHaveBeenCalledWith({
      employeeId: 'e-ayse',
      weekStartDate: '2026-09-14',
      weeklyPlanId: 'plan-ayse',
      date: '2026-09-16',
      shiftId: 'shift-a',
    });
  });

  it('asks the API to create the plan first for an employee without one', () => {
    renderPage();

    fireEvent.click(nth(within(rowOf('Fatma Demir')).getAllByRole('button'), 0));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sabah/ }));

    expect(mocks.assignMutate).toHaveBeenCalledWith({
      employeeId: 'e-fatma',
      weekStartDate: '2026-09-14',
      weeklyPlanId: undefined,
      date: '2026-09-14',
      shiftId: 'shift-s',
    });
  });

  it('marks an off day with a null shift', () => {
    renderPage();

    fireEvent.click(nth(within(rowOf('Ayşe Yılmaz')).getAllByRole('button'), 0));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tatil' }));

    expect(mocks.assignMutate).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e-ayse', date: '2026-09-14', shiftId: null }),
    );
  });

  it('takes no assignment on a published week or a leave day', () => {
    renderPage();

    expect(within(rowOf('Mehmet Kaya')).queryAllByRole('button')).toHaveLength(0);
    expect(within(rowOf('Ali Çelik')).getAllByRole('button')).toHaveLength(6);
  });

  it('publishes the week’s draft plans behind the confirm gate', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Haftayı Yayınla \(2\)/ }));

    await vi.waitFor(() =>
      expect(mocks.publishMutate).toHaveBeenCalledWith({
        weekStartDate: '2026-09-14',
        planIds: ['plan-ayse', 'plan-ali'],
      }),
    );
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing when the confirm gate is refused', async () => {
    mocks.confirm.mockResolvedValue(false);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Haftayı Yayınla \(2\)/ }));

    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.publishMutate).not.toHaveBeenCalled();
  });

  it('reads the month as one overview per week', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Aylık' }));

    expect(mocks.overviews).toHaveBeenLastCalledWith([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
  });

  it('writes nothing to browser storage and offers no local save', () => {
    renderPage();

    expect(screen.queryByRole('button', { name: 'Kaydet' })).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });
});
