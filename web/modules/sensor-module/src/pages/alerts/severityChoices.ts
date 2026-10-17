/**
 * Severity choices — the options of the alarm list's severity filter.
 *
 * WHY a choice is a SET of severities: an annunciator tile filters by
 * priority, and P3 spans two alert-engine severities (MEDIUM and WARNING,
 * shared-ui severitiesOf), while UNACK spans every priority — the P1–P3
 * severities, advisories (LOW, INFO) left out (shared-ui ALARM_SEVERITIES).
 * The list keeps every single severity selectable and adds the two groups
 * beside them, so the filter a tile lands on is one the user can also pick,
 * see and leave. alert-engine filters the history by the set
 * (`alertHistory(severities:)`), so a page of the list is a page of exactly
 * those alarms.
 *
 * WHAT: the choices in display order, their severity sets, and the lookups
 * between a choice and a set.
 */
import { ALARM_SEVERITIES, severitiesOf } from '@aquaculture/shared-ui';
import type { AlertSeverity } from '@platform/shared-ui/generated/graphql-types';

export type SeverityChoiceValue = 'all' | 'alarms' | 'p3' | AlertSeverity;

export interface SeverityChoice {
  readonly value: SeverityChoiceValue;
  /** The severities the list shows under this choice; empty for every severity. */
  readonly severities: readonly AlertSeverity[];
}

/**
 * Each choice's set. A Record over the choice values, so a severity added to
 * the supergraph's AlertSeverity fails the build until it has a choice.
 */
const SEVERITIES_OF: Readonly<Record<SeverityChoiceValue, readonly AlertSeverity[]>> = {
  all: [],
  alarms: ALARM_SEVERITIES,
  CRITICAL: ['CRITICAL'],
  HIGH: ['HIGH'],
  p3: severitiesOf('p3'),
  WARNING: ['WARNING'],
  MEDIUM: ['MEDIUM'],
  LOW: ['LOW'],
  INFO: ['INFO'],
};

/**
 * Display order: every severity, then the P1–P3 group (UNACK's) beside it,
 * the P3 group right after the two priorities above it.
 */
const ORDER: readonly SeverityChoiceValue[] = [
  'all',
  'alarms',
  'CRITICAL',
  'HIGH',
  'p3',
  'WARNING',
  'MEDIUM',
  'LOW',
  'INFO',
];

export const SEVERITY_CHOICES: readonly SeverityChoice[] = ORDER.map((value) => ({
  value,
  severities: SEVERITIES_OF[value],
}));

/** Two severity sets hold the same severities, in any order. */
export function sameSeverities(a: readonly AlertSeverity[], b: readonly AlertSeverity[]): boolean {
  return (
    a.length === b.length &&
    a.every((severity) => b.includes(severity)) &&
    b.every((severity) => a.includes(severity))
  );
}

/** The choice an option value of the filter's select names, if it names one. */
export function choiceByValue(value: string): SeverityChoice | undefined {
  return SEVERITY_CHOICES.find((choice) => choice.value === value);
}

export function severitiesOfChoice(value: SeverityChoiceValue): readonly AlertSeverity[] {
  return SEVERITIES_OF[value];
}

/**
 * The choice showing exactly these severities. The list's severities only
 * ever come from a choice or from a tile's priority, and every priority's set
 * is a choice (alertPriorityFilter.test.ts pins it), so 'all' is reached by
 * the empty set alone.
 */
export function severityChoiceOf(severities: readonly AlertSeverity[]): SeverityChoiceValue {
  return (
    SEVERITY_CHOICES.find((choice) => sameSeverities(choice.severities, severities))?.value ?? 'all'
  );
}
