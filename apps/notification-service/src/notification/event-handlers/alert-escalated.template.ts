import type { AlertEscalatedEvent, AlertSeverityLevel } from '@platform/event-contracts';

/**
 * Deterministic wording of an escalated alarm (ALERT-CRITICAL-004).
 *
 * WHY deterministic: this text lands on a lock screen and in an inbox at the
 * moment a tank may be losing oxygen. It is built only from the incident's own
 * title/description/severity — never from free-form or generated text — so
 * what a person reads is exactly what the alert engine recorded.
 */

const SEVERITY_LABEL: Record<AlertSeverityLevel, string> = {
  critical: 'KRİTİK',
  high: 'YÜKSEK',
  medium: 'ORTA',
  warning: 'UYARI',
  low: 'DÜŞÜK',
  info: 'BİLGİ',
};

/** Subject lines become SMTP headers and push titles — one line, bounded. */
const MAX_SUBJECT_LENGTH = 200;

export interface RenderedAlarm {
  subject: string;
  message: string;
  pushData: Record<string, string | number | boolean | null>;
}

export function renderAlertEscalated(event: AlertEscalatedEvent, userId: string): RenderedAlarm {
  const oneLineTitle = event.title.replace(/[\r\n]+/g, ' ').trim();
  const subject = `[${SEVERITY_LABEL[event.severity]}] ${oneLineTitle}`.slice(
    0,
    MAX_SUBJECT_LENGTH,
  );
  return {
    subject,
    message: event.description.length > 0 ? event.description : oneLineTitle,
    pushData: {
      type: 'ALERT_ESCALATED',
      alertId: event.alertId,
      severity: event.severity,
      escalationLevel: event.escalationLevel,
      // MT-HIGH-050: the intended recipient — a shared AquaMobil device drops a
      // push minted for anyone but its active session.
      userId,
    },
  };
}
