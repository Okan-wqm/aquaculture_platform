/**
 * Event delivery semantics registry (W7 / plan D-B5, FARM-MEDIUM-260).
 *
 * ## The problem this encodes
 *
 * Every alert-engine feeding consumer was written with the same catch block:
 *
 *   > "Swallow so NATS does not redeliver a poison message indefinitely"
 *
 * That comment is HALF right, and the half that is wrong loses data. It is
 * correct for a signal a cron re-derives from live state: if today's 07:00
 * stock-coverage sweep fails to open an incident, tomorrow's sweep opens it
 * from the same DB rows, so swallowing costs a day of latency and nothing
 * else. It is WRONG for a one-shot state transition: `MealMissed` is emitted
 * exactly once, by the sweep that flips the meal's status, in the same
 * transaction that burns the marker. Nothing re-derives it. Swallowing that
 * error deletes the fact that a tank went unfed.
 *
 * The two cases need opposite handling, so "swallow vs rethrow" cannot be a
 * per-handler judgement call made in a comment — it is a property OF THE EVENT
 * and belongs next to the contract.
 *
 * ## Why a `Record` and not a lookup table
 *
 * The map is typed as `Record<ConsumedFarmEventType, EventDeliverySemantics>`
 * where the key union is built from the event interfaces themselves. Adding an
 * event to the union without classifying it is a COMPILE ERROR, and a typo in
 * a key is a compile error too (tier-1). `tests/invariants/`
 * `feeding-event-delivery-semantics.spec.ts` closes the remaining hole — a new
 * feeding event declared in `farm-events.ts` but never added to the union — by
 * scanning the contract file (tier-3).
 *
 * ## Contract for consumers
 *
 * - `reproducible` — a handler MAY swallow its error after logging. The signal
 *   is re-derived from durable state on the next producer run.
 * - `one_shot` — a handler MUST rethrow. `NatsEventBus` NAKs with backoff and,
 *   once `max_deliver` is exhausted, writes the message to the service's
 *   platform dead-letter stream (AQUACULTURE_DLQ, `NATS_DLQ_AFTER_DELIVERIES`) before
 *   acking it — the bus owns that route (`NatsEventBus.handleMessageFailure`); it is
 *   therefore mandatory for any service consuming a `one_shot` event.
 */
import type {
  FCRAlertEvent,
  FeedStockoutForecastEvent,
  FeedTransitionUpcomingEvent,
  FeedTypeTransitionedEvent,
  FeedingDailySummaryEvent,
  FeedingProtocolAssignedEvent,
  FeedingProtocolAssignmentPausedEvent,
  MealFedEvent,
  MealMissedEvent,
  MealSkippedEvent,
  MealUnderfedEvent,
  MealWindowUpcomingEvent,
  MortalityAlertRaisedEvent,
  UnfedUnitDetectedEvent,
} from './farm-events';
import type { FeedingWindowReadinessEvent, SensorReadingEvent } from './sensor-events';
import type { LowStockDetectedEvent } from './storage-events';
import type { WaterQualityCriticalEvent } from './water-quality-events';

export type EventDeliverySemantics = 'reproducible' | 'one_shot';

/**
 * Every farm-raised signal consumed by an alert-engine event handler.
 *
 * The membership rule is exactly "some `apps/alert-engine/src/alert/
 * event-handlers/*.ts` subscribes to it" — a bounded, mechanically checkable
 * set (the invariant spec walks that directory). An event nobody subscribes to
 * needs no swallow/rethrow decision; an event someone subscribes to must have
 * one, because that handler WILL write a catch block.
 */
export type ConsumedFarmSignalEvent =
  | FCRAlertEvent
  | FeedStockoutForecastEvent
  | FeedTransitionUpcomingEvent
  | FeedTypeTransitionedEvent
  | FeedingDailySummaryEvent
  | FeedingProtocolAssignedEvent
  | FeedingProtocolAssignmentPausedEvent
  | FeedingWindowReadinessEvent
  | LowStockDetectedEvent
  | MealFedEvent
  | MealMissedEvent
  | MealSkippedEvent
  | MealUnderfedEvent
  | MealWindowUpcomingEvent
  | MortalityAlertRaisedEvent
  | SensorReadingEvent
  | UnfedUnitDetectedEvent
  | WaterQualityCriticalEvent;

