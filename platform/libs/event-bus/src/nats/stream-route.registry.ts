import { DiscardPolicy } from '@nats-io/jetstream';

export interface StreamRoute {
  streamName: string;
  roots: readonly string[];
  subjects: readonly string[];
  maxAgeNanos: number;
  maxBytes: number;
  maxMessages: number;
  discard: DiscardPolicy;
}

interface StreamRouteSizingInput {
  eventsStreamName: string;
  telemetryEventsPerSecond: number;
  telemetryStoredEventP99Bytes: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function buildCanonicalStreamRoutes(input: StreamRouteSizingInput): readonly StreamRoute[] {
  const eventsPerSecond = positiveInteger(
    input.telemetryEventsPerSecond,
    'telemetryEventsPerSecond',
  );
  const storedEventBytes = positiveInteger(
    input.telemetryStoredEventP99Bytes,
    'telemetryStoredEventP99Bytes',
  );
  const telemetryMaxMessages = Math.ceil(eventsPerSecond * 3_600 * 1.2);
  const telemetryMaxBytes = Math.ceil(eventsPerSecond * storedEventBytes * 3_600 * 1.2);

  return [
    {
      streamName: input.eventsStreamName,
      roots: ['events', 'commands', 'queries'],
      subjects: ['events.>', 'commands.>', 'queries.>'],
      maxAgeNanos: 7 * 24 * 60 * 60 * 1_000_000_000,
      maxBytes: 1536 * 1024 * 1024,
      maxMessages: 1_000_000,
      discard: DiscardPolicy.Old,
    },
    {
      streamName: 'AQUACULTURE_TELEMETRY',
      roots: ['telemetry'],
      subjects: ['telemetry.>'],
      maxAgeNanos: 90 * 60 * 1_000_000_000,
      maxBytes: telemetryMaxBytes,
      maxMessages: telemetryMaxMessages,
      discard: DiscardPolicy.New,
    },
    {
      streamName: 'AQUACULTURE_DLQ',
      roots: ['dlq'],
      subjects: ['dlq.>'],
      maxAgeNanos: 72 * 60 * 60 * 1_000_000_000,
      maxBytes: 1024 * 1024 * 1024,
      maxMessages: 1_000_000,
      discard: DiscardPolicy.New,
    },
    {
      streamName: 'AQUACULTURE_QUARANTINE',
      roots: ['quarantine'],
      subjects: ['quarantine.mqtt'],
      maxAgeNanos: 24 * 60 * 60 * 1_000_000_000,
      maxBytes: 512 * 1024 * 1024,
      maxMessages: 500_000,
      discard: DiscardPolicy.New,
    },
  ];
}

export function resolveStreamRoute(routes: readonly StreamRoute[], subject: string): StreamRoute {
  const separator = subject.indexOf('.');
  const root = separator === -1 ? subject : subject.slice(0, separator);
  const route = routes.find((candidate) => candidate.roots.includes(root));
  if (route === undefined) {
    throw new Error(`Unknown NATS subject root: ${JSON.stringify(root)}`);
  }
  return route;
}

export function requiredFileStoreBytes(routes: readonly StreamRoute[]): number {
  return Math.ceil(routes.reduce((total, route) => total + route.maxBytes, 0) * 1.25);
}
