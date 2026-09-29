import { ALERT_ESCALATED_EVENT_VERSION } from '../alert-events';
import { EventUpcaster } from './event-upcaster';

/**
 * Marker a TERMINAL upcaster leaves on an event whose old shape cannot be
 * lifted to the current one. The event's trust-boundary check refuses a marked
 * event with a precise reason, so the consumer dead-letters it instead of
 * half-delivering it.
 */
export const LEGACY_EVENT_SHAPE_MARKER = '__legacyShape';

/**
 * AlertEscalated v2 → v3 — TERMINAL (V-S1a-11).
 *
 * v2 (and v1, via the timestamp upcaster) carried only `escalatedTo` user ids
 * and a reason; v3 carries everything delivery needs (title, severity,
 * channels, role targets, site, incident identity). The missing fields cannot
 * be derived from the old payload, so this upcaster does not pretend to: it
 * stamps v3 plus the legacy marker, and `checkAlertEscalatedEvent` refuses the
 * event with "legacy shape" — a visible dead letter, never a silent drop or a
 * page to nobody.
 */
export const alertEscalatedUpcaster: EventUpcaster = {
  eventType: 'AlertEscalated',
  fromVersion: 2,
  // Literal (the chain invariant reads it) and checked against the contract.
  toVersion: 3 satisfies typeof ALERT_ESCALATED_EVENT_VERSION,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    return {
      ...event,
      version: ALERT_ESCALATED_EVENT_VERSION,
      [LEGACY_EVENT_SHAPE_MARKER]: 'AlertEscalated<=v2 carries no delivery fields',
    };
  },
};
