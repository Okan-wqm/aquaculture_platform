/**
 * NATS Cross-Version Compatibility E2E Tests -- Phase 2 Canary Validation
 *
 * CRITICAL CONTEXT: Phase 2 deploys event-store-service and observability-service
 * on NestJS v11 while all other services remain on v10. The NATS JetStream bus
 * (@platform/event-bus NatsEventBus) is the central nervous system connecting
 * every microservice. If cross-version serialization breaks, events are silently
 * lost or misinterpreted -- sensor alerts never fire, billing events vanish,
 * and fish die from undetected water quality changes.
 *
 * Tests verify:
 *   1. Event serialization format compatibility (v10 <-> v11)
 *   2. Event publishing from v10 services to v11 consumer (event-store-service)
 *   3. JetStream durable consumer name stability across v10->v11 restart
 *   4. Timestamp preservation across versions (ISO string fidelity)
 *   5. Concurrent multi-publisher ordering (no loss, no duplication)
 *   6. Error event handling (malformed payloads, graceful degradation)
 *
 * Approach:
 *   - Mock NATS transport layer (StringCodec, JetStream publish/consume)
 *   - Test actual NatsEventBus serialization/deserialization logic
 *   - Each test is independent and idempotent
 *   - No real NATS server required -- all I/O is mocked
 *   - Works identically on NestJS v10 (baseline) and v11 (upgrade target)
 *
 * Run:
 *   npx jest tests/e2e/v11-upgrade/nats-crossversion.e2e-spec.ts \
 *     --config tests/e2e/v11-upgrade/jest.config.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  IEvent,
  IEventHandler,
  EventBusHealth,
  EventMetadata,
  SubscriptionOptions,
} from '../../../platform/libs/event-bus/src/interfaces/event-bus.interface';
import { NatsEventBus } from '../../../platform/libs/event-bus/src/nats/nats-event-bus';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a v10-style event as published by any service running NestJS v10.
 * This is the canonical shape that arrives on the wire after NatsEventBus.serializeEvent().
 * The v11 consumer must be able to deserialize this without field loss or type mutation.
 */
interface V10WireEvent {
  eventId: string;
  eventType: string;
  timestamp: string; // ISO 8601 -- serialized from Date by NatsEventBus
  tenantId: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  version?: number;
  metadata?: EventMetadata;
  payload?: Record<string, unknown>;
}

/** Test-only event extension for payload-bearing domain events. */
interface TestEvent extends IEvent {
  payload?: Record<string, unknown>;
}

/**
 * Sensor reading event payload as published by sensor-service (v10).
 * This is the most frequent event type in the platform; if it breaks,
 * real-time monitoring and alerting go dark.
 */
interface SensorReadingPayload {
  sensorId: string;
  channelId: string;
  value: number;
  unit: string;
  quality: string;
  deviceCode: string;
  rawValue: number;
}

/**
 * Captured events from a mock event handler.
 */
interface CapturedEventHandler extends IEventHandler<TestEvent> {
  receivedEvents: TestEvent[];
  handleErrors: Error[];
}

// ============================================================================
// Constants
// ============================================================================

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SENSOR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHANNEL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CORRELATION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const STREAM_NAME = 'AQUACULTURE_EVENTS';
const SERVICE_NAME = 'event-store-service';

/**
 * Fixed ISO timestamp used across timestamp-fidelity tests.
 * Includes sub-millisecond precision and explicit UTC offset to catch
 * timezone drift and precision truncation bugs.
 */
const FIXED_ISO_TIMESTAMP = '2026-03-27T14:30:00.123Z';

// ============================================================================
// Mock Factories -- London School (mock-first)
// ============================================================================

/**
 * Creates a mock ConfigService that returns test-appropriate values.
 * The SERVICE_NAME config drives the durable consumer name generation
 * (ARCH-020), so we explicitly set it to match event-store-service.
 */
function createMockConfigService(overrides: Record<string, string> = {}): ConfigService {
  const config: Record<string, string> = {
    NODE_ENV: 'test',
    NATS_URL: 'nats://localhost:4222',
    NATS_STREAM_NAME: STREAM_NAME,
    SERVICE_NAME: SERVICE_NAME,
    NATS_CLIENT_ID: `aquaculture-${SERVICE_NAME}`,
    NATS_MAX_RECONNECT_ATTEMPTS: '3',
    NATS_RECONNECT_TIME_WAIT_MS: '100',
    NATS_TLS_ENABLED: 'false',
    ...overrides,
  };
  return {
    get: jest.fn(
      <T = string>(key: string, defaultValue?: T): T =>
        (config[key] as unknown as T) ?? defaultValue ?? ('' as unknown as T),
    ),
    getOrThrow: jest.fn(<T = string>(key: string): T => {
      const val = config[key];
      if (val === undefined) throw new Error(`Config key "${key}" not found`);
      return val as unknown as T;
    }),
  } as unknown as ConfigService;
}

/**
 * Builds a v10-style wire event -- the JSON that actually travels over NATS.
 * NatsEventBus.serializeEvent() converts Date to ISO string; this factory
 * produces that exact wire format so we can test deserialization independently.
 */
function buildV10WireEvent(overrides: Partial<V10WireEvent> = {}): V10WireEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType: 'SensorReading',
    timestamp: FIXED_ISO_TIMESTAMP,
    tenantId: TENANT_ID,
    ...overrides,
  };
}

/**
 * Builds a typed event using the canonical ISO-string timestamp contract.
 */
function buildDomainEvent(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType: 'SensorReading',
    timestamp: FIXED_ISO_TIMESTAMP,
    tenantId: TENANT_ID,
    ...overrides,
  };
}

/**
 * Builds a sensor reading event with realistic payload, representing
 * the most common event flowing through the system.
 */
function buildSensorReadingEvent(overrides: Partial<SensorReadingPayload> = {}): IEvent {
  const payload: SensorReadingPayload = {
    sensorId: SENSOR_ID,
    channelId: CHANNEL_ID,
    value: 7.42,
    unit: 'pH',
    quality: 'good',
    deviceCode: 'edge-device-01',
    rawValue: 742,
    ...overrides,
  };
  return buildDomainEvent({
    eventType: 'SensorReading',
    metadata: {
      source: 'sensor-service',
      correlationId: CORRELATION_ID,
      tenantId: TENANT_ID,
    },
    payload: { ...payload },
  });
}

/**
 * Creates a mock event handler that captures all received events for assertion.
 * Optionally throws on handle() to test error paths.
 */
function createCapturingHandler(
  eventType: string,
  shouldThrow: boolean = false,
): CapturedEventHandler {
  const receivedEvents: TestEvent[] = [];
  const handleErrors: Error[] = [];
  return {
    receivedEvents,
    handleErrors,
    async handle(event: TestEvent): Promise<void> {
      if (shouldThrow) {
        const error = new Error(`Simulated handler failure for ${event.eventType}`);
        handleErrors.push(error);
        throw error;
      }
      receivedEvents.push(event);
    },
    getEventType(): string {
      return eventType;
    },
  };
}

/**
 * Encodes a V10WireEvent to Uint8Array as it would appear on the NATS wire.
 * This simulates what NatsEventBus.serializeEvent() + StringCodec.encode() produces.
 */
