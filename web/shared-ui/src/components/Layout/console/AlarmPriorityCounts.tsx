/**
 * AlarmPriorityCounts — a workspace's active alarms as ISA-101 glyph + count
 * pairs (design handoff §7.3: P1 ■ red, P2 ▲ amber, P3 ◇ amber).
 *
 * WHAT: one pair per priority that has alarms, most urgent first; nothing at
 * all without alarms. The glyph is the annunciator's (one drawing of the
 * priority marks for the whole console) at its inline size, the menu's
 * `glyph(p, 12)`; the count is set in the display face. Each pair is announced
 * in words — "1 critical (P1) alarm", "2 … alarms" — the shape and the bare
 * number being visual.
 *
 * WHY presentational: the workspace menu shows per-module counts, which no
 * backend serves yet (ALERT-MEDIUM-010) — the shell feeds this component from
 * its preview path, and from the real alarm summary once that finding lands.
 */
import type { ReactElement } from 'react';

import { useI18n, type MessageKey } from '../../../i18n';

import { AnnunciatorGlyph } from './AnnunciatorGlyph';
import { ALARM_PRIORITIES, type AlarmPriority } from './AnnunciatorPriority';

/** Active-alarm counts per priority. */
export type AlarmPriorityTally = Readonly<Record<AlarmPriority, number>>;

export interface AlarmPriorityCountsProps {
  readonly counts: AlarmPriorityTally;
}

/** The spoken pair per priority, singular for one alarm (as RailDeviceBand picks `.one`/`.other`). */
const SPOKEN: Readonly<Record<AlarmPriority, Readonly<Record<'one' | 'other', MessageKey>>>> = {
  p1: { one: 'console.rail.alarms.p1.one', other: 'console.rail.alarms.p1.other' },
  p2: { one: 'console.rail.alarms.p2.one', other: 'console.rail.alarms.p2.other' },
  p3: { one: 'console.rail.alarms.p3.one', other: 'console.rail.alarms.p3.other' },
};

export function AlarmPriorityCounts({ counts }: AlarmPriorityCountsProps): ReactElement | null {
  const { t } = useI18n();
  const lit = ALARM_PRIORITIES.filter((priority) => counts[priority] > 0);
  if (lit.length === 0) return null;

  return (
    <span className="flex items-center gap-2.5">
      {lit.map((priority) => (
        <span
          key={priority}
          data-priority={priority}
          className="inline-flex items-center gap-[5px] font-display-sd text-base font-semibold leading-none text-sd-ink tabular-nums"
        >
          <AnnunciatorGlyph priority={priority} tone="hazard" size="inline" />
          <span aria-hidden="true">{counts[priority]}</span>
          <span className="sr-only">
            {t(SPOKEN[priority][counts[priority] === 1 ? 'one' : 'other'], {
              count: counts[priority],
            })}
          </span>
        </span>
      ))}
    </span>
  );
}
