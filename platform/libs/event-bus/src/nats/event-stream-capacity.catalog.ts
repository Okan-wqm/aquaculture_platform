import type { ProtocolFeedingTransportEventType } from '@platform/event-contracts';

export const NANOSECONDS_PER_DAY = 24 * 60 * 60 * 1_000_000_000;

/** Runtime JetStream limits and their infrastructure headroom in one authority. */
export const AQUACULTURE_EVENT_STREAM_PROFILE_V1 = Object.freeze({
  schemaVersion: 'aquaculture-event-stream-profile/v1' as const,
  subjects: Object.freeze(['events.>', 'commands.>', 'queries.>'] as const),
  retentionDays: 7,
  maxBytes: 1536 * 1024 * 1024,
  maxMessages: 1_000_000,
  maxMessageBytes: 1024 * 1024,
  duplicateWindowNanoseconds: 2 * 60 * 1_000_000_000,
  infrastructureMaxFileStoreBytes: 2 * 1024 * 1024 * 1024,
  alertAtUtilizationRatio: 0.7,
  /** Maximum share this incremental feeding workload may consume. */
  feedingCapacityShareRatio: 0.25,
});

export interface EventCapacityEnvelopeV1 {
  readonly producer: 'farm-service' | 'sensor-service';
  /** Planning envelope for one 1,000-unit large tenant, not a broker rate limit. */
  readonly plannedEventsPerTenantDay: number;
  /** Measured/conservative encoded-envelope planning size. */
  readonly estimatedEncodedBytes: number;
  /** Hard single-message admission ceiling for this contract. */
  readonly maxEncodedBytes: number;
  readonly cadence: 'per_action' | 'scheduled_batch' | 'daily' | 'exception';
}

/**
 * Active protocol-feeding cross-service subjects. A single catalog feeds both
 * capacity compilation and the runtime stream profile tests; no runbook owns a
 * second copy of these numbers.
 */
export const FEEDING_EVENT_CAPACITY_CATALOG_V1 = Object.freeze({
  MealWindowUpcoming: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 8,
    estimatedEncodedBytes: 80_000,
    maxEncodedBytes: 900_000,
    cadence: 'scheduled_batch',
  },
  MealFed: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 4000,
    estimatedEncodedBytes: 600,
    maxEncodedBytes: 4096,
    cadence: 'per_action',
  },
  MealSkipped: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 40,
    estimatedEncodedBytes: 500,
    maxEncodedBytes: 4096,
    cadence: 'exception',
  },
  MealUnderfed: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 40,
    estimatedEncodedBytes: 600,
    maxEncodedBytes: 4096,
    cadence: 'exception',
  },
  MealMissed: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 40,
    estimatedEncodedBytes: 500,
    maxEncodedBytes: 4096,
    cadence: 'exception',
  },
  FeedTypeTransitioned: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 5,
    estimatedEncodedBytes: 650,
    maxEncodedBytes: 4096,
    cadence: 'exception',
  },
  UnfedUnitDetected: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 10,
    estimatedEncodedBytes: 550,
    maxEncodedBytes: 4096,
    cadence: 'daily',
  },
  FeedingDailySummary: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 1,
    estimatedEncodedBytes: 700,
    maxEncodedBytes: 8192,
    cadence: 'daily',
  },
  FCRAlert: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 10,
    estimatedEncodedBytes: 550,
    maxEncodedBytes: 4096,
    cadence: 'daily',
  },
  FeedStockoutForecast: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 20,
    estimatedEncodedBytes: 650,
    maxEncodedBytes: 8192,
    cadence: 'daily',
  },
  FeedTransitionUpcoming: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 10,
    estimatedEncodedBytes: 650,
    maxEncodedBytes: 8192,
    cadence: 'daily',
  },
  FeedingProtocolAssigned: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 10,
    estimatedEncodedBytes: 650,
    maxEncodedBytes: 8192,
    cadence: 'per_action',
  },
  FeedingProtocolAssignmentPaused: {
    producer: 'farm-service',
    plannedEventsPerTenantDay: 5,
    estimatedEncodedBytes: 500,
    maxEncodedBytes: 4096,
    cadence: 'per_action',
  },
  FeedingWindowReadiness: {
    producer: 'sensor-service',
    plannedEventsPerTenantDay: 8,
    estimatedEncodedBytes: 80_000,
    maxEncodedBytes: 900_000,
    cadence: 'scheduled_batch',
  },
} satisfies Readonly<Record<ProtocolFeedingTransportEventType, EventCapacityEnvelopeV1>>);

