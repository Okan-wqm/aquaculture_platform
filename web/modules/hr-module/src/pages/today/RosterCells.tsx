/**
 * Cells of the Today roster: who (name square, name, position · shift), when
 * (clock-in, lateness, clock-out) and what state.
 *
 * States use the design's shape-coded markers, so they read without colour:
 * a small square for "here", a diamond for late, a triangle for absent / not
 * clocked in, a dot for leave-type days, a hollow circle for a shift that has
 * not started. Warning ink only where something is wrong.
 */
import React from 'react';
import { Circle, Diamond, Square, Triangle } from 'lucide-react';
import { cn, useI18n, type MessageKey } from '@aquaculture/shared-ui';

import type { RosterRow, RosterState } from './todayRoster';
import { formatClock, initials } from './todayFormat';

type Tone = 'here' | 'late' | 'missing' | 'away' | 'pending';

const STATE_TONE: Record<RosterState, Tone> = {
  present: 'here',
  remote: 'here',
  offshore: 'here',
  halfDay: 'here',
  earlyLeave: 'here',
  late: 'late',
  absent: 'missing',
  notClockedIn: 'missing',
  onLeave: 'away',
  holiday: 'away',
  restDay: 'away',
  upcoming: 'pending',
};

const STATE_LABEL: Record<RosterState, MessageKey> = {
  present: 'hr.today.state.present',
  late: 'hr.today.state.late',
  absent: 'hr.today.state.absent',
  earlyLeave: 'hr.today.state.earlyLeave',
  halfDay: 'hr.today.state.halfDay',
  onLeave: 'hr.today.state.onLeave',
  holiday: 'hr.today.state.holiday',
  offshore: 'hr.today.state.offshore',
  restDay: 'hr.today.state.restDay',
  remote: 'hr.today.state.remote',
  notClockedIn: 'hr.today.state.notClockedIn',
  upcoming: 'hr.today.state.upcoming',
};

const TONE_INK: Record<Tone, string> = {
  here: 'text-gray-900 dark:text-gray-100',
  late: 'font-semibold text-warning-700 dark:text-warning-300',
  missing: 'font-semibold text-warning-700 dark:text-warning-300',
  away: 'text-gray-800 dark:text-gray-200',
  pending: 'text-gray-700 dark:text-gray-300',
};

function ToneMarker({ tone }: { tone: Tone }): React.JSX.Element {
  switch (tone) {
    case 'here':
      return <Square className="h-3 w-3 shrink-0 fill-current text-gray-500" aria-hidden="true" />;
    case 'late':
      return <Diamond className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden="true" />;
    case 'missing':
      return <Triangle className="h-3 w-3 shrink-0 fill-current" aria-hidden="true" />;
    case 'away':
      return <Circle className="h-2 w-2 shrink-0 fill-current text-gray-500" aria-hidden="true" />;
    case 'pending':
      return <Circle className="h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />;
  }
}

export function EmployeeCell({ row }: { row: RosterRow }): React.JSX.Element {
  const { t } = useI18n();
  const times =
    row.shiftStart !== undefined && row.shiftEnd !== undefined
      ? `${row.shiftStart}–${row.shiftEnd}`
      : undefined;
  const shift = [row.shiftLabel, times].filter((part) => part !== undefined).join(' ');
  // TODO(data): the design's sub-line is "title · site · shift"; the site is left out because
  // teamWeeklyOverview's EmployeeWeekSummary carries no site — needs Employee.farmId (and the
  // site name) on hr-service's EmployeeWeekSummary.
  const detail = [row.position, shift === '' ? t('hr.today.roster.unplanned') : shift]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');

  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="grid h-10 w-10 shrink-0 place-items-center border border-gray-200 text-sm font-semibold tabular-nums text-primary-800 dark:border-gray-700 dark:text-primary-200"
      >
        {initials(row.name)}
      </span>
      <div className="min-w-0">
        <div className="whitespace-nowrap font-semibold text-gray-900 dark:text-gray-100">
          {row.name}
        </div>
        <div className="text-sm text-gray-700 dark:text-gray-300">{detail}</div>
      </div>
    </div>
  );
}

export function ClockInCell({ row }: { row: RosterRow }): React.JSX.Element {
  const { t, locale } = useI18n();
  return (
    <div>
      <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
        {row.clockIn === undefined ? '—' : formatClock(row.clockIn, locale)}
      </div>
      {row.lateMinutes > 0 && (
        <div className="text-sm text-warning-700 dark:text-warning-300">
          {t('hr.today.roster.lateBy', { minutes: row.lateMinutes })}
        </div>
      )}
      {row.clockOut !== undefined && (
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {t('hr.today.roster.clockedOut', { time: formatClock(row.clockOut, locale) })}
        </div>
      )}
    </div>
  );
}

export function StateCell({ row }: { row: RosterRow }): React.JSX.Element {
  const { t } = useI18n();
  const tone = STATE_TONE[row.state];
  return (
    <div>
      <span className={cn('inline-flex items-center gap-2', TONE_INK[tone])}>
        <ToneMarker tone={tone} />
        <span>{t(STATE_LABEL[row.state])}</span>
      </span>
      {row.state === 'upcoming' && row.shiftStart !== undefined && (
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {t('hr.today.roster.startsAt', { time: row.shiftStart })}
        </div>
      )}
    </div>
  );
}
