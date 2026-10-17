/**
 * Severity of a figure against its plan — the one threshold rule the finance
 * console flags with (budget forecast vs budget, unit cost vs target).
 *
 * WHY one rule: the design (Tenant Console D6) colours a row only when it is
 * abnormal, and both finance tables use the same two steps; two spellings of
 * the threshold would let the tables disagree about the same overrun.
 */
import type { MessageKey } from '@aquaculture/shared-ui';

/** `warn`: over the plan by up to 10 %; `alarm`: more than 10 % over. */
export type Severity = 'ok' | 'warn' | 'alarm';

/** Severity of `ratio` = actual (or forecast) / plan. */
export function severityOf(ratio: number): Severity {
  if (ratio > 1.1) return 'alarm';
  if (ratio > 1) return 'warn';
  return 'ok';
}

/** The words a flagged figure carries for readers who cannot see its glyph or ink. */
export const SEVERITY_LABEL_KEY: Record<Exclude<Severity, 'ok'>, MessageKey> = {
  warn: 'finance.severity.warn',
  alarm: 'finance.severity.alarm',
};
