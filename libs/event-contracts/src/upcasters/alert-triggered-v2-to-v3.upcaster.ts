import { ALERT_TRIGGERED_EVENT_VERSION } from '../alert-events';
import { EventUpcaster } from './event-upcaster';

/**
 * AlertTriggered v2 → v3 (decision 7).
 *
 * v3 adds `incidentId`, the delivery key of a sensor rule's external targets.
 * A v2 event never named its incident; its only per-trigger identity is the
 * AlertHistory id (`alertId`), so that id becomes the key. A v2 event in flight
 * across the deploy therefore delivers exactly as v2 always did — once per
 * trigger — and every v3 event delivers once per incident.
 */
export const alertTriggeredV2ToV3Upcaster: EventUpcaster = {
  eventType: 'AlertTriggered',
  fromVersion: 2,
  // Literal (the chain invariant reads it) and checked against the contract.
  toVersion: 3 satisfies typeof ALERT_TRIGGERED_EVENT_VERSION,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    return { ...event, version: ALERT_TRIGGERED_EVENT_VERSION, incidentId: event['alertId'] };
  },
};
