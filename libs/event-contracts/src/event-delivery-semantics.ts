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

export type ProtocolFeedingTransportEvent =
  | FCRAlertEvent
  | FeedStockoutForecastEvent
  | FeedTransitionUpcomingEvent
  | FeedTypeTransitionedEvent
  | FeedingDailySummaryEvent
  | FeedingProtocolAssignedEvent
  | FeedingProtocolAssignmentPausedEvent
  | FeedingWindowReadinessEvent
  | MealFedEvent
  | MealMissedEvent
  | MealSkippedEvent
  | MealUnderfedEvent
  | MealWindowUpcomingEvent
  | UnfedUnitDetectedEvent;

export type ProtocolFeedingTransportEventType = ProtocolFeedingTransportEvent['eventType'];

export type ConsumedFarmSignalEventType = ConsumedFarmSignalEvent['eventType'];

/**
 * Event-owned delivery policy. Consumers cannot invent local swallow/rethrow
 * behavior, and adding an event to the governed union requires a class here.
 */
export const FARM_SIGNAL_DELIVERY_SEMANTICS = Object.freeze({
  FeedStockoutForecast: 'reproducible',
  FeedTransitionUpcoming: 'reproducible',
  UnfedUnitDetected: 'reproducible',
  FCRAlert: 'reproducible',
  MealWindowUpcoming: 'reproducible',
  SensorReading: 'reproducible',
  FeedingWindowReadiness: 'reproducible',

  MealMissed: 'one_shot',
  MealUnderfed: 'one_shot',
  MealFed: 'one_shot',
  MealSkipped: 'one_shot',
  FeedTypeTransitioned: 'one_shot',
  FeedingDailySummary: 'one_shot',
  FeedingProtocolAssigned: 'one_shot',
  FeedingProtocolAssignmentPaused: 'one_shot',
  LowStockDetected: 'one_shot',
  MortalityAlertRaised: 'one_shot',
  WaterQualityCritical: 'one_shot',
} satisfies Readonly<Record<ConsumedFarmSignalEventType, EventDeliverySemantics>>);

export function requiresDurableDelivery(eventType: string): boolean {
  return FARM_SIGNAL_DELIVERY_SEMANTICS[eventType as ConsumedFarmSignalEventType] === 'one_shot';
}