export interface CompiledEventStreamCapacityV1 {
  readonly schemaVersion: 'compiled-event-stream-capacity/v1';
  readonly retainedMessagesPerLargeTenant: number;
  readonly retainedBytesPerLargeTenant: number;
  readonly feedingMessageBudget: number;
  readonly feedingByteBudget: number;
  readonly qualifiedLargeTenantCeiling: number;
  readonly bindingDimension: 'messages' | 'bytes';
}

export function compileFeedingEventStreamCapacityV1(): CompiledEventStreamCapacityV1 {
  const entries = Object.values(FEEDING_EVENT_CAPACITY_CATALOG_V1);
  const dailyMessages = entries.reduce(
    (total, entry) => total + entry.plannedEventsPerTenantDay,
    0,
  );
  const dailyBytes = entries.reduce(
    (total, entry) => total + entry.plannedEventsPerTenantDay * entry.estimatedEncodedBytes,
    0,
  );
  const retainedMessagesPerLargeTenant =
    dailyMessages * AQUACULTURE_EVENT_STREAM_PROFILE_V1.retentionDays;
  const retainedBytesPerLargeTenant =
    dailyBytes * AQUACULTURE_EVENT_STREAM_PROFILE_V1.retentionDays;
  const feedingMessageBudget = Math.floor(
    AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxMessages *
      AQUACULTURE_EVENT_STREAM_PROFILE_V1.feedingCapacityShareRatio,
  );
  const feedingByteBudget = Math.floor(
    AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxBytes *
      AQUACULTURE_EVENT_STREAM_PROFILE_V1.feedingCapacityShareRatio,
  );
  const messageCeiling = Math.floor(feedingMessageBudget / retainedMessagesPerLargeTenant);
  const byteCeiling = Math.floor(feedingByteBudget / retainedBytesPerLargeTenant);

  return Object.freeze({
    schemaVersion: 'compiled-event-stream-capacity/v1',
    retainedMessagesPerLargeTenant,
    retainedBytesPerLargeTenant,
    feedingMessageBudget,
    feedingByteBudget,
    qualifiedLargeTenantCeiling: Math.min(messageCeiling, byteCeiling),
    bindingDimension: messageCeiling <= byteCeiling ? 'messages' : 'bytes',
  });
}

/**
 * Runtime admission is compiled from the same envelope used by capacity
 * planning. A contract-specific maximum therefore cannot remain a decorative
 * spreadsheet number while the publisher emits a larger payload.
 */
export function assertEventCapacityAdmissionV1(eventType: string, encodedBytes: number): void {
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes < 0) {
    throw new Error(`Encoded event size must be a non-negative safe integer, got ${encodedBytes}`);
  }
  const envelope = FEEDING_EVENT_CAPACITY_CATALOG_V1[
    eventType as ProtocolFeedingTransportEventType
  ] as EventCapacityEnvelopeV1 | undefined;
  const admissionLimit =
    envelope?.maxEncodedBytes ?? AQUACULTURE_EVENT_STREAM_PROFILE_V1.maxMessageBytes;
  if (encodedBytes > admissionLimit) {
    throw new Error(
      `${eventType} encoded payload is ${encodedBytes} bytes; admission limit is ${admissionLimit}`,
    );
  }
}
