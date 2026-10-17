/**
 * todayRoster — who the Today page lists, and what it says about each person.
 *
 * The roster joins two real reads: the team's weekly plan (who is scheduled
 * for which shift today) and today's attendance records (who clocked in, how
 * late, in which state). These tests pin the join: a record always wins, a
 * scheduled person with no record is "upcoming" before the shift starts and
 * "not clocked in" after it, an off day is not listed, and a clock-in by
 * someone outside the plan still shows when no site filter narrows the list.
 *
 * Fixtures use the wire shape: graphql-js sends every absent nullable field
 * (an OFF filler day's shift and times, a LEAVE entry's shift, a record's
 * clock-out while the person is still on shift) as `null`, never undefined.
 */
import { describe, expect, it } from 'vitest';

import {
  AttendanceStatus,
  EmployeeStatus,
  EmploymentType,
  type AttendanceRecord,
  type Employee,
} from '../../../types';
import type { DayEntry, EmployeeWeekSummary } from '../../../types/scheduling.types';
import { buildTodayRoster, shiftClock } from '../todayRoster';

const TODAY = '2026-10-16';

function entry(overrides: Partial<DayEntry>): DayEntry {
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
    days: [entry({ date: '2026-10-15', dayOfWeek: 'THURSDAY' }), today],
    totalWorkDays: 2,
    totalMinutes: 960,
    overtimeMinutes: 0,
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

const NOW = new Date('2026-10-16T10:00:00');

/** A planned leave day: no shift, so no code, name or times. */
const NO_SHIFT_LEAVE: Partial<DayEntry> = {
  entryType: 'LEAVE',
  shiftCode: null,
  shiftName: null,
  startTime: null,
  endTime: null,
  plannedMinutes: 0,
};

/** What teamWeeklyOverview sends for a day with no plan entry: OFF, nothing else. */
const OFF_FILLER: Partial<DayEntry> = { ...NO_SHIFT_LEAVE, entryType: 'OFF' };

describe('buildTodayRoster', () => {
  it('takes the state, clock-in and late minutes from the attendance record', () => {
    const rows = buildTodayRoster({
      plans: [plan('e1', 'Ayşe Kara', entry({})), plan('e2', 'Emre Koç', entry({}))],
      records: [
        record('e1', AttendanceStatus.PRESENT),
        record('e2', AttendanceStatus.LATE, { clockIn: '2026-10-16T07:38:00', lateMinutes: 38 }),
      ],
      today: TODAY,
      now: NOW,
      includeUnplanned: true,
    });

    expect(rows.map((row) => [row.name, row.state, row.flagged, row.lateMinutes])).toEqual([
      ['Ayşe Kara', 'present', false, 0],
      ['Emre Koç', 'late', true, 38],
    ]);
    expect(rows[1]?.clockIn).toBe('2026-10-16T07:38:00');
    expect(rows[0]?.shiftLabel).toBe('Day');
    expect(rows[0]?.shiftStart).toBe('07:00');
    expect(rows[0]?.shiftEnd).toBe('15:00');
  });

  it('marks a scheduled person with no record as upcoming before the shift and not clocked in after it', () => {
    const rows = buildTodayRoster({
      plans: [
        plan(
          'night',
          'Can Öztürk',
          entry({ shiftName: 'Night', startTime: '22:00:00', endTime: '06:00:00' }),
        ),
        plan('day', 'Burak Şen', entry({})),
      ],
      records: [],
      today: TODAY,
      now: NOW,
      includeUnplanned: true,
    });

    expect(rows.map((row) => [row.employeeId, row.state, row.flagged])).toEqual([
      ['night', 'upcoming', false],
      ['day', 'notClockedIn', true],
    ]);
  });

  it('reads a planned start given as a timestamp as well as a shift clock time', () => {
    const rows = buildTodayRoster({
      plans: [
        plan(
          'e1',
          'Ayşe Kara',
          entry({ startTime: '2026-10-16T12:30:00', endTime: '2026-10-16T20:30:00' }),
        ),
      ],
      records: [],
      today: TODAY,
      now: NOW,
      includeUnplanned: true,
    });

    expect(rows[0]?.state).toBe('upcoming');
    expect(rows[0]?.shiftStart).toBe('12:30');
  });

  it('lists a planned leave day as on leave and leaves off days out', () => {
    const rows = buildTodayRoster({
      plans: [
        plan('leave', 'Zeynep Arslan', entry(NO_SHIFT_LEAVE)),
        plan('off', 'Tolga Er', entry(OFF_FILLER)),
        plan('holiday', 'Gizem Uçar', entry({ ...NO_SHIFT_LEAVE, entryType: 'HOLIDAY' })),
      ],
      records: [],
      today: TODAY,
      now: NOW,
      includeUnplanned: true,
    });

    expect(rows.map((row) => [row.employeeId, row.state, row.shiftLabel, row.shiftStart])).toEqual([
      ['leave', 'onLeave', undefined, undefined],
    ]);
  });

  it('lists a clock-in on a day with no planned shift (the OFF filler teamWeeklyOverview sends)', () => {
    const rows = buildTodayRoster({
      plans: [plan('e1', 'Ayşe Kara', entry(OFF_FILLER))],
      records: [record('e1', AttendanceStatus.PRESENT)],
      today: TODAY,
      now: NOW,
      includeUnplanned: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'present', clockIn: '2026-10-16T06:52:00' });
    expect(rows[0]?.shiftLabel).toBeUndefined();
    expect(rows[0]?.shiftStart).toBeUndefined();
    expect(rows[0]?.shiftEnd).toBeUndefined();
  });

  it('reads a null clock-in, clock-out and position as absent, never as a time', () => {
    const rows = buildTodayRoster({
      plans: [
        { ...plan('here', 'Ayşe Kara', entry({})), position: null },
        plan('gone', 'Emre Koç', entry({})),
      ],
      records: [
        record('here', AttendanceStatus.PRESENT, { clockOut: null }),
        record('gone', AttendanceStatus.ABSENT, { clockIn: null, clockOut: null }),
      ],
      today: TODAY,
      now: NOW,
      includeUnplanned: true,
    });

    expect(rows.map((row) => [row.employeeId, row.clockIn, row.clockOut, row.position])).toEqual([
      ['here', '2026-10-16T06:52:00', undefined, undefined],
      ['gone', undefined, undefined, 'Technician'],
    ]);
  });

  it('keeps a clock-in from outside the plan only when no site filter narrows the roster', () => {
    const employee: Employee = {
      id: 'x',
      tenantId: 'tenant-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      isDeleted: false,
      employeeNumber: 'E-9',
      firstName: 'Nur',
      lastName: 'Çelik',
      email: 'nur@example.test',
      status: EmployeeStatus.ACTIVE,
      employmentType: EmploymentType.FULL_TIME,
      hireDate: '2025-01-01',
      seaWorthy: false,
    };
    const outsider = record('x', AttendanceStatus.PRESENT, { employee });

    const all = buildTodayRoster({
      plans: [],
      records: [outsider],
      today: TODAY,
      now: NOW,
      includeUnplanned: true,
    });
    const site = buildTodayRoster({
      plans: [],
      records: [outsider],
      today: TODAY,
      now: NOW,
      includeUnplanned: false,
    });

    expect(all.map((row) => [row.name, row.state, row.shiftLabel])).toEqual([
      ['Nur Çelik', 'present', undefined],
    ]);
    expect(site).toEqual([]);
  });
});

describe('shiftClock', () => {
  it('trims a shift clock time to hours and minutes', () => {
    expect(shiftClock('07:00:00')).toBe('07:00');
  });

  it('answers nothing for a missing time, sent as null on the wire', () => {
    expect(shiftClock(null)).toBeUndefined();
    expect(shiftClock(undefined)).toBeUndefined();
  });
});
