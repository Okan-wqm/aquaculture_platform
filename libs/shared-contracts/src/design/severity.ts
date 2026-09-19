/**
 * The product's severity ladder, and the colour each step is painted with
 * (FE-HIGH-085, FE-MEDIUM-093).
 *
 * WHY one definition: the ladder appears on every surface a customer or an
 * operator looks at — the alert list, the incident mail, the SCADA alarm
 * banner, the risk pill on a VFD page, the escalation report — and each of
 * them had picked its own colours. alert-engine classified CRITICAL as
 * `#dc2626` and HIGH as `#ea580c`; the SCADA runtime used the same red but a
 * different orange; the web `SeverityBadge` had already moved HIGH onto the
 * coral accent, so a HIGH incident was orange in the mail and coral in the
 * application it linked to.
 *
 * The ladder has six steps and four hues: red for critical, the coral accent
 * for high, amber for medium and warning, blue for low, grey for
 * informational. Anything that needs a fifth is not a severity.
 */
import { colors } from './color-tokens';

/** The six steps, lower-case, as every service spells them on the wire. */
export type SeverityLevel = 'critical' | 'high' | 'medium' | 'warning' | 'low' | 'info';

/** The tone each step takes, for the e-mail layout's header band and buttons. */
export const SEVERITY_TONE = {
  critical: 'error',
  high: 'accent',
  medium: 'warning',
  warning: 'warning',
  low: 'info',
  info: 'neutral',
} as const satisfies Readonly<Record<SeverityLevel, string>>;

const SEVERITY_COLOR: Readonly<Record<SeverityLevel, string>> = {
  critical: colors.error[600],
  high: colors.accent[600],
  medium: colors.warning[600],
  warning: colors.warning[500],
  low: colors.info[600],
  info: colors.neutral[700],
};

/** The colour a step is painted with, for a chart, a badge or a report. */
export function severityColor(level: SeverityLevel): string {
  return SEVERITY_COLOR[level];
}