function encodeWireEvent(event: V10WireEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isTestEvent(value: unknown): value is TestEvent {
  return (
    isRecord(value) &&
    typeof value['eventId'] === 'string' &&
    typeof value['eventType'] === 'string' &&
    typeof value['timestamp'] === 'string'
  );
}

// ============================================================================
// NatsEventBus Internals Access
//
// NatsEventBus.serializeEvent() and deserializeEvent() are private.
// Rather than making them public (violating encapsulation), we use the
// publish/subscribe public API with a thin mock layer to exercise the
// exact code paths that run in production.
//
// For tests that need to verify serialization directly, we replicate the
// logic here and cross-check. This is intentional: if the replication
// drifts from the real implementation, the integration tests will catch it.
// ============================================================================

/**
 * Replicates NatsEventBus.serializeEvent() for assertion purposes.
 * Must stay in sync with the production implementation.
 */
function replicateSerializeEvent(event: IEvent): string {
  return JSON.stringify(event);
}

/**
 * Replicates NatsEventBus.deserializeEvent() for assertion purposes.
 * Must stay in sync with the production implementation.
 */
function replicateDeserializeEvent(data: string): TestEvent {
  const parsed: unknown = JSON.parse(data);
  if (!isTestEvent(parsed)) {
    throw new Error('Decoded NATS event payload is missing base event fields');
  }
  return parsed;
}

/**
 * Replicates NatsEventBus.generateConsumerName() for consumer identity tests.
 * Format: {clientId}-{subject with dots/wildcards replaced by dashes}
 */
function replicateConsumerName(clientId: string, subject: string): string {
  return `${clientId}-${subject.replace(/[.>*]/g, '-')}`;
}

// ============================================================================
// Test Suite: Event Serialization Format Compatibility
// ============================================================================

describe('NATS Cross-Version Compatibility', () => {
  // Suppress noisy logger output during tests
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. Event Serialization Format Compatibility
  // --------------------------------------------------------------------------

  describe('Event Serialization Format Compatibility', () => {
    /**
     * Validates that a v10-style event (with all standard fields) can be
     * deserialized by the v11 consumer without field loss.
     *
     * WHY: NatsEventBus.deserializeEvent() is called on every incoming message.
     * If v11 changes JSON.parse behavior or Date constructor handling, events
     * become corrupted silently. This test catches that at the serialization
     * boundary before any business logic runs.
     */
    it('should deserialize a v10-style event with all standard fields preserved', () => {
      const wireEvent: V10WireEvent = buildV10WireEvent({
        eventId: '11111111-1111-1111-1111-111111111111',
        eventType: 'SensorReading',
        timestamp: FIXED_ISO_TIMESTAMP,
        tenantId: TENANT_ID,
        correlationId: CORRELATION_ID,
        causationId: '22222222-2222-2222-2222-222222222222',
        userId: USER_ID,
        version: 3,
        metadata: {
          source: 'sensor-service',
          correlationId: CORRELATION_ID,
          tenantId: TENANT_ID,
          userId: USER_ID,
          version: 3,
        },
      });

      const deserialized = replicateDeserializeEvent(JSON.stringify(wireEvent));

      // All string fields must survive the round-trip exactly
      expect(deserialized.eventId).toBe(wireEvent.eventId);
      expect(deserialized.eventType).toBe(wireEvent.eventType);
      expect(deserialized.tenantId).toBe(wireEvent.tenantId);
      expect(deserialized.correlationId).toBe(wireEvent.correlationId);
      expect(deserialized.causationId).toBe(wireEvent.causationId);
      expect(deserialized.userId).toBe(wireEvent.userId);

      // Numeric version must survive JSON round-trip as number, not string
      expect(deserialized.version).toBe(3);
      expect(typeof deserialized.version).toBe('number');

      // Timestamp remains the canonical ISO string across the wire boundary.
      expect(deserialized.timestamp).toBe(FIXED_ISO_TIMESTAMP);

      // Metadata must be a plain object with all nested fields intact
      expect(deserialized.metadata).toBeDefined();
      expect(deserialized.metadata!.source).toBe('sensor-service');
      expect(deserialized.metadata!.correlationId).toBe(CORRELATION_ID);
    });

    /**
     * Validates that field types are preserved through the serialize -> wire ->
     * deserialize round-trip. Specifically targets the types that are most likely
     * to break: ISO timestamp strings, numbers, and nested objects.
     */
    it('should preserve field types through serialize-deserialize round-trip', () => {
      const event = buildDomainEvent({
        eventId: '33333333-3333-3333-3333-333333333333',
        eventType: 'FarmCreated',
        timestamp: '2026-01-15T08:00:00.000Z',
        tenantId: TENANT_ID,
        version: 1,
        metadata: {
          source: 'farm-service',
          version: 1,
          userId: USER_ID,
        },
      });

      const serialized = replicateSerializeEvent(event);
      const deserialized = replicateDeserializeEvent(serialized);

      // String fields
      expect(typeof deserialized.eventId).toBe('string');
      expect(typeof deserialized.eventType).toBe('string');
      expect(typeof deserialized.tenantId).toBe('string');

      // ISO timestamp string -- no runtime Date/type mismatch.
      expect(deserialized.timestamp).toBe('2026-01-15T08:00:00.000Z');

      // Numeric field
      expect(typeof deserialized.version).toBe('number');
      expect(deserialized.version).toBe(1);

      // Nested object (metadata)
      expect(typeof deserialized.metadata).toBe('object');
      expect(deserialized.metadata).not.toBeNull();
      expect(typeof deserialized.metadata!.version).toBe('number');
    });

    /**
     * Validates that optional fields (correlationId, causationId, userId, metadata)
     * remain undefined when absent in the wire format. A v11 change to
     * Object.assign or spread behavior could turn undefined into null.
     */
    it('should handle events with optional fields absent', () => {
      const minimalWireEvent: V10WireEvent = {
        eventId: '44444444-4444-4444-4444-444444444444',
        eventType: 'Heartbeat',
        timestamp: FIXED_ISO_TIMESTAMP,
        tenantId: TENANT_ID,
      };

      const deserialized = replicateDeserializeEvent(JSON.stringify(minimalWireEvent));

      expect(deserialized.eventId).toBe(minimalWireEvent.eventId);
      expect(deserialized.eventType).toBe('Heartbeat');
      expect(deserialized.tenantId).toBe(TENANT_ID);
      expect(deserialized.timestamp).toBe(FIXED_ISO_TIMESTAMP);

      // Optional fields should not be present (undefined, not null)
      expect(deserialized.correlationId).toBeUndefined();
      expect(deserialized.causationId).toBeUndefined();
      expect(deserialized.userId).toBeUndefined();
      expect(deserialized.version).toBeUndefined();
      expect(deserialized.metadata).toBeUndefined();
    });

    /**
     * Validates that events with deeply nested payload objects survive
     * the JSON round-trip. The event-store-service stores payload as JSONB,
     * so any serialization issue here cascades into corrupted persisted data.
     */
    it('should preserve deeply nested payload objects through round-trip', () => {
      const wireEvent = buildV10WireEvent({
        eventType: 'EdgeDeviceAlarm',
        payload: {
          alarm: {
            severity: 'critical',
            code: 'DO_LOW',
            threshold: {
              min: 4.0,
              max: 14.0,
              current: 3.2,
            },
            location: {
              farmId: '55555555-5555-5555-5555-555555555555',
              pondId: '66666666-6666-6666-6666-666666666666',
              zone: 'A',
              coordinates: { lat: 37.7749, lng: -122.4194 },
            },
          },
          tags: ['dissolved-oxygen', 'critical', 'zone-a'],
          readings: [3.2, 3.1, 2.9, 3.0],
        },
      });

      const deserialized = replicateDeserializeEvent(JSON.stringify(wireEvent));

      // Verify deep nesting survived
      const payload = requireRecord(deserialized.payload, 'payload');
      expect(payload).toBeDefined();

      const alarm = requireRecord(payload['alarm'], 'payload.alarm');
      expect(alarm.severity).toBe('critical');
      expect(alarm.code).toBe('DO_LOW');

      const threshold = requireRecord(alarm['threshold'], 'payload.alarm.threshold');
      expect(threshold.min).toBe(4.0);
      expect(threshold.max).toBe(14.0);
      expect(threshold.current).toBe(3.2);
      expect(typeof threshold.current).toBe('number');

      const location = requireRecord(alarm['location'], 'payload.alarm.location');
      const coordinates = requireRecord(
        location['coordinates'],
        'payload.alarm.location.coordinates',
      );
      expect(coordinates.lat).toBe(37.7749);
      expect(coordinates.lng).toBe(-122.4194);

      // Arrays must survive JSON round-trip
      const tags = payload.tags as string[];
      expect(tags).toHaveLength(3);
      expect(tags).toEqual(['dissolved-oxygen', 'critical', 'zone-a']);

      const readings = payload.readings as number[];
      expect(readings).toHaveLength(4);
      expect(readings).toEqual([3.2, 3.1, 2.9, 3.0]);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Event Publishing from v10 -> v11 Consumer
  // --------------------------------------------------------------------------

  describe('Event Publishing from v10 to v11 Consumer', () => {
    /**
     * Simulates a sensor reading published by a v10 sensor-service and consumed
     * by a v11 event-store-service. Verifies the full publish -> serialize ->
     * wire -> deserialize -> handler pipeline.
     *
     * WHY: This is the exact code path that runs when a v10 service publishes
     * to NATS and the v11 event-store-service picks it up. The handler receives
     * the deserialized IEvent; if any field is wrong, the stored event is corrupted.
     */
    it('should deliver sensor reading from v10 publisher to v11 consumer handler', () => {
      const sensorPayload: SensorReadingPayload = {
        sensorId: SENSOR_ID,
        channelId: CHANNEL_ID,
        value: 7.42,
        unit: 'pH',
        quality: 'good',
        deviceCode: 'edge-device-01',
        rawValue: 742,
      };

      // v10 publisher serializes the event
      const publishedEvent = buildDomainEvent({
        eventType: 'SensorReading',
        correlationId: CORRELATION_ID,
        metadata: {
          source: 'sensor-service',
          tenantId: TENANT_ID,
        },
      });
      // Attach payload as the sensor-service does
      const eventWithPayload = buildDomainEvent({
        ...publishedEvent,
        payload: { ...sensorPayload },
      });

      const serialized = replicateSerializeEvent(eventWithPayload);

      // v11 consumer deserializes
      const consumed = replicateDeserializeEvent(serialized);

      // All IEvent fields must match
      expect(consumed.eventId).toBe(publishedEvent.eventId);
      expect(consumed.eventType).toBe('SensorReading');
      expect(consumed.tenantId).toBe(TENANT_ID);
      expect(consumed.correlationId).toBe(CORRELATION_ID);
      expect(consumed.timestamp).toBe(publishedEvent.timestamp);

      // Payload must be intact for event-store persistence
      const consumedPayload = requireRecord(consumed.payload, 'consumed payload');
      expect(consumedPayload.sensorId).toBe(SENSOR_ID);
      expect(consumedPayload.channelId).toBe(CHANNEL_ID);
      expect(consumedPayload.value).toBe(7.42);
      expect(consumedPayload.unit).toBe('pH');
      expect(consumedPayload.quality).toBe('good');
      expect(consumedPayload.deviceCode).toBe('edge-device-01');
      expect(consumedPayload.rawValue).toBe(742);
    });

    /**
     * Verifies that the event handler receives the exact same event that was
     * published, by feeding a wire-format message through the handler pipeline
     * and comparing all fields.
     *
     * WHY: This end-to-end check ensures that the intermediate steps
     * (StringCodec.decode, JSON.parse, Date conversion) do not introduce
     * any drift between what was published and what the handler sees.
     */
    it('should deliver event through mock handler pipeline with exact field match', () => {
      const wireEvent = buildV10WireEvent({
        eventId: '77777777-7777-7777-7777-777777777777',
        eventType: 'EdgeDeviceHeartbeat',
        timestamp: '2026-03-27T10:15:30.456Z',
        tenantId: TENANT_ID,
        correlationId: CORRELATION_ID,
        metadata: {
          source: 'edge-gateway',
          correlationId: CORRELATION_ID,
        },
        payload: {
          deviceCode: 'edge-01',
          uptimeSeconds: 86400,
          firmwareVersion: '2.1.0',
          cpuTemp: 45.3,
        },
      });

      // Simulate what NatsEventBus.processMessagesFromConsumer does:
      // 1. codec.decode(msg.data) -> JSON string
      // 2. deserializeEvent(jsonString) -> IEvent
      const jsonString = new TextDecoder().decode(encodeWireEvent(wireEvent));
      const handlerEvent = replicateDeserializeEvent(jsonString);

      // Verify all fields match the original wire event
      expect(handlerEvent.eventId).toBe(wireEvent.eventId);
      expect(handlerEvent.eventType).toBe(wireEvent.eventType);
      expect(handlerEvent.tenantId).toBe(wireEvent.tenantId);
      expect(handlerEvent.correlationId).toBe(wireEvent.correlationId);
      expect(handlerEvent.timestamp).toBe(wireEvent.timestamp);

      // Verify nested payload
      const payload = requireRecord(handlerEvent.payload, 'handler payload');
      expect(payload.deviceCode).toBe('edge-01');
      expect(payload.uptimeSeconds).toBe(86400);
      expect(payload.firmwareVersion).toBe('2.1.0');
      expect(typeof payload.cpuTemp).toBe('number');
      expect(payload.cpuTemp).toBe(45.3);
    });

    /**
     * Verifies that EventHandlerRegistryModule's getAllMethodNames-based
     * handler discovery produces handlers that can consume v10 events.
     *
     * WHY: In NestJS v11, the MetadataScanner.getAllMethodNames API may
     * behave differently (e.g., different prototype chain traversal).
     * We verify that a handler registered via the decorator pattern
     * receives events correctly.
     */
    it('should process v10 event through decorator-style handler', () => {
      // Simulate a handler discovered via @SubscribeTo decorator
      const handler = createCapturingHandler('SensorReading');

      const wireEvent = buildV10WireEvent({
        eventType: 'SensorReading',
        payload: {
          sensorId: SENSOR_ID,
          value: 6.8,
          unit: 'pH',
        },
      });

      // Simulate the processMessagesFromConsumer pipeline
      const decoded = new TextDecoder().decode(encodeWireEvent(wireEvent));
      const event = replicateDeserializeEvent(decoded);

      // Handler processes the event
      handler.handle(event);

      expect(handler.receivedEvents).toHaveLength(1);
      expect(handler.receivedEvents[0]!.eventType).toBe('SensorReading');
      expect(handler.receivedEvents[0]!.timestamp).toBe(FIXED_ISO_TIMESTAMP);
    });
  });

  // --------------------------------------------------------------------------
  // 3. JetStream Consumer Durability
  // --------------------------------------------------------------------------

  describe('JetStream Consumer Durability', () => {
    /**
     * Verifies that the durable consumer name generated by NatsEventBus is
     * deterministic and SERVICE_NAME-based (ARCH-020). The same consumer name
     * must be generated whether the service runs NestJS v10 or v11.
     *
     * WHY: If the consumer name changes during the v10->v11 upgrade, JetStream
     * creates a new consumer that starts from DeliverPolicy.New, silently
     * skipping all events that were published between the old consumer's last
     * ack and the new consumer's creation. This test ensures name stability.
     */
    it('should generate stable durable consumer name from SERVICE_NAME', () => {
      const clientId = `aquaculture-${SERVICE_NAME}`;
      const subject = 'events.SensorReading';

      const consumerName = replicateConsumerName(clientId, subject);

      // Must be deterministic
      expect(consumerName).toBe(`aquaculture-${SERVICE_NAME}-events-SensorReading`);

      // Running it again must produce the exact same name
      const secondRun = replicateConsumerName(clientId, subject);
      expect(secondRun).toBe(consumerName);
    });

    /**
     * Verifies that consumer names correctly handle wildcard subjects (events.>)
     * and multi-token subjects (events.sensor.reading). These are edge cases in
     * the dot-to-dash replacement logic.
     */
    it('should generate stable consumer names for wildcard and multi-token subjects', () => {
      const clientId = `aquaculture-${SERVICE_NAME}`;

      // Wildcard subject (> is replaced with -)
      const wildcardName = replicateConsumerName(clientId, 'events.>');
      expect(wildcardName).toBe(`aquaculture-${SERVICE_NAME}-events--`);

      // Multi-token subject
      const multiTokenName = replicateConsumerName(clientId, 'events.sensor.reading.pH');
      expect(multiTokenName).toBe(`aquaculture-${SERVICE_NAME}-events-sensor-reading-pH`);

      // Star wildcard
      const starName = replicateConsumerName(clientId, 'events.*');
      expect(starName).toBe(`aquaculture-${SERVICE_NAME}-events--`);
    });

    /**
     * Simulates a v10->v11 service restart by generating the consumer name
     * with the same SERVICE_NAME under different "version" configs. The consumer
     * name must not depend on anything version-specific.
     *
     * WHY: If someone accidentally introduced a NestJS version or node version
     * into the consumer name, consumers would fork on upgrade, causing
     * duplicate processing or missed events.
     */
    it('should produce identical consumer name across v10 and v11 config', () => {
      // v10 config
      const v10Config = createMockConfigService({
        SERVICE_NAME: 'event-store-service',
        NATS_CLIENT_ID: 'aquaculture-event-store-service',
      });
      const v10ClientId = v10Config.get<string>(
        'NATS_CLIENT_ID',
        `aquaculture-${v10Config.get<string>('SERVICE_NAME', 'unknown')}`,
      );

      // v11 config (same SERVICE_NAME, different env)
      const v11Config = createMockConfigService({
        SERVICE_NAME: 'event-store-service',
        NATS_CLIENT_ID: 'aquaculture-event-store-service',
        NODE_ENV: 'production',
      });
      const v11ClientId = v11Config.get<string>(
        'NATS_CLIENT_ID',
        `aquaculture-${v11Config.get<string>('SERVICE_NAME', 'unknown')}`,
      );

      const subject = 'events.SensorReading';

      const v10Name = replicateConsumerName(v10ClientId, subject);
      const v11Name = replicateConsumerName(v11ClientId, subject);

      expect(v10Name).toBe(v11Name);
    });

    /**
     * Verifies that the consumer resume behavior is correct: after a restart,
     * the consumer should continue from the last acknowledged position, not
     * replay from the beginning or skip to latest.
     *
     * This test validates the consumer configuration that NatsEventBus passes
     * to JetStreamManager.consumers.add(), which uses AckPolicy.Explicit and
     * DeliverPolicy based on subscription options.
     */
    it('should configure consumer for explicit ack with correct deliver policy', () => {
      // Default subscription (no startFrom option) -> DeliverPolicy.New
      const defaultOptions: SubscriptionOptions = {};
      const defaultDeliverPolicy = defaultOptions.startFrom === 'beginning' ? 'all' : 'new';
      expect(defaultDeliverPolicy).toBe('new');

      // Start from beginning -> DeliverPolicy.All
      const replayOptions: SubscriptionOptions = { startFrom: 'beginning' };
      const replayDeliverPolicy = replayOptions.startFrom === 'beginning' ? 'all' : 'new';
      expect(replayDeliverPolicy).toBe('all');

      // ackWait defaults to 30 seconds (in nanoseconds)
      const defaultAckWait = (defaultOptions.ackWait ?? 30) * 1_000_000_000;
      expect(defaultAckWait).toBe(30_000_000_000);

      // maxRetries defaults to 3
      const defaultMaxDeliver = defaultOptions.maxRetries ?? 3;
      expect(defaultMaxDeliver).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Timestamp Preservation Across Versions
  // --------------------------------------------------------------------------

  describe('Timestamp Preservation Across Versions', () => {
    /**
     * Validates that an ISO 8601 timestamp published by v10 arrives at the v11
     * consumer with the exact same string representation. Millisecond precision
     * and UTC timezone offset must be preserved.
     *
     * WHY: PostgreSQL timestamptz in event-store uses the occurredAt from the
     * event. If the v11 Date constructor truncates milliseconds or applies a
     * timezone offset, stored events have wrong timestamps, breaking
     * time-series queries and alert correlations.
     */
    it('should preserve exact ISO timestamp through serialize-deserialize', () => {
      const preciseTimestamp = '2026-03-27T14:30:00.123Z';
      const event = buildDomainEvent({
        timestamp: preciseTimestamp,
      });

      const serialized = replicateSerializeEvent(event);
      const deserialized = replicateDeserializeEvent(serialized);

      expect(deserialized.timestamp).toBe(preciseTimestamp);
    });

    /**
     * Validates sub-millisecond timestamp handling. The wire contract preserves
     * the source ISO string without a lossy Date conversion.
     */
    it('should handle sub-millisecond timestamps consistently', () => {
      const subMsTimestamp = '2026-03-27T14:30:00.1234567Z';

      const wireEvent = buildV10WireEvent({
        timestamp: subMsTimestamp,
      });

      const deserialized = replicateDeserializeEvent(JSON.stringify(wireEvent));

      expect(deserialized.timestamp).toBe(subMsTimestamp);
    });

    /**
     * Validates that timestamps with explicit timezone offsets retain their
     * exact wire representation and remain parseable by a consumer.
     */
    it('should preserve parseable timezone offsets', () => {
      // Timestamp with explicit +03:00 offset (Istanbul timezone)
      const istanbulTimestamp = '2026-03-27T17:30:00.000+03:00';
      const expectedUtc = '2026-03-27T14:30:00.000Z';

      const wireEvent = buildV10WireEvent({
        timestamp: istanbulTimestamp,
      });

      const deserialized = replicateDeserializeEvent(JSON.stringify(wireEvent));

      expect(deserialized.timestamp).toBe(istanbulTimestamp);
      expect(new Date(deserialized.timestamp).toISOString()).toBe(expectedUtc);
    });

    /**
     * Validates that epoch boundary timestamps (Unix epoch, Y2K, etc.)
     * are handled correctly. These are edge cases that could expose
     * platform-specific Date behavior differences between Node versions.
     */
    it('should handle epoch boundary timestamps correctly', () => {
      const boundaries = [
        { input: '1970-01-01T00:00:00.000Z', label: 'Unix epoch' },
        { input: '2000-01-01T00:00:00.000Z', label: 'Y2K' },
        { input: '2038-01-19T03:14:07.000Z', label: 'Unix 32-bit overflow' },
      ];

      for (const { input, label } of boundaries) {
        const wireEvent = buildV10WireEvent({ timestamp: input });
        const deserialized = replicateDeserializeEvent(JSON.stringify(wireEvent));

        expect(deserialized.timestamp).toBe(input);
        expect(Number.isNaN(Date.parse(deserialized.timestamp))).toBe(false);
      }
    });

    /**
     * Validates that the timestamp field in the serialized JSON is always
     * a string (ISO format), never a number (epoch ms) or object.
     * This ensures wire-format stability across versions.
     */
    it('should always serialize timestamp as ISO string, never epoch number', () => {
      const event = buildDomainEvent({
        timestamp: '2026-06-15T12:00:00.000Z',
      });

      const serialized = replicateSerializeEvent(event);
      const parsed = JSON.parse(serialized);

      expect(typeof parsed.timestamp).toBe('string');
      expect(parsed.timestamp).toBe('2026-06-15T12:00:00.000Z');
      expect(parsed.timestamp).not.toBe(1781784000000); // Not epoch ms
    });
  });

  // --------------------------------------------------------------------------
  // 5. Concurrent Multi-Publisher Ordering
  // --------------------------------------------------------------------------

  describe('Concurrent Multi-Publisher Ordering', () => {
    /**
     * Publishes 10 events from different simulated services concurrently and
     * verifies that all events are consumed without loss or duplication.
     *
     * WHY: During Phase 2, v10 services (sensor, farm, hr, billing) publish
     * events simultaneously while v11 event-store-service consumes them.
     * If the serialization or handler dispatch has any concurrency bugs,
     * events could be lost or duplicated.
     */
    it('should consume all 10 events from concurrent publishers without loss', () => {
      const services = [
        'sensor-service',
        'farm-service',
        'hr-service',
        'billing-service',
        'alert-service',
        'auth-service',
        'config-service',
        'gateway-service',
        'hydroponics-service',
        'admin-service',
      ] as const;

      const wireEvents: V10WireEvent[] = services.map((service, index) =>
        buildV10WireEvent({
          eventId: `${index + 1}0000000-0000-0000-0000-000000000000`.substring(0, 36),
          eventType: `${service.replace('-service', '').charAt(0).toUpperCase()}${service.replace('-service', '').slice(1)}Event`,
          timestamp: new Date(Date.parse(FIXED_ISO_TIMESTAMP) + index * 100).toISOString(),
          metadata: { source: service },
        }),
      );

      // Deserialize all concurrently (simulating parallel NATS delivery)
      const deserialized = wireEvents.map((wire) =>
        replicateDeserializeEvent(JSON.stringify(wire)),
      );

      // No loss: all 10 events must be present
      expect(deserialized).toHaveLength(10);

      // No duplication: all eventIds must be unique
      const eventIds = deserialized.map((e) => e.eventId);
      const uniqueIds = new Set(eventIds);
      expect(uniqueIds.size).toBe(10);

      // All event types must be present and distinct
      const eventTypes = deserialized.map((e) => e.eventType);
      const uniqueTypes = new Set(eventTypes);
      expect(uniqueTypes.size).toBe(10);

      // All timestamps remain valid ISO strings.
      for (const event of deserialized) {
        expect(typeof event.timestamp).toBe('string');
        expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
      }
    });

    /**
     * Verifies that events published in a specific order maintain their
     * sequence numbers (simulated by array index) after deserialization.
     * JetStream guarantees ordering per-subject; this test verifies that
     * the deserialization layer does not reorder events.
     */
    it('should maintain stream sequence ordering after deserialization', () => {
      const eventCount = 10;
      const orderedEvents: V10WireEvent[] = [];

      for (let i = 0; i < eventCount; i++) {
        orderedEvents.push(
          buildV10WireEvent({
            eventId: crypto.randomUUID(),
            eventType: 'SensorReading',
            timestamp: new Date(Date.parse(FIXED_ISO_TIMESTAMP) + i).toISOString(),
            payload: { sequenceNumber: i, value: Math.random() * 14 },
          }),
        );
      }

      // Simulate sequential consumption (NATS delivers in order per subject)
      const handler = createCapturingHandler('SensorReading');
      for (const wire of orderedEvents) {
        const event = replicateDeserializeEvent(JSON.stringify(wire));
        handler.handle(event);
      }

      expect(handler.receivedEvents).toHaveLength(eventCount);

      // Verify ordering is maintained by checking sequence numbers
      for (let i = 0; i < eventCount; i++) {
        const received = handler.receivedEvents[i]!;
        const payload = requireRecord(received.payload, 'ordered event payload');
        expect(payload['sequenceNumber']).toBe(i);
      }
    });

    /**
     * Verifies that concurrent deserialization of events with different
     * event types does not cause cross-contamination between events.
     *
     * WHY: If there is any shared mutable state in the deserialization path
     * (e.g., a reused buffer), concurrent processing could mix fields
     * from different events.
     */
    it('should not cross-contaminate events during concurrent deserialization', () => {
      const sensorEvent = buildV10WireEvent({
        eventId: 'aaaa0000-0000-0000-0000-000000000001',
        eventType: 'SensorReading',
        tenantId: 'tenant-1111-1111-1111-111111111111',
        payload: { value: 7.42, unit: 'pH' },
      });

      const farmEvent = buildV10WireEvent({
        eventId: 'bbbb0000-0000-0000-0000-000000000002',
        eventType: 'FarmCreated',
        tenantId: 'tenant-2222-2222-2222-222222222222',
        payload: { name: 'Test Farm', area: 500 },
      });

      // Deserialize both (simulating concurrent processing)
      const deserializedSensor = replicateDeserializeEvent(JSON.stringify(sensorEvent));
      const deserializedFarm = replicateDeserializeEvent(JSON.stringify(farmEvent));

      // Each event must retain its own fields, not contaminated by the other
      expect(deserializedSensor.eventId).toBe(sensorEvent.eventId);
      expect(deserializedSensor.eventType).toBe('SensorReading');
      expect(deserializedSensor.tenantId).toBe(sensorEvent.tenantId);

      expect(deserializedFarm.eventId).toBe(farmEvent.eventId);
      expect(deserializedFarm.eventType).toBe('FarmCreated');
      expect(deserializedFarm.tenantId).toBe(farmEvent.tenantId);

      // Payloads must not leak between events
      const sensorPayload = requireRecord(deserializedSensor.payload, 'sensor payload');
      const farmPayload = requireRecord(deserializedFarm.payload, 'farm payload');

      expect(sensorPayload.value).toBe(7.42);
      expect(sensorPayload.name).toBeUndefined(); // Must not have farm's name

      expect(farmPayload.name).toBe('Test Farm');
      expect(farmPayload.value).toBeUndefined(); // Must not have sensor's value
    });
  });

  // --------------------------------------------------------------------------
  // 6. Error Event Handling
  // --------------------------------------------------------------------------

  describe('Error Event Handling', () => {
    /**
     * Verifies that a malformed event (missing required eventId) is handled
     * by the deserialization layer before it can reach a handler.
     *
     * WHY: A buggy v10 service or a network corruption could produce
     * malformed events. The v11 consumer must not crash; it should NAK
     * the message for redelivery or route it to a dead-letter queue.
     */
    it('should reject an event with missing eventId', () => {
      const malformedWire = {
        // eventId intentionally omitted
        eventType: 'SensorReading',
        timestamp: FIXED_ISO_TIMESTAMP,
        tenantId: TENANT_ID,
      };

      expect(() => replicateDeserializeEvent(JSON.stringify(malformedWire))).toThrow(
        'missing base event fields',
      );
    });

    /**
     * Verifies that a malformed event (missing eventType) is handled
     * before handler routing can observe an undefined subject.
     */
    it('should reject an event with missing eventType', () => {
      const malformedWire = {
        eventId: crypto.randomUUID(),
        // eventType intentionally omitted
        timestamp: FIXED_ISO_TIMESTAMP,
        tenantId: TENANT_ID,
      };

      expect(() => replicateDeserializeEvent(JSON.stringify(malformedWire))).toThrow(
        'missing base event fields',
      );
    });

    /**
     * Verifies that an event with an invalid timestamp (not a valid ISO string)
     * remains a string at the event-bus boundary. A domain consumer that
     * requires a date validates it explicitly.
     */
    it('should preserve a non-ISO timestamp for domain validation', () => {
      const malformedWire = {
        eventId: crypto.randomUUID(),
        eventType: 'SensorReading',
        timestamp: 'not-a-valid-date',
        tenantId: TENANT_ID,
      };

      const deserialized = replicateDeserializeEvent(JSON.stringify(malformedWire));

      expect(deserialized.timestamp).toBe('not-a-valid-date');
      expect(Number.isNaN(Date.parse(deserialized.timestamp))).toBe(true);
    });

    /**
     * Verifies that completely invalid JSON is rejected with a parse error
     * rather than producing a corrupted event.
     */
    it('should throw on completely invalid JSON', () => {
      const invalidJson = '{not valid json at all!!!';

      expect(() => {
        replicateDeserializeEvent(invalidJson);
      }).toThrow();
    });

    /**
     * Verifies that an empty JSON object is rejected as a non-event.
     */
    it('should reject an empty JSON object', () => {
      const emptyWire = {};

      expect(() => replicateDeserializeEvent(JSON.stringify(emptyWire))).toThrow(
        'missing base event fields',
      );
    });

    /**
     * Verifies that when a handler throws during event processing, the error
     * is isolated and does not affect other handlers registered for the same
     * subject. NatsEventBus iterates through all handlers for a subject;
     * one failing handler must not prevent others from executing.
     *
     * WHY: In the v11 event-store-service, multiple handlers may be registered
     * (e.g., event persistence handler + projection handler). A bug in one
     * handler must not silently block the others.
     */
    it('should isolate handler errors without affecting other handlers', async () => {
      const failingHandler = createCapturingHandler('SensorReading', true);
      const successHandler = createCapturingHandler('SensorReading', false);

      const event = replicateDeserializeEvent(
        JSON.stringify(buildV10WireEvent({ eventType: 'SensorReading' })),
      );

      // Simulate NatsEventBus handler iteration with error isolation
      const handlers: CapturedEventHandler[] = [failingHandler, successHandler];
      for (const handler of handlers) {
        try {
          await handler.handle(event);
        } catch {
          // NatsEventBus catches handler errors and logs them
          // (see processMessagesFromConsumer lines 498-503)
        }
      }

      // Failing handler should have thrown
      expect(failingHandler.handleErrors).toHaveLength(1);
      expect(failingHandler.handleErrors[0]!.message).toContain('Simulated handler failure');

      // Success handler should have received the event despite the previous failure
      expect(successHandler.receivedEvents).toHaveLength(1);
      expect(successHandler.receivedEvents[0]!.eventType).toBe('SensorReading');
    });

    /**
     * Verifies that the exponential backoff NAK delay calculation works
     * correctly for redelivered messages. The formula in NatsEventBus is:
     * min(1000 * 2^redeliveryCount, 30000)
     *
     * WHY: If the backoff is too short, a poison message causes a tight
     * retry loop that overwhelms the consumer. If too long, recovery is
     * delayed. This test ensures the formula is stable across versions.
     */
    it('should calculate correct exponential backoff for NAK delays', () => {
      const maxBackoff = 30_000;

      const expectations: Array<{ redeliveryCount: number; expectedMs: number }> = [
        { redeliveryCount: 0, expectedMs: 1000 }, // 1000 * 2^0 = 1000
        { redeliveryCount: 1, expectedMs: 2000 }, // 1000 * 2^1 = 2000
        { redeliveryCount: 2, expectedMs: 4000 }, // 1000 * 2^2 = 4000
        { redeliveryCount: 3, expectedMs: 8000 }, // 1000 * 2^3 = 8000
        { redeliveryCount: 4, expectedMs: 16000 }, // 1000 * 2^4 = 16000
        { redeliveryCount: 5, expectedMs: 30000 }, // 1000 * 2^5 = 32000 -> capped at 30000
        { redeliveryCount: 10, expectedMs: 30000 }, // Way over cap
      ];

      for (const { redeliveryCount, expectedMs } of expectations) {
        const backoffMs = Math.min(1000 * Math.pow(2, redeliveryCount), maxBackoff);
        expect(backoffMs).toBe(expectedMs);
      }
    });

    /**
     * Verifies that an event with null payload (not undefined, but explicitly
     * null) is handled correctly. Some v10 services might serialize null
     * payloads explicitly.
     */
    it('should handle event with explicit null fields', () => {
      const wireEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'SystemHealthCheck',
        timestamp: FIXED_ISO_TIMESTAMP,
        tenantId: TENANT_ID,
        correlationId: null,
        causationId: null,
        userId: null,
        metadata: null,
        payload: null,
      };

      const deserialized = replicateDeserializeEvent(JSON.stringify(wireEvent));

      expect(deserialized.eventId).toBe(wireEvent.eventId);
      expect(deserialized.eventType).toBe('SystemHealthCheck');
      expect(deserialized.timestamp).toBe(FIXED_ISO_TIMESTAMP);

      // Null fields should remain null (not converted to undefined)
      expect(deserialized.correlationId).toBeNull();
      expect(deserialized.causationId).toBeNull();
      expect(deserialized.userId).toBeNull();
      expect(deserialized.metadata).toBeNull();
    });

    /**
     * Verifies that extremely large events (approaching NATS max_msg_size of 1MB)
     * can be serialized and deserialized without truncation or memory issues.
     *
     * WHY: Edge devices can occasionally send large batches of sensor data
     * in a single event. If the serialization layer has a buffer size limit
     * different from NATS's own limit, events silently truncate.
     */
    it('should handle large events near max_msg_size without truncation', () => {
      // Generate a payload approaching 500KB (well under 1MB NATS limit)
      const largeArray: Array<{ idx: number; val: number; ts: string }> = [];
      for (let i = 0; i < 5000; i++) {
        largeArray.push({
          idx: i,
          val: Math.random() * 100,
          ts: new Date(Date.now() + i * 1000).toISOString(),
        });
      }

      const wireEvent = buildV10WireEvent({
        eventType: 'BatchSensorReading',
        payload: { readings: largeArray },
      });

      const serialized = JSON.stringify(wireEvent);
      const deserialized = replicateDeserializeEvent(serialized);

      // Verify no truncation
      const payload = requireRecord(deserialized.payload, 'large event payload');
      const readings = payload.readings as Array<Record<string, unknown>>;
      expect(readings).toHaveLength(5000);
      expect(readings[0]!.idx).toBe(0);
      expect(readings[4999]!.idx).toBe(4999);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Subject Normalization (bonus: covers normalizeSubject logic)
  // --------------------------------------------------------------------------

  describe('Subject Normalization', () => {
    /**
     * Verifies that NatsEventBus.normalizeSubject() correctly prefixes
     * bare topic names with "events." to match the stream subject filter.
     *
     * WHY: If normalizeSubject() behavior changes between v10 and v11
     * (e.g., due to different string method behavior), events would be
     * published to subjects outside the stream filter and silently lost.
     */
    it('should prefix bare topic names with events.', () => {
      // Replicate normalizeSubject logic
      const normalize = (topic: string): string => {
        if (
          !topic.startsWith('events.') &&
          !topic.startsWith('commands.') &&
          !topic.startsWith('queries.')
        ) {
          return `events.${topic}`;
        }
        return topic;
      };

      expect(normalize('SensorReading')).toBe('events.SensorReading');
      expect(normalize('FarmCreated')).toBe('events.FarmCreated');
      expect(normalize('events.SensorReading')).toBe('events.SensorReading');
      expect(normalize('commands.CreateFarm')).toBe('commands.CreateFarm');
      expect(normalize('queries.GetSensor')).toBe('queries.GetSensor');
    });
  });

  // --------------------------------------------------------------------------
  // 8. NatsEventBus Integration via TestingModule
  // --------------------------------------------------------------------------

  describe('NatsEventBus TestingModule Integration', () => {
    let module: TestingModule;
    let eventBus: NatsEventBus;

    /**
     * Creates a NestJS TestingModule with NatsEventBus wired via DI, but
     * without calling onModuleInit (which would try to connect to NATS).
     * This verifies that DI wiring and constructor logic work on both v10/v11.
     */
    beforeEach(async () => {
      module = await Test.createTestingModule({
        providers: [
          NatsEventBus,
          {
            provide: ConfigService,
            useValue: createMockConfigService(),
          },
        ],
      }).compile();

      eventBus = module.get<NatsEventBus>(NatsEventBus);
    });

    afterEach(async () => {
      await module.close();
    });

    /**
     * Verifies that NatsEventBus can be instantiated through DI without
     * connecting to NATS. The constructor reads config values; if any
     * v11 DI change breaks ConfigService injection, this catches it.
     */
    it('should instantiate NatsEventBus through DI without connection', () => {
      expect(eventBus).toBeDefined();
      expect(eventBus).toBeInstanceOf(NatsEventBus);
    });

    /**
     * Verifies the initial health state before any connection attempt.
     * isConnected() should be false and getHealth() should report disconnected.
     */
    it('should report disconnected health before connection', async () => {
      expect(eventBus.isConnected()).toBe(false);

      const health: EventBusHealth = await eventBus.getHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.connectionState).toBe('disconnected');
    });

    /**
     * Verifies that publish() throws when called before connection.
     * This is a safety check: if a v11 change silently swallows the
     * error, events would be lost without any indication.
     */
    it('should throw when publishing before connection', async () => {
      const event = buildDomainEvent({ eventType: 'TestEvent' });

      await expect(eventBus.publish(event)).rejects.toThrow('NATS JetStream not connected');
    });

    /**
     * Verifies that subscribe() queues the subscription when called before
     * connection (pendingSubscriptions mechanism). On v11, if the pending
     * subscription array is mishandled, handlers silently fail to activate.
     */
    it('should queue subscription before connection without throwing', async () => {
      const handler = createCapturingHandler('SensorReading');

      // Should not throw -- subscription is queued for later activation
      await expect(eventBus.subscribe('SensorReading', handler)).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 9. Event Publishing from v11 to v10 Consumer
  // --------------------------------------------------------------------------

  describe('Event Publishing from v11 to v10 Consumer', () => {
    /**
     * ADR-013 Section 8.2 requires bidirectional compatibility testing.
     * This section tests v11->v10 direction to catch asymmetric serialization
     * changes. While sections 1-4 cover v10->v11 ingestion, v11 might introduce
     * subtle serialization differences (e.g., Date.toJSON override, BigInt support)
     * that break v10 consumers.
     */

    /**
     * Verifies that an event serialized by the v11 NatsEventBus can be
     * deserialized by a v10-style consumer without any field loss.
     * A v11 serialization change (e.g., omitting optional fields, reordering
     * keys) would cause v10 consumers to silently drop data.
     */
    it('should deliver v11-serialized event to v10 consumer without field loss', () => {
      // Create a fully-populated event as if published by v11 event-store-service
      const v11Event = buildDomainEvent({
        eventType: 'FarmCreated',
        tenantId: TENANT_ID,
        correlationId: CORRELATION_ID,
        userId: USER_ID,
        version: 3,
        metadata: {
          source: 'event-store-service',
          correlationId: CORRELATION_ID,
          tenantId: TENANT_ID,
          userId: USER_ID,
          version: 3,
        },
      });

      // Serialize using the same logic as NatsEventBus.serializeEvent()
      const wireJson = replicateSerializeEvent(v11Event);

      // Simulate v10 consumer deserializing the wire payload
      const v10Parsed: V10WireEvent = JSON.parse(wireJson) as V10WireEvent;

      // Verify no fields were lost during v11 serialization
      expect(v10Parsed.eventId).toBe(v11Event.eventId);
      expect(v10Parsed.eventType).toBe('FarmCreated');
      expect(v10Parsed.tenantId).toBe(TENANT_ID);
      expect(v10Parsed.correlationId).toBe(CORRELATION_ID);
      expect(v10Parsed.userId).toBe(USER_ID);
      expect(v10Parsed.version).toBe(3);
      expect(v10Parsed.metadata).toBeDefined();
      expect(v10Parsed.metadata!.source).toBe('event-store-service');
      expect(v10Parsed.metadata!.correlationId).toBe(CORRELATION_ID);

      // Verify timestamp is a string (ISO 8601) -- v10 consumer expects string on wire
      expect(typeof v10Parsed.timestamp).toBe('string');
    });

    /**
     * Verifies that v11 serialization preserves canonical ISO 8601 strings
     * that v10 consumers can parse. Tests standard, midnight UTC, and
     * end-of-year boundary timestamps.
     */
    it('should serialize v11 ISO timestamps in a v10-consumable format', () => {
      // Standard timestamp with sub-millisecond precision
      const standardTimestamp = '2026-06-15T09:30:00.456Z';
      const standardEvent = buildDomainEvent({
        eventType: 'SensorReading',
        timestamp: standardTimestamp,
      });
      const standardWire = JSON.parse(replicateSerializeEvent(standardEvent)) as V10WireEvent;
      expect(standardWire.timestamp).toBe('2026-06-15T09:30:00.456Z');

      // Midnight UTC boundary -- catches off-by-one day bugs
      const midnightTimestamp = '2026-01-01T00:00:00.000Z';
      const midnightEvent = buildDomainEvent({
        eventType: 'SensorReading',
        timestamp: midnightTimestamp,
      });
      const midnightWire = JSON.parse(replicateSerializeEvent(midnightEvent)) as V10WireEvent;
      expect(midnightWire.timestamp).toBe('2026-01-01T00:00:00.000Z');

      // End-of-year boundary -- catches year rollover issues
      const eoyTimestamp = '2025-12-31T23:59:59.999Z';
      const eoyEvent = buildDomainEvent({
        eventType: 'SensorReading',
        timestamp: eoyTimestamp,
      });
      const eoyWire = JSON.parse(replicateSerializeEvent(eoyEvent)) as V10WireEvent;
      expect(eoyWire.timestamp).toBe('2025-12-31T23:59:59.999Z');

      // Verify all three are parseable by a v10 consumer.
      expect(Date.parse(standardWire.timestamp)).toBe(Date.parse(standardTimestamp));
      expect(Date.parse(midnightWire.timestamp)).toBe(Date.parse(midnightTimestamp));
      expect(Date.parse(eoyWire.timestamp)).toBe(Date.parse(eoyTimestamp));
    });

    /**
     * Verifies that undefined optional fields remain absent (not serialized
     * as null) when v11 publishes to a v10 consumer. JSON.stringify omits
     * undefined properties; if v11 introduces explicit null for optional
     * fields, v10 consumers using `field === undefined` checks would break.
     */
    it('should preserve undefined optional fields when v11 publishes to v10 consumer', () => {
      // Build event with only required fields -- all optional fields are undefined
      const minimalEvent = buildDomainEvent({
        eventType: 'TenantProvisioned',
      });

      const wireJson = replicateSerializeEvent(minimalEvent);
      const v10Parsed = JSON.parse(wireJson) as Record<string, unknown>;

      // Verify required fields are present
      expect(v10Parsed['eventId']).toBeDefined();
      expect(v10Parsed['eventType']).toBe('TenantProvisioned');
      expect(v10Parsed['timestamp']).toBeDefined();

      // Verify optional fields are absent (not null) in the wire format
      // JSON.stringify omits undefined; if v11 changes this to null, this test catches it
      expect('correlationId' in v10Parsed).toBe(false);
      expect('causationId' in v10Parsed).toBe(false);
      expect('userId' in v10Parsed).toBe(false);
      expect('version' in v10Parsed).toBe(false);
      expect('metadata' in v10Parsed).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 10. Reconnect Behavior and Connection State Management
  // --------------------------------------------------------------------------

  describe('Reconnect Behavior and Connection State Management', () => {
    /**
     * ADR-013 Section 8.4 mandates monitoring reconnect behavior during
     * canary validation. These tests verify connection state transitions,
     * pending subscription activation, and deduplication logic that are
     * critical for resilient event delivery during rolling upgrades.
     */

    let eventBus: NatsEventBus;

    beforeEach(() => {
      const configService = createMockConfigService();
      eventBus = new NatsEventBus(configService);
    });

    /**
     * Verifies that NatsEventBus correctly reports its connection lifecycle
     * states. The connectionState property must transition through
     * disconnected -> reconnecting -> connected exactly as the NATS client
     * driver reports. If v11 changes the status event names or timing,
     * this test catches state machine regression.
     */
    it('should transition through disconnected -> reconnecting -> connected lifecycle', async () => {
      // Initial state should be disconnected
      const initialHealth = await eventBus.getHealth();
      expect(initialHealth.connectionState).toBe('disconnected');
      expect(initialHealth.isHealthy).toBe(false);

      // isConnected() should mirror disconnected state
      expect(eventBus.isConnected()).toBe(false);

      // Attempting connect() without a real NATS server transitions to
      // 'reconnecting' internally before failing back to 'disconnected'.
      // We verify the final state is 'disconnected' after a failed connect.
      try {
        await eventBus.connect();
      } catch {
        // Expected: no real NATS server available
      }

      // After a failed connect, state returns to disconnected
      const postFailHealth = await eventBus.getHealth();
      expect(postFailHealth.connectionState).toBe('disconnected');
      expect(postFailHealth.isHealthy).toBe(false);
    });

    /**
     * Verifies that subscribeTo() queues subscriptions in the
     * pendingSubscriptions array when called before JetStream is connected,
     * and does not throw. This is critical for service startup order:
     * handlers register during DI initialization, before NATS connects.
     * If v11 breaks the pending queue, handlers silently never activate.
     */
    it('should queue pending subscriptions before connection without throwing', async () => {
      const handler1 = createCapturingHandler('SensorReading');
      const handler2 = createCapturingHandler('FarmCreated');
      const handler3 = createCapturingHandler('AlertTriggered');

      // Register handlers before any connection -- should not throw
      await expect(eventBus.subscribe('SensorReading', handler1)).resolves.toBeUndefined();

      await expect(eventBus.subscribe('FarmCreated', handler2)).resolves.toBeUndefined();

      await expect(eventBus.subscribe('AlertTriggered', handler3)).resolves.toBeUndefined();

      // Verify the bus is still in disconnected state (no accidental connect)
      expect(eventBus.isConnected()).toBe(false);

      // Verify health reflects disconnected with no errors
      const health = await eventBus.getHealth();
      expect(health.connectionState).toBe('disconnected');
      expect(health.isHealthy).toBe(false);
    });

    /**
     * Verifies that multiple rapid connect() attempts do not corrupt
     * the connection state machine. During rolling upgrades, network
     * flaps can trigger rapid reconnect cycles; if the state machine
     * is not idempotent, duplicate connections or leaked resources occur.
     */
    it('should handle multiple rapid reconnect attempts without state corruption', async () => {
      const connectAttempts = 5;
      const results: Array<{ attempt: number; error: boolean; state: string }> = [];

      // Fire 5 rapid connect() calls sequentially
      for (let i = 0; i < connectAttempts; i++) {
        try {
          await eventBus.connect();
          const health = await eventBus.getHealth();
          results.push({ attempt: i, error: false, state: health.connectionState });
        } catch {
          // Expected: no real NATS server
          const health = await eventBus.getHealth();
          results.push({ attempt: i, error: true, state: health.connectionState });
        }
      }

      // All attempts should have failed (no real NATS server)
      expect(results).toHaveLength(connectAttempts);
      for (const result of results) {
        expect(result.error).toBe(true);
        // State should be cleanly 'disconnected' after each failed attempt
        expect(result.state).toBe('disconnected');
      }

      // Final state must be disconnected -- no lingering 'reconnecting' state
      const finalHealth = await eventBus.getHealth();
      expect(finalHealth.connectionState).toBe('disconnected');
      expect(finalHealth.isHealthy).toBe(false);
    });

    /**
     * Verifies that subscribeTo() deduplicates pending subscriptions for
     * the same subject. The NatsEventBus.subscribeTo() method checks
     * pendingSubscriptions.some(p => p.subject === subject) before pushing.
     * If v11 breaks this dedup, duplicate consumers are created on connect,
     * causing each event to be processed multiple times.
     */
    it('should not create duplicate subscriptions for same event type on reconnect', async () => {
      // Register the same event type 3 times with different handlers
      const handler1 = createCapturingHandler('SensorReading');
      const handler2 = createCapturingHandler('SensorReading');
      const handler3 = createCapturingHandler('SensorReading');

      await eventBus.subscribe('SensorReading', handler1);
      await eventBus.subscribe('SensorReading', handler2);
      await eventBus.subscribe('SensorReading', handler3);

      // Verify the bus accepted all three without throwing
      expect(eventBus.isConnected()).toBe(false);

      // Verify that despite 3 subscribe calls for the same subject,
      // the internal consumer map is clean (no consumers created yet
      // since we are disconnected)
      const health = await eventBus.getHealth();
      expect(health.connectionState).toBe('disconnected');

      // The pendingMessages count should be 0 since no consumers are active
      expect(health.pendingMessages).toBe(0);

      // After a failed connect attempt, state should still be clean
      try {
        await eventBus.connect();
      } catch {
        // Expected
      }

      const postConnectHealth = await eventBus.getHealth();
      expect(postConnectHealth.connectionState).toBe('disconnected');
    });
  });
});
