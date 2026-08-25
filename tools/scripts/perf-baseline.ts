#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit, hrtime, stderr, stdout } from 'node:process';

import { connect, type IClientPublishOptions, type MqttClient } from 'mqtt';

type ProfileName = 'sustained' | 'stress';

interface CapacityProfile {
  readonly rate: number;
  readonly duration: number;
}

const CAPACITY_PROFILES: Readonly<Record<ProfileName, CapacityProfile>> = {
  sustained: { rate: 2_000, duration: 30 * 60 },
  stress: { rate: 15_000, duration: 5 * 60 },
};

const TARGET_PAYLOAD_BYTES = 650;

interface Args {
  broker: string;
  profile: ProfileName;
  tenants: number;
  sensorsPerTenant: number;
  channelsPerSensor: number;
  rate: number;
  duration: number;
  metricsUrl: string | null;
  output: string;
  qos: 0 | 1;
  clientId: string;
  runId: string;
  workerCount: number;
  workerIndex: number;
  dryRun: boolean;
}

function failArgument(message: string): never {
  stderr.write(`[perf-baseline] ${message}\n`);
  exit(2);
}

function positiveInteger(map: Map<string, string>, key: string, fallback: number): number {
  const raw = map.get(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    failArgument(`--${key} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function parseArgs(): Args {
  const map = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      failArgument(`unrecognised arg pair near index ${index}: ${key} ${value}`);
    }
    map.set(key.slice(2), value);
  }

  if (map.has('rate') || map.has('duration') || map.has('burst-factor') || map.has('burst-secs')) {
    failArgument(
      'profile envelope is locked; use --profile sustained (2K x 30m) or stress (15K x 5m)',
    );
  }

  const profileValue = map.get('profile') ?? 'sustained';
  if (profileValue !== 'sustained' && profileValue !== 'stress') {
    failArgument(`--profile must be sustained or stress, got '${profileValue}'`);
  }
  const profile: ProfileName = profileValue;
  const envelope = CAPACITY_PROFILES[profile];
  const qosValue = positiveInteger(map, 'qos', 1);
  if (qosValue !== 1) {
    failArgument('official readiness profiles require QoS 1');
  }

  const workerCount = positiveInteger(map, 'worker-count', 1);
  const workerIndexRaw = map.get('worker-index') ?? '0';
  const workerIndex = Number(workerIndexRaw);
  if (!Number.isSafeInteger(workerIndex) || workerIndex < 0 || workerIndex >= workerCount) {
    failArgument(`--worker-index must be in [0, ${workerCount - 1}], got '${workerIndexRaw}'`);
  }
  if (envelope.rate % workerCount !== 0) {
    failArgument(`profile rate ${envelope.rate} must divide evenly across ${workerCount} workers`);
  }

  const runId = map.get('run-id') ?? randomUUID();
  if (workerCount > 1 && !map.has('run-id')) {
    failArgument('multi-process runs require the same explicit --run-id on every worker');
  }

  return {
    broker: map.get('broker') ?? 'mqtt://localhost:1883',
    profile,
    tenants: positiveInteger(map, 'tenants', 100),
    sensorsPerTenant: positiveInteger(map, 'sensors-per-tenant', 200),
    channelsPerSensor: positiveInteger(map, 'channels-per-sensor', 10),
    rate: envelope.rate,
    duration: envelope.duration,
    metricsUrl: map.get('metrics-url') ?? null,
    output:
      map.get('output') ??
      `docs/perf/runs/100-tenant-${profile}-worker-${workerIndex}-${Date.now()}.json`,
    qos: qosValue,
    clientId:
      map.get('client-id') ?? `capacity-${profile}-${workerIndex}-${randomUUID().slice(0, 8)}`,
    runId,
    workerCount,
    workerIndex,
    dryRun: map.get('dry-run') === 'true',
  };
}

interface Routing {
  tenants: string[];
  sensorIds: string[][];
  channelIds: string[][][];
}

function uuidFromSeed(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

function buildRouting(args: Args): Routing {
  const tenants: string[] = [];
  const sensorIds: string[][] = [];
  const channelIds: string[][][] = [];
  for (let tenantIndex = 0; tenantIndex < args.tenants; tenantIndex += 1) {
    tenants.push(uuidFromSeed(`tenant-${tenantIndex}`));
    const sensors: string[] = [];
    const sensorChannels: string[][] = [];
    for (let sensorIndex = 0; sensorIndex < args.sensorsPerTenant; sensorIndex += 1) {
      sensors.push(uuidFromSeed(`sensor-${tenantIndex}-${sensorIndex}`));
      const channels: string[] = [];
      for (let channelIndex = 0; channelIndex < args.channelsPerSensor; channelIndex += 1) {
        channels.push(uuidFromSeed(`channel-${tenantIndex}-${sensorIndex}-${channelIndex}`));
      }
      sensorChannels.push(channels);
    }
    sensorIds.push(sensors);
    channelIds.push(sensorChannels);
  }
  return { tenants, sensorIds, channelIds };
}

function buildSampleRouting(): Routing {
  return {
    tenants: [uuidFromSeed('tenant-0')],
    sensorIds: [[uuidFromSeed('sensor-0-0')]],
    channelIds: [[[uuidFromSeed('channel-0-0-0')]]],
  };
}

function sourceEventId(runId: string, globalSequence: number): string {
  const runHex = runId.replaceAll('-', '').slice(0, 16).padEnd(16, '0');
  const sequenceHex = globalSequence.toString(16).padStart(16, '0');
  const hex = `${runHex}${sequenceHex}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

interface PickedRoute {
  tenantIndex: number;
  sensorIndex: number;
  channelIndex: number;
}

function pickRoute(routing: Routing, args: Args, globalSequence: number): PickedRoute {
  return {
    tenantIndex: globalSequence % routing.tenants.length,
    sensorIndex: Math.floor(globalSequence / args.tenants) % args.sensorsPerTenant,
    channelIndex:
      Math.floor(globalSequence / (args.tenants * args.sensorsPerTenant)) % args.channelsPerSensor,
  };
}

interface TelemetryPayload {
  tenantId: string;
  sensorId: string;
  channelId: string;
  value: number;
  quality: number;
  sourceEventId: string;
  sourceTimestamp: string;
  sourceSequence: number;
  padding: string;
}

interface GeneratedMessage {
  topic: string;
  payload: TelemetryPayload;
  encodedPayload: string;
  payloadBytes: number;
  mqttWireBytes: number;
  tenantIndex: number;
}

function mqttRemainingLengthBytes(value: number): number {
  let remaining = value;
  let bytes = 0;
  do {
    bytes += 1;
    remaining = Math.floor(remaining / 128);
  } while (remaining > 0);
  return bytes;
}

function mqttPublishWireBytes(topic: string, payloadBytes: number, qos: 0 | 1): number {
  const topicBytes = Buffer.byteLength(topic);
  const remainingLength = 2 + topicBytes + (qos === 1 ? 2 : 0) + payloadBytes;
  return 1 + mqttRemainingLengthBytes(remainingLength) + remainingLength;
}

function generateMessage(routing: Routing, args: Args, localSequence: number): GeneratedMessage {
  const globalSequence = localSequence * args.workerCount + args.workerIndex;
  const route = pickRoute(routing, args, globalSequence);
  const tenantId = routing.tenants[route.tenantIndex]!;
  const sensorId = routing.sensorIds[route.tenantIndex]![route.sensorIndex]!;
  const channelId = routing.channelIds[route.tenantIndex]![route.sensorIndex]![route.channelIndex]!;
  const topic = `sensors/${tenantId}/${sensorId}/data`;
  const payload: TelemetryPayload = {
    tenantId,
    sensorId,
    channelId,
    value: 20 + (globalSequence % 100) / 10,
    quality: 1,
    sourceEventId: sourceEventId(args.runId, globalSequence),
    sourceTimestamp: new Date().toISOString(),
    sourceSequence: globalSequence,
    padding: '',
  };
  let encodedPayload = JSON.stringify(payload);
  const baseBytes = Buffer.byteLength(encodedPayload);
  if (baseBytes < TARGET_PAYLOAD_BYTES) {
    payload.padding = 'x'.repeat(TARGET_PAYLOAD_BYTES - baseBytes);
    encodedPayload = JSON.stringify(payload);
  }
  const payloadBytes = Buffer.byteLength(encodedPayload);
  return {
    topic,
    payload,
    encodedPayload,
    payloadBytes,
    mqttWireBytes: mqttPublishWireBytes(topic, payloadBytes, args.qos),
    tenantIndex: route.tenantIndex,
  };
}

interface Counters {
  attempted: number;
  acknowledged: number;
  rejected: number;
  payloadBytes: number;
  mqttWireBytes: number;
  tenantAttempted: number[];
  rateSnapshots: Array<{ wallSeconds: number; attemptedSinceLast: number }>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function publishProfile(
  client: MqttClient,
  args: Args,
  routing: Routing,
  counters: Counters,
): Promise<void> {
  const workerRate = args.rate / args.workerCount;
  const plannedMessages = workerRate * args.duration;
  const startedAt = hrtime.bigint();
  let lastSnapshotSecond = 0;
  let lastSnapshotAttempted = 0;
  const publishOptions: IClientPublishOptions = { qos: args.qos, retain: false };

  while (counters.attempted < plannedMessages) {
    const elapsedNanoseconds = hrtime.bigint() - startedAt;
    const elapsedSeconds = Number(elapsedNanoseconds) / 1_000_000_000;
    if (elapsedSeconds >= args.duration) break;

    const shouldHaveAttempted = Math.min(
      plannedMessages,
      Math.floor(elapsedSeconds * workerRate) + 1,
    );
    while (counters.attempted < shouldHaveAttempted) {
      const message = generateMessage(routing, args, counters.attempted);
      counters.attempted += 1;
      counters.payloadBytes += message.payloadBytes;
      counters.mqttWireBytes += message.mqttWireBytes;
      counters.tenantAttempted[message.tenantIndex] =
        (counters.tenantAttempted[message.tenantIndex] ?? 0) + 1;
      client.publish(message.topic, message.encodedPayload, publishOptions, (error) => {
        if (error) counters.rejected += 1;
        else counters.acknowledged += 1;
      });
    }

    const wholeSecond = Math.floor(elapsedSeconds);
    if (wholeSecond > lastSnapshotSecond) {
      const attemptedSinceLast = counters.attempted - lastSnapshotAttempted;
      counters.rateSnapshots.push({ wallSeconds: wholeSecond, attemptedSinceLast });
      stdout.write(
        `[${args.profile}:${args.workerIndex}] t=${wholeSecond}s ` +
          `attempted=${counters.attempted} acked=${counters.acknowledged} ` +
          `rejected=${counters.rejected}\n`,
      );
      lastSnapshotSecond = wholeSecond;
      lastSnapshotAttempted = counters.attempted;
    }
    await sleep(1);
  }
}

interface MetricsSnapshot {
  fetchedAt: string;
  raw: string | null;
  error: string | null;
}

function emptyObservationTemplate(): object {
  return {
    brokerPersistenceBytesDelta: null,
    jetStreamStoredBytesDelta: null,
    jetStreamStoredEventsDelta: null,
    fanOutEventsPerMessage: null,
    rowsPerMessage: null,
    postgresHeapBytesDelta: null,
    postgresIndexBytesDelta: null,
    postgresWalBytesDelta: null,
  };
}

async function snapshotMetrics(url: string | null): Promise<MetricsSnapshot> {
  const fetchedAt = new Date().toISOString();
  if (!url) return { fetchedAt, raw: null, error: 'no metrics-url provided' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      return { fetchedAt, raw: null, error: `HTTP ${response.status}` };
    }
    return { fetchedAt, raw: await response.text(), error: null };
  } catch (error) {
    return {
      fetchedAt,
      raw: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function dryRunContract(args: Args, routing: Routing): object {
  const sample = generateMessage(routing, args, 0);
  return {
    profile: args.profile,
    candidateSizing: true,
    tenants: args.tenants,
    rate: args.rate,
    duration: args.duration,
    workerCount: args.workerCount,
    workerIndex: args.workerIndex,
    sample: {
      topic: sample.topic,
      payloadBytes: sample.payloadBytes,
      mqttWireBytes: sample.mqttWireBytes,
      payload: sample.payload,
    },
    measurements: {
      M: { unit: 'mqtt_messages_per_second' },
      E: { unit: 'child_events_per_second' },
      R: { unit: 'metric_rows_per_minute' },
    },
    observationTemplate: emptyObservationTemplate(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const routing = args.dryRun ? buildSampleRouting() : buildRouting(args);
  if (args.dryRun) {
    stdout.write(`${JSON.stringify(dryRunContract(args, routing))}\n`);
    return;
  }

  stderr.write(
    `[perf-baseline] candidate profile=${args.profile} total-rate=${args.rate}/s ` +
      `duration=${args.duration}s tenants=${args.tenants} worker=${args.workerIndex + 1}/${args.workerCount}\n`,
  );
  const client = connect(args.broker, {
    clientId: args.clientId,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 5_000,
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
  });
  await new Promise<void>((resolveConnect, rejectConnect) => {
    client.once('connect', () => resolveConnect());
    client.once('error', rejectConnect);
  });

  const counters: Counters = {
    attempted: 0,
    acknowledged: 0,
    rejected: 0,
    payloadBytes: 0,
    mqttWireBytes: 0,
    tenantAttempted: Array.from({ length: args.tenants }, () => 0),
    rateSnapshots: [],
  };
  const startedAt = new Date();
  const beforeMetrics = await snapshotMetrics(args.metricsUrl);
  await publishProfile(client, args, routing, counters);

  const drainDeadline = Date.now() + 30_000;
  while (
    counters.attempted > counters.acknowledged + counters.rejected &&
    Date.now() < drainDeadline
  ) {
    await sleep(100);
  }
  await new Promise<void>((resolveEnd, rejectEnd) => {
    client.end(false, {}, (error) => {
      if (error) rejectEnd(error);
      else resolveEnd();
    });
  });
  const finishedAt = new Date();
  const afterMetrics = await snapshotMetrics(args.metricsUrl);
  const unclassified = counters.attempted - counters.acknowledged - counters.rejected;
  const elapsedSeconds = (finishedAt.getTime() - startedAt.getTime()) / 1_000;
  const report = {
    schemaVersion: 1,
    scriptVersion: '1.0.0',
    candidateSizing: true,
    profile: args.profile,
    runId: args.runId,
    worker: { index: args.workerIndex, count: args.workerCount },
    envelope: { totalRate: args.rate, durationSeconds: args.duration, tenants: args.tenants },
    timing: { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() },
    measurements: {
      M: {
        unit: 'mqtt_messages_per_second',
        planned: args.rate,
        achievedByWorker: counters.attempted / elapsedSeconds,
        attempted: counters.attempted,
        acknowledged: counters.acknowledged,
        rejected: counters.rejected,
        unclassified,
        payloadBytes: counters.payloadBytes,
        mqttWireBytes: counters.mqttWireBytes,
      },
      E: {
        unit: 'child_events_per_second',
        observed: null,
        evidenceRequired: 'JetStream child event count and stored-byte delta',
      },
      R: {
        unit: 'metric_rows_per_minute',
        observed: null,
        evidenceRequired: 'tenant-local committed metric row delta',
      },
    },
    observationTemplate: emptyObservationTemplate(),
    tenantDistribution: counters.tenantAttempted.map((attempted, tenantIndex) => ({
      tenantId: routing.tenants[tenantIndex],
      attempted,
    })),
    rateSnapshots: counters.rateSnapshots,
    beforeMetrics,
    afterMetrics,
    gate: {
      everyAttemptClassified: unclassified === 0,
      generatorCompletedEnvelope:
        counters.attempted === (args.rate / args.workerCount) * args.duration,
      high005Closable: false,
      reason: 'candidate sizing only; HIGH-005 closes at Task 6 external load gates',
    },
  };

  const outputPath = resolve(process.cwd(), args.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  stderr.write(`[perf-baseline] report written -> ${outputPath}\n`);
  if (!report.gate.everyAttemptClassified || !report.gate.generatorCompletedEnvelope) {
    throw new Error('capacity profile did not complete with every attempted message classified');
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  stderr.write(`[perf-baseline] fatal: ${detail}\n`);
  exit(1);
});
