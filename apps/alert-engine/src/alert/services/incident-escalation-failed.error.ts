/**
 * An incident was recorded but its escalation could not be started — the page
 * did not go out (V-S1a-12).
 *
 * WHY a type of its own: a `reproducible` farm signal (the 07:00 stock-out
 * forecast, the 06:00 unfed-unit sweep) acknowledges its transient failures,
 * because tomorrow's sweep re-raises the condition. That is fine for a failed
 * history insert, but not for a failed page: the incident is already open, so
 * tomorrow's occurrence only bumps it and a CRITICAL stock-out waits a day for
 * anyone to hear of it. Every farm-signal consumer therefore RE-DRIVES this
 * error, whatever the signal's delivery semantics
 * (`farmSignalFailureOutcome`).
 *
 * `failureClass: 'transient'` is the event-bus convention for "redelivery can
 * fix this" — the escalation writes are claim-guarded, so a redelivery pages
 * exactly once.
 */
export class IncidentEscalationFailedError extends Error {
  readonly failureClass = 'transient' as const;

  constructor(
    readonly incidentId: string,
    readonly escalationError: unknown,
  ) {
    super(
      `Escalation of incident ${incidentId} failed: ` +
        `${escalationError instanceof Error ? escalationError.message : String(escalationError)}`,
    );
    this.name = 'IncidentEscalationFailedError';
  }
}
