import { HandlerOutcome, outcomeForError } from '@platform/event-bus';
import { requiresDurableDelivery } from '@platform/event-contracts';

import { IncidentEscalationFailedError } from '../services/incident-escalation-failed.error';

/**
 * The delivery outcome of a failed farm-signal consumer — ONE rule for every
 * alert-engine farm-signal handler.
 *
 *   - a failed ESCALATION (the incident exists, the page did not go out) is
 *     always re-driven, whatever the signal's delivery semantics (V-S1a-12):
 *     a reproducible signal's next emission only bumps the open incident, so
 *     acknowledging would leave a CRITICAL page waiting for tomorrow's sweep;
 *   - anything else follows the contract: an error redelivery cannot fix is
 *     dead-lettered, a transient one is retried for a `one_shot` signal and
 *     acknowledged (with its reason) for a `reproducible` one.
 *
 * The retry budget itself is the life-safety one (`LIFE_SAFETY_REDELIVERY`),
 * applied by the bus to these event types automatically.
 */
export function farmSignalFailureOutcome(
  context: string,
  eventType: string,
  error: unknown,
): HandlerOutcome {
  if (error instanceof IncidentEscalationFailedError) {
    return HandlerOutcome.retry(`${context}: ${error.message}`, error);
  }
  return outcomeForError(context, error, { reproducible: !requiresDurableDelivery(eventType) });
}
