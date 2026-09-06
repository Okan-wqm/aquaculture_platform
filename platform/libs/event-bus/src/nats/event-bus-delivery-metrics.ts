import * as client from 'prom-client';

/**
 * Delivery-outcome metrics for the NATS event bus (PLAT-HIGH-902).
 *
 *   - `event_bus_handler_outcome_total{service,event_type,disposition}` —
 *     one increment per folded message: ack | nak | term.
 *   - `event_bus_dead_letter_total{service,event_type,retry_exhausted}` —
 *     one increment per dead-lettered message; `retry_exhausted="true"` when
 *     the budget ran out, `"false"` when a handler terminated it.
 *
 * Registered on the default prom-client registry so the consuming service's
 * existing /metrics endpoint exposes them; looked up before creation so a
 * process that instantiates the bus more than once (tests, shared libs) does
 * not trip prom-client's duplicate-registration error — the same
 * register-or-reuse idiom as OutboxMetricsService.
 */
const METRIC_OUTCOME = 'event_bus_handler_outcome_total';
const METRIC_DEAD_LETTER = 'event_bus_dead_letter_total';

export type MessageDispositionKind = 'ack' | 'nak' | 'term';

function counter(
  name: string,
  help: string,
  labelNames: readonly string[],
): client.Counter<string> {
  const existing = client.register.getSingleMetric(name);
  if (existing instanceof client.Counter) {
    return existing;
  }
  return new client.Counter({ name, help, labelNames: [...labelNames] });
}

export class EventBusDeliveryMetrics {
  private readonly outcomes: client.Counter<string>;
  private readonly deadLetters: client.Counter<string>;

  constructor(private readonly service: string) {
    this.outcomes = counter(
      METRIC_OUTCOME,
      'Folded delivery disposition of every consumed event bus message',
      ['service', 'event_type', 'disposition'],
    );
    this.deadLetters = counter(
      METRIC_DEAD_LETTER,
      'Event bus messages terminated and handed to the dead-letter sink',
      ['service', 'event_type', 'retry_exhausted'],
    );
  }

  observeDisposition(eventType: string, disposition: MessageDispositionKind): void {
    this.outcomes.inc({ service: this.service, event_type: eventType, disposition });
  }

  observeDeadLetter(eventType: string, retryExhausted: boolean): void {
    this.deadLetters.inc({
      service: this.service,
      event_type: eventType,
      retry_exhausted: String(retryExhausted),
    });
  }
}
