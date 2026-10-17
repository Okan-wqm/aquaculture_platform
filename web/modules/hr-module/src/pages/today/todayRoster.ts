/**
 * The Today page's roster: today's plan joined with today's attendance.
 *
 * WHY a join and not one query: hr-service answers "who is planned on which
 * shift" (teamWeeklyOverview, narrowed by site on the server) and "who clocked
 * in, how late, in which state" (todaysAttendance) separately, and nothing
 * returns the two together. The join is keyed by employee id.
 *
 * WHAT each row says:
 *   - a person with an attendance record → the record's state, clock-in,
 *     clock-out and late minutes (the record is the fact; the plan is intent);
 *   - planned to work (WORK / TRAINING) with no record → `upcoming` until the
 *     shift's start, `notClockedIn` after it;
 *   - planned leave with no record → `onLeave`;
 *   - off, holiday or no plan entry with no record → not listed (not on duty);
 *   - a record for someone outside the plan → listed only when no site filter
 *     narrows the plan, since the record carries no site to filter it by.
 */
import { AttendanceStatus, type AttendanceRecord } from '../../types';
import type {
  DayEntry,
  EmployeeWeekSummary,
  WeeklyPlanEntryType,
} from '../../types/scheduling.types';

export type RosterState =
  | 'present'
  | 'late'
  | 'absent'
  | 'earlyLeave'
  | 'halfDay'
  | 'onLeave'
  | 'holiday'
  | 'offshore'
  | 'restDay'
  | 'remote'
  | 'notClockedIn'
  | 'upcoming';

export interface RosterRow {
  employeeId: string;
  name: string;
  position?: string;
  /** The planned shift's name, else its code; absent when nothing is planned. */
  shiftLabel?: string;
  /** Planned start / end as local `HH:mm`. */
  shiftStart?: string;
  shiftEnd?: string;
  /** Clock-in / clock-out timestamps from the attendance record. */
  clockIn?: string;
  clockOut?: string;
  lateMinutes: number;
  state: RosterState;
  /** The design's amber left bar: someone expected is late or not here. */
  flagged: boolean;
}

export interface TodayRosterInput {
  plans: readonly EmployeeWeekSummary[];
  records: readonly AttendanceRecord[];
  /** Local calendar date, `YYYY-MM-DD`. */
  today: string;
  now: Date;
  /** False while a site filter narrows `plans`: unplanned records cannot be site-filtered. */
  includeUnplanned: boolean;
}

/** Every contract attendance status, as the roster's state vocabulary. */
const RECORD_STATE: Record<AttendanceStatus, RosterState> = {
  [AttendanceStatus.PRESENT]: 'present',
  [AttendanceStatus.ABSENT]: 'absent',
  [AttendanceStatus.LATE]: 'late',
  [AttendanceStatus.EARLY_LEAVE]: 'earlyLeave',
  [AttendanceStatus.HALF_DAY]: 'halfDay',
  [AttendanceStatus.ON_LEAVE]: 'onLeave',
  [AttendanceStatus.HOLIDAY]: 'holiday',
  [AttendanceStatus.OFFSHORE]: 'offshore',
  [AttendanceStatus.REST_DAY]: 'restDay',
  [AttendanceStatus.WORK_FROM_HOME]: 'remote',
};

const FLAGGED_STATES: ReadonlySet<RosterState> = new Set(['late', 'absent', 'notClockedIn']);

/** Plan entries that put a person on duty — the same pair teamWeeklyOverview counts as working. */
const ON_DUTY_ENTRIES: ReadonlySet<WeeklyPlanEntryType> = new Set(['WORK', 'TRAINING']);

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * A plan time as local `HH:mm`. teamWeeklyOverview sends either the shift's
 * clock time (`07:00:00`) or, for an entry with a planned override, a full
 * timestamp — both are read here. An OFF filler day or a LEAVE entry carries
 * no shift, and graphql-js sends that absent time as `null`.
 */
export function shiftClock(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (!value.includes('T')) return value.slice(0, 5);
  const at = new Date(value);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function shiftStartsAt(entry: DayEntry, today: string): Date | undefined {
  const start = entry.startTime;
  if (start == null) return undefined;
  return start.includes('T') ? new Date(start) : new Date(`${today}T${start.slice(0, 5)}:00`);
}

function plannedState(entry: DayEntry, today: string, now: Date): RosterState | undefined {
  if (entry.entryType === 'LEAVE') return 'onLeave';
  if (!ON_DUTY_ENTRIES.has(entry.entryType)) return undefined;
  const startsAt = shiftStartsAt(entry, today);
  return startsAt !== undefined && now < startsAt ? 'upcoming' : 'notClockedIn';
}

function recordName(record: AttendanceRecord): string {
  return record.employee
    ? `${record.employee.firstName} ${record.employee.lastName}`
    : record.employeeId;
}

/**
 * One roster row. WHY the `?? undefined`: the wire marks an absent shift name,
 * clock-in or clock-out as `null`; the row has one "absent" (undefined), so a
 * missing clock-out is never formatted (`new Date(null)` is the 1970 epoch).
 */
function row(
  base: Pick<RosterRow, 'employeeId' | 'name' | 'position'>,
  entry: DayEntry | undefined,
  record: AttendanceRecord | undefined,
  state: RosterState,
): RosterRow {
  return {
    ...base,
    shiftLabel: entry?.shiftName ?? entry?.shiftCode ?? undefined,
    shiftStart: shiftClock(entry?.startTime),
    shiftEnd: shiftClock(entry?.endTime),
    clockIn: record?.clockIn ?? undefined,
    clockOut: record?.clockOut ?? undefined,
    lateMinutes: record?.lateMinutes ?? 0,
    state,
    flagged: FLAGGED_STATES.has(state),
  };
}

export function buildTodayRoster({
  plans,
  records,
  today,
  now,
  includeUnplanned,
}: TodayRosterInput): RosterRow[] {
  const recordByEmployee = new Map(records.map((record) => [record.employeeId, record]));
  const rows: RosterRow[] = [];

  for (const plan of plans) {
    const entry = plan.days.find((day) => day.date === today);
    const record = recordByEmployee.get(plan.employeeId);
    const state = record
      ? RECORD_STATE[record.status]
      : entry === undefined
        ? undefined
        : plannedState(entry, today, now);
    if (state === undefined) continue;
    rows.push(
      row(
        {
          employeeId: plan.employeeId,
          name: plan.employeeName,
          position: plan.position ?? undefined,
        },
        entry,
        record,
        state,
      ),
    );
  }

  if (includeUnplanned) {
    const planned = new Set(plans.map((plan) => plan.employeeId));
    for (const record of records) {
      if (planned.has(record.employeeId)) continue;
      rows.push(
        row(
          // The attendance fragment's employee carries no position (EmployeeBasic).
          { employeeId: record.employeeId, name: recordName(record) },
          undefined,
          record,
          RECORD_STATE[record.status],
        ),
      );
    }
  }

  return rows;
}
