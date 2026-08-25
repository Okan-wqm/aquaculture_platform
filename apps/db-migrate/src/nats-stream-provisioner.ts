import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import {
  DiscardPolicy,
  JetStreamApiCodes,
  RetentionPolicy,
  StorageType,
  jetstreamManager,
  type JetStreamManager,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import {
  buildCanonicalStreamRoutes,
  DEFAULT_NATS_STREAM_NAME,
  type StreamRoute,
} from '@platform/event-bus';

export interface ProvisionerStreamApi {
  info(name: string): Promise<{ config: Record<string, unknown> }>;
  add(config: DesiredStreamConfig): Promise<unknown>;
  update(name: string, config: DesiredStreamConfig): Promise<unknown>;
}

export interface DesiredStreamConfig extends Record<string, unknown> {
  name: string;
  subjects: string[];
  retention: RetentionPolicy;
  storage: StorageType;
  max_consumers: number;
  max_msgs: number;
  max_msgs_per_subject: number;
  max_bytes: number;
  max_age: number;
  max_msg_size: number;
  discard: DiscardPolicy;
  duplicate_window: number;
  num_replicas: number;
}

const CONFIG_KEYS: ReadonlyArray<keyof DesiredStreamConfig> = [
  'name',
  'subjects',
  'retention',
  'storage',
  'max_consumers',
  'max_msgs',
  'max_msgs_per_subject',
  'max_bytes',
  'max_age',
  'max_msg_size',
  'discard',
  'duplicate_window',
  'num_replicas',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStreamNotFound(error: unknown): boolean {
  return (
    isRecord(error) && error['status'] === 404 && error['code'] === JetStreamApiCodes.StreamNotFound
  );
}

function configMatches(current: Record<string, unknown>, desired: DesiredStreamConfig): boolean {
  return CONFIG_KEYS.every((key) => JSON.stringify(current[key]) === JSON.stringify(desired[key]));
}

export function desiredStreamConfig(route: StreamRoute, replicas: number): DesiredStreamConfig {
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 5) {
    throw new Error(`NATS_STREAM_REPLICAS must be an integer from 1 to 5, got ${replicas}`);
  }

  return {
    name: route.streamName,
    subjects: [...route.subjects],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_consumers: -1,
    max_msgs: route.maxMessages,
    max_msgs_per_subject: -1,
    max_bytes: route.maxBytes,
    max_age: route.maxAgeNanos,
    max_msg_size: 1024 * 1024,
    discard: route.discard,
    duplicate_window: 2 * 60 * 1_000_000_000,
    num_replicas: replicas,
  };
}

export async function reconcileNatsStreams(
  streams: ProvisionerStreamApi,
  routes: readonly StreamRoute[],
  replicas: number,
): Promise<void> {
  for (const route of routes) {
    const desired = desiredStreamConfig(route, replicas);
    try {
      const current = await streams.info(route.streamName);
      if (!configMatches(current.config, desired)) {
        await streams.update(route.streamName, desired);
      }
    } catch (error: unknown) {
      if (!isStreamNotFound(error)) {
        throw error;
      }
      await streams.add(desired);
    }
  }
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer, got ${String(raw)}`);
  }
  return value;
}

export function effectiveStreamReplicas(
  serverInfo: Readonly<{ cluster?: string }> | undefined,
  requestedReplicas: number,
): number {
  if (serverInfo === undefined) {
    throw new Error('NATS server topology info is unavailable');
  }
  return serverInfo.cluster === undefined ? 1 : requestedReplicas;
}

export async function provisionNatsStreams(): Promise<void> {
  const connection: NatsConnection = await connect(
    buildNatsConnectionOptions('nats-stream-provisioner'),
  );
  try {
    const manager: JetStreamManager = await jetstreamManager(connection);
    const requestedReplicas = parsePositiveInteger(
      process.env['NATS_STREAM_REPLICAS'],
      1,
      'NATS_STREAM_REPLICAS',
    );
    const effectiveReplicas = effectiveStreamReplicas(connection.info, requestedReplicas);
    const routes = buildCanonicalStreamRoutes({
      eventsStreamName: process.env['NATS_STREAM_NAME'] ?? DEFAULT_NATS_STREAM_NAME,
      telemetryEventsPerSecond: parsePositiveInteger(
        process.env['NATS_TELEMETRY_EVENTS_PER_SECOND'],
        2_000,
        'NATS_TELEMETRY_EVENTS_PER_SECOND',
      ),
      telemetryStoredEventP99Bytes: parsePositiveInteger(
        process.env['NATS_TELEMETRY_STORED_EVENT_P99_BYTES'],
        1_024,
        'NATS_TELEMETRY_STORED_EVENT_P99_BYTES',
      ),
    });
    await reconcileNatsStreams(manager.streams, routes, effectiveReplicas);
  } finally {
    await connection.drain();
  }
}