export type ConsumedFarmSignalEventType = ConsumedFarmSignalEvent['eventType'];

export const FARM_SIGNAL_DELIVERY_SEMANTICS: Record<
  ConsumedFarmSignalEventType,
  EventDeliverySemantics
> = {
  // ── Reproducible: a scheduled sweep re-derives these from live state ──
  //
  // 07:00 coverage sweep recomputes the forecast snapshot every day and
  // re-emits whatever is still true.
  FeedStockoutForecast: 'reproducible',
  FeedTransitionUpcoming: 'reproducible',
  // 06:00 generation re-detects every fish-bearing unit that still has no
  // effective plan, so the signal survives a lost delivery.
  UnfedUnitDetected: 'reproducible',
  // The 18:00 FCR sweep recomputes trends from feeding_records each evening.
  FCRAlert: 'reproducible',
  // The 15-min window cron re-emits for any meal still inside its lead window;
  // a lost batch costs at most one tick of aerator pre-boost lead time.
  MealWindowUpcoming: 'reproducible',
  // Derived from MealWindowUpcoming, so it inherits that reproducibility: the
  // next tick re-evaluates the same DO readings for any meal still in window.
  FeedingWindowReadiness: 'reproducible',
  // Continuous telemetry: the next reading for the same sensor arrives within
  // seconds and re-evaluates every threshold rule. Rethrowing here would turn
  // one bad reading into a redelivery storm on the platform's highest-volume
  // subject for no gain.
  SensorReading: 'reproducible',

  // ── One-shot: emitted exactly once, in the transaction that changes state ──
  //
  // The 05:30 sweep flips the meal to `missed` and emits in the SAME
  // transaction. Nothing re-derives it — a lost delivery deletes the fact that
  // a tank went unfed.
  MealMissed: 'one_shot',
  // Emitted at meal finalize / in the 20:00 day-level sweep; the day plan is
  // settled afterwards and never re-evaluated.
  MealUnderfed: 'one_shot',
  // Per-pour operator action. Not re-derivable: nothing re-walks pours.
  MealFed: 'one_shot',
  MealSkipped: 'one_shot',
  // The assignment's currentFeed/band is already advanced when this lands;
  // re-reading state later cannot tell you a transition happened.
  FeedTypeTransitioned: 'one_shot',
  // One digest per tenant per local day, guarded by a feeding_job_runs claim —
  // the claim prevents re-emission, so a lost delivery loses the digest.
  FeedingDailySummary: 'one_shot',
  // Assignment lifecycle audit — the row moves on and the transition is not
  // recoverable from the current state alone.
  FeedingProtocolAssigned: 'one_shot',
  FeedingProtocolAssignmentPaused: 'one_shot',
  // Emitted by the stock ledger the moment a movement crosses the threshold.
  // There is no sweep that re-emits it: if no further movement happens, the
  // depletion is never signalled again.
  LowStockDetected: 'one_shot',
  // Raised by the mortality-recorded listener at write time, once per record.
  // No sweep re-raises it; losing it loses a welfare event.
  MortalityAlertRaised: 'one_shot',
  // Emitted per critical measurement by `water-quality.service.ts`, at write
  // time. A manual measurement may be the only one for hours, so there is no
  // "the next reading will re-raise it" guarantee — and a lost critical
  // water-quality signal is a life-safety miss, not a latency cost.
  WaterQualityCritical: 'one_shot',
};

/**
 * True when a consumer of `eventType` MUST rethrow on failure (and the service
 * is therefore dead-lettered by the bus, never dropped). Unknown types default to `false`:
 * this registry is authoritative only for the events it classifies, and a
 * consumer of an unlisted event keeps whatever policy its own contract
 * documents rather than silently inheriting the strict one.
 */
export function requiresDurableDelivery(eventType: string): boolean {
  return FARM_SIGNAL_DELIVERY_SEMANTICS[eventType as ConsumedFarmSignalEventType] === 'one_shot';
}
