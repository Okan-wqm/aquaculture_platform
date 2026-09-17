/**
 * Attention tones — one severity vocabulary for the two lists that answer
 * "what needs me right now?": alarms and tasks.
 *
 * WHY THIS FILE EXISTS. Those two lists are now rendered on TWO surfaces — the
 * phone's Today screen (src/pages/HomePage.tsx) and the board's attention pane
 * (src/pages/tablet/panes/AttentionPane.tsx) — from the same hooks, with the
 * same ListRow. The mapping from "how bad is this" to a row tone was a private
 * function inside HomePage. Copying it into the pane would have given the same
 * CRITICAL alarm one colour on the phone in a worker's hand and, after the next
 * edit to either copy, a different colour on the cabin wall two metres away.
 * Colour is the only thing that ranks these rows before a word is read, so a
 * drifting copy is not a cosmetic problem.
 *
 * Both maps are exhaustive `Record`s rather than if-chains on purpose: adding a
 * severity or a priority to the domain types is then a COMPILE error here
 * instead of a row that silently renders neutral grey — Tier 1, not Tier 4.
 */
import type { RowTone } from '@/components/ui';
import type { AlertSeverity } from '@/generated/graphql';
import type { TaskPriority } from '@/types';

/**
 * Alarm severity → row tone.
 *
 * CRITICAL and HIGH share the alarm tone, MEDIUM and WARNING share the watch
 * tone: v4 has exactly ONE alarm colour and one watch colour (see AlertsPage's
 * SEVERITY_STYLES for the same pairing on the acknowledge surface). The tiers
 * inside each pair are separated by the words in the row, never by hue alone.
 */
const ALERT_SEVERITY_TONE: Record<AlertSeverity, RowTone> = {
  CRITICAL: 'crit',
  HIGH: 'crit',
  MEDIUM: 'warn',
  WARNING: 'warn',
  LOW: 'neutral',
  INFO: 'neutral',
};

export function alertSeverityTone(severity: AlertSeverity): RowTone {
  return ALERT_SEVERITY_TONE[severity];
}

/**
 * Task priority → row tone.
 *
 * Priority only. A task's STATUS (overdue, in progress) is deliberately not
 * folded in here: it would make one function answer two questions, and the two
 * surfaces would then need to agree on which one wins. Status belongs in the
 * row's text, where it can say what it means.
 */
const TASK_PRIORITY_TONE: Record<TaskPriority, RowTone> = {
  URGENT: 'crit',
  HIGH: 'crit',
  MEDIUM: 'warn',
  LOW: 'neutral',
};

export function taskPriorityTone(priority: TaskPriority): RowTone {
  return TASK_PRIORITY_TONE[priority];
}
