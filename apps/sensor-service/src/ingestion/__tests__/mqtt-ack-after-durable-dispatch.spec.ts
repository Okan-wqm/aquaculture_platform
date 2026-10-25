import { EventEmitter } from 'node:events';

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { IEventBus } from '@platform/event-bus';
import { OutboxPublisher } from '@platform/outbox';
import type { IPublishPacket } from 'mqtt';
import type { DataSource, EntityManager, EntityTarget, QueryRunner } from 'typeorm';

import { ErasedTenantTombstoneService } from '../../compliance/erasure/erased-tenant-tombstone.service';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import type { SensorMetricInput } from '../../database/entities/sensor-metric.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { SensorOutbox } from '../../outbox/sensor-outbox.entity';
import { MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import { MqttListenerService } from '../mqtt-listener.service';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';
import { SensorTopicCacheService } from '../sensor-topic-cache.service';

/**
 * The MQTT ack chain end to end: the REAL MqttClientService ack gate (the
 * mqtt.js handleMessage override that alone releases PUBACK) driving the REAL
 * MqttListenerService through the handler the listener registers on it.
 *
 * WHY this spec exists: the listener's own spec called the private
 * handleMessage directly and discarded the registered handler, so nothing ran
 * the function the ack gate awaits. That handler swallowed every rejection,
 * and the SensorReading fan-out was published after the metric commit with
 * its failure logged and acked. Both let PUBACK go out for a reading whose
 * durable handling had not completed (SENSOR-CRITICAL-190, SENSOR-CRITICAL-191).
 *
 * The contract pinned here: PUBACK only after ONE tenant transaction committed
 * the metric rows AND the reading's SensorReading dispatch obligation (the
 * sensor_outbox row the relay publishes); anything less is left unacked so the
 * persistent session redelivers.
 */

jest.mock('mqtt', () => ({ __esModule: true, connect: jest.fn() }));

const mqttMock = jest.requireMock<{ connect: jest.Mock }>('mqtt');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SENSOR_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const FARM_ID = '44444444-4444-4444-8444-444444444444';
const TOPIC = 'sensors/ack-chain/do-probe';
const PAYLOAD = { temperature: 23.5, ts: 1_730_000_000_000 };

interface OutboxRow {
  readonly tenantId: string | null;
  readonly idempotencyKey: string | null;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

interface FakeMqttClient extends EventEmitter {
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
  end: jest.Mock;
  removeAllListeners: jest.Mock;
  handleMessage?: (packet: IPublishPacket, done: (error?: Error) => void) => void;
}

function fakeMqttClient(): FakeMqttClient {
  const client = new EventEmitter() as FakeMqttClient;
  client.subscribe = jest.fn((_topic: unknown, _opts: unknown, cb: (e?: Error) => void) =>
    cb(undefined),
  );
  client.unsubscribe = jest.fn();
  client.end = jest.fn((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
    cb?.();
    return client;
  });
  client.removeAllListeners = jest.fn();
  return client;
}

/** A wire string is sent as is; an object is serialized first. */
function publishPacket(payload: object | string): IPublishPacket {
  return {
    cmd: 'publish',
    topic: TOPIC,
    payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    qos: 1,
    dup: false,
    retain: false,
    messageId: 7,
  };
}

/**
 * A DataSource whose transactions behave like Postgres for what this chain
 * needs: metric rows and outbox rows staged inside a transaction become
 * visible only on COMMIT and vanish on ROLLBACK, and the outbox idempotency
 * index ignores a second row with the same (tenantId, idempotencyKey).
 */
class TransactionalStore {
  readonly committedMetrics: SensorMetricInput[] = [];
  readonly committedOutbox: OutboxRow[] = [];
  readonly timeline: string[] = [];
  failOutboxInsert = false;
  failSensorReload = false;
  /**
   * db-migrate's delete job ran DROP SCHEMA for the tenant. search_path
   * still names it first, so current_schema() resolves to the next existing
   * schema, `sensor`, and the REAL tenant boundary refuses every read and
   * write with TenantContextError SCHEMA_MISMATCH, as Postgres makes it.
   */
  tenantSchemaDropped = false;

  private readonly staged = new Map<
    EntityManager,
    { metrics: SensorMetricInput[]; outbox: OutboxRow[] }
  >();

  constructor(
    private readonly sensor: Sensor,
    private readonly channels: SensorDataChannel[],
  ) {}

  stageMetrics(manager: EntityManager, metrics: SensorMetricInput[]): void {
    this.stageOf(manager).metrics.push(...metrics);
  }

  dataSource(): DataSource {
    const source = { createQueryRunner: (): QueryRunner => this.queryRunner() };
    return source as Partial<DataSource> as DataSource;
  }

  private stageOf(manager: EntityManager): { metrics: SensorMetricInput[]; outbox: OutboxRow[] } {
    const stage = this.staged.get(manager);
    if (!stage) throw new Error('write outside a transaction');
    return stage;
  }

  private insertOutbox(manager: EntityManager, row: OutboxRow): void {
    if (this.failOutboxInsert) throw new Error('sensor_outbox insert failed');
    const visible = [...this.committedOutbox, ...this.stageOf(manager).outbox];
    const duplicate =
      row.idempotencyKey !== null &&
      visible.some((r) => r.tenantId === row.tenantId && r.idempotencyKey === row.idempotencyKey);
    if (!duplicate) this.stageOf(manager).outbox.push(row);
  }

  private queryRunner(): QueryRunner {
    let active = false;
    let readOnly = false;
    const repositoryFor = (entity: EntityTarget<unknown>): object => {
      if (entity === Sensor) {
        return {
          findOne: jest.fn(async () => {
            if (this.failSensorReload) throw new Error('connection terminated unexpectedly');
            return this.sensor;
          }),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
      }
      if (entity === SensorDataChannel) return { find: jest.fn().mockResolvedValue(this.channels) };
      return { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    };
    const insertChain = (target: EntityManager): object => {
      let values: Partial<OutboxRow> = {};
      const chain = {
        insert: () => chain,
        into: () => chain,
        values: (v: Partial<OutboxRow>) => {
          values = v;
          return chain;
        },
        orIgnore: () => chain,
        execute: async () => {
          this.insertOutbox(target, {
            tenantId: values.tenantId ?? null,
            idempotencyKey: values.idempotencyKey ?? null,
            eventType: String(values.eventType),
            payload: values.payload ?? {},
          });
          return { identifiers: [] };
        },
      };
      return chain;
    };
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn(async () => {
        active = true;
        readOnly = false;
        this.staged.set(manager, { metrics: [], outbox: [] });
      }),
      commitTransaction: jest.fn(async () => {
        const stage = this.stageOf(manager);
        this.committedMetrics.push(...stage.metrics);
        this.committedOutbox.push(...stage.outbox);
        this.timeline.push(readOnly ? 'commit:read' : `commit:${stage.outbox.length} outbox`);
        this.staged.delete(manager);
        active = false;
      }),
      rollbackTransaction: jest.fn(async () => {
        this.timeline.push('rollback');
        this.staged.delete(manager);
        active = false;
      }),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql === 'SET TRANSACTION READ ONLY') readOnly = true;
        if (this.tenantSchemaDropped && sql.includes('current_schema()')) {
          return [{ schema: 'sensor', tenant: TENANT_ID, bypass: 'off' }];
        }
        return [];
      }),
      get isTransactionActive(): boolean {
        return active;
      },
    };
    const manager = {
      get queryRunner(): QueryRunner {
        return runner as Partial<QueryRunner> as QueryRunner;
      },
      getRepository: jest.fn(repositoryFor),
      createQueryBuilder: jest.fn(() =>
        insertChain(manager as Partial<EntityManager> as EntityManager),
      ),
      query: jest.fn().mockResolvedValue([]),
    } as Partial<EntityManager> as EntityManager;
    return Object.assign(runner, { manager }) as Partial<QueryRunner> as QueryRunner;
  }
}

function temperatureChannel(): SensorDataChannel {
  const channel = {
    id: CHANNEL_ID,
    sensorId: SENSOR_ID,
    tenantId: TENANT_ID,
    channelKey: 'temperature',
    isEnabled: true,
    applyCalibration: (value: number): number => value,
    validateValue: () => ({ valid: true }),
  };
  return channel as Partial<SensorDataChannel> as SensorDataChannel;
}

function probeSensor(): Sensor {
  const sensor = {
    id: SENSOR_ID,
    tenantId: TENANT_ID,
    farmId: FARM_ID,
    protocolConfiguration: { topic: TOPIC, payloadFormat: 'json' },
  };
  return sensor as Partial<Sensor> as Sensor;
}

interface Chain {
  readonly client: FakeMqttClient;
  readonly mqtt: MqttClientService;
  readonly listener: MqttListenerService;
  readonly store: TransactionalStore;
  readonly writeManaged: jest.Mock;
  readonly publish: jest.Mock;
  readonly resolveTopic: jest.Mock;
  /** The topic cache's liveness question; false (tenant active) unless a case says otherwise. */
  readonly evictIfTenantInactive: jest.Mock;
  readonly isErased: jest.Mock;
  deliver(payload: object | string): Promise<jest.Mock>;
  close(): Promise<void>;
}

async function bootChain(): Promise<Chain> {
  const client = fakeMqttClient();
  mqttMock.connect.mockReturnValueOnce(client);
  const mqtt = new MqttClientService(new ConfigService({ MQTT_CLIENT_ID: 'aqua-ack-chain' }));
  const connected = mqtt.connect();
  client.emit('connect');
  await connected;

  const store = new TransactionalStore(probeSensor(), [temperatureChannel()]);
  const writeManaged = jest.fn(async (metrics: SensorMetricInput[], manager: EntityManager) => {
    store.stageMetrics(manager, metrics);
  });
  // NATS is down for the whole chain: a direct publish can never succeed.
  const publish = jest.fn().mockRejectedValue(new Error('NATS: no responders (PubAck timeout)'));
  const eventBus = { publish } as Partial<IEventBus> as IEventBus;
  const resolveTopic = jest.fn().mockResolvedValue({
    id: SENSOR_ID,
    name: 'DO probe',
    type: 'temperature',
    tenantId: TENANT_ID,
    schemaName: 'tenant_1111111111114111',
    protocolConfiguration: { topic: TOPIC },
  });
  const evictIfTenantInactive = jest.fn().mockResolvedValue(false);
  const topicCache = {
    getSensorByTopic: resolveTopic,
    invalidateSensor: jest.fn().mockResolvedValue(undefined),
    evictIfTenantInactive,
  } as Partial<SensorTopicCacheService> as SensorTopicCacheService;
  const isErased = jest.fn().mockReturnValue(false);
  const tombstone = {
    isErased,
  } as Partial<ErasedTenantTombstoneService> as ErasedTenantTombstoneService;

  const moduleRef = await Test.createTestingModule({
    providers: [
      MqttListenerService,
      { provide: ConfigService, useValue: new ConfigService({ MQTT_ENABLED: 'true' }) },
      { provide: getDataSourceToken(), useValue: store.dataSource() },
      { provide: SensorMetricWriterService, useValue: { writeManaged } },
      { provide: 'EVENT_BUS', useValue: eventBus },
      { provide: SensorTopicCacheService, useValue: topicCache },
      { provide: MqttClientService, useValue: mqtt },
      // The real publisher: its transaction assertion and identity checks are
      // part of what "durable dispatch" means.
      { provide: OutboxPublisher, useValue: new OutboxPublisher(SensorOutbox) },
      { provide: ErasedTenantTombstoneService, useValue: tombstone },
    ],
  }).compile();
  const listener = moduleRef.get(MqttListenerService);
  await listener.onModuleInit();

  return {
    client,
    mqtt,
    listener,
    store,
    writeManaged,
    publish,
    resolveTopic,
    evictIfTenantInactive,
    isErased,
    async deliver(payload: object | string): Promise<jest.Mock> {
      const done = jest.fn(() => {
        store.timeline.push('puback');
      });
      client.handleMessage!(publishPacket(payload), done);
      // Let the handler chain (reload, transaction, commit) settle.
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
      return done;
    },
    async close(): Promise<void> {
      await listener.onModuleDestroy();
      await mqtt.onModuleDestroy();
    },
  };
}

describe('MQTT PUBACK waits for the durable commit of the reading and its dispatch', () => {
  let chain: Chain | undefined;

  beforeEach(() => {
    mqttMock.connect.mockReset();
  });

  afterEach(async () => {
    await chain?.close();
    chain = undefined;
  });

  it('leaves a reading whose metric write failed unacked, so the session redelivers it', async () => {
    chain = await bootChain();
    chain.writeManaged.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    const done = await chain.deliver(PAYLOAD);

    expect(done).not.toHaveBeenCalled();
    expect(chain.client.end).toHaveBeenCalledWith(true);
    expect(chain.store.committedMetrics).toEqual([]);
  });

  it('commits the SensorReading dispatch with the metric rows before PUBACK, NATS down or not', async () => {
    chain = await bootChain();

    const done = await chain.deliver(PAYLOAD);

    expect(done).toHaveBeenCalledTimes(1);
    expect(chain.store.committedMetrics).toHaveLength(1);
    expect(chain.store.committedOutbox).toHaveLength(1);
    const [row] = chain.store.committedOutbox;
    expect(row).toMatchObject({
      tenantId: TENANT_ID,
      eventType: 'SensorReading',
      payload: expect.objectContaining({
        eventType: 'SensorReading',
        tenantId: TENANT_ID,
        sensorId: SENSOR_ID,
        farmId: FARM_ID,
        readingTemperature: 23.5,
      }),
    });
    // The dedup key is the reading's deterministic identity (Task 1.4).
    expect(row!.idempotencyKey).toBe(row!.payload['eventId']);
    // ONE tenant transaction loads the sensor and commits the metric rows with
    // the dispatch obligation, and only then is PUBACK released.
    expect(chain.store.timeline).toEqual(['commit:1 outbox', 'puback']);
    // The relay owns delivery: the handler never publishes the reading itself.
    const directReadings = chain.publish.mock.calls.filter(
      ([event]: [{ eventType?: string }]) => event.eventType === 'SensorReading',
    );
    expect(directReadings).toEqual([]);
  });

  it('leaves the reading unacked when its dispatch obligation cannot be recorded', async () => {
    chain = await bootChain();
    chain.store.failOutboxInsert = true;

    const done = await chain.deliver(PAYLOAD);

    expect(done).not.toHaveBeenCalled();
    expect(chain.client.end).toHaveBeenCalledWith(true);
    // All or nothing: the metric rows rolled back with the failed enqueue.
    expect(chain.store.committedMetrics).toEqual([]);
    expect(chain.store.committedOutbox).toEqual([]);
  });

  it('collapses a redelivered reading onto the dispatch row it already committed', async () => {
    chain = await bootChain();

    await chain.deliver(PAYLOAD);
    const redelivered = await chain.deliver(PAYLOAD);

    expect(redelivered).toHaveBeenCalledTimes(1);
    expect(chain.store.committedOutbox).toHaveLength(1);
  });

  // A failed lookup is not "no sensor": the reading was never persisted, so it
  // must stay unacked like a failed write (SENSOR-CRITICAL-190's PostgreSQL
  // failover reaches the per-message sensor reload before it reaches the write).
  it.each([
    [
      'the tenant-scoped sensor reload',
      (c: Chain): void => {
        c.store.failSensorReload = true;
      },
    ],
    [
      'the topic resolver',
      (c: Chain): void => {
        c.resolveTopic.mockRejectedValueOnce(new Error('redis: connection lost'));
      },
    ],
  ])('leaves a reading unacked when %s fails', async (_label, breakLookup) => {
    chain = await bootChain();
    breakLookup(chain);

    const done = await chain.deliver(PAYLOAD);

    expect(done).not.toHaveBeenCalled();
    expect(chain.client.end).toHaveBeenCalledWith(true);
    expect(chain.writeManaged).not.toHaveBeenCalled();
  });
});

/**
 * A topic mapping outlives its tenant: one cached before db-migrate's delete
 * job dropped the schema (tenant deprovision or erasure) keeps resolving for
 * up to an hour, and every reload through it fails. Holding PUBACK on such a
 * failure stops MQTT ingestion for every tenant (the broker redelivers that
 * message first after each forced reconnect) and can never succeed. A reload
 * that failed is "found nothing" only when the platform no longer lists the
 * tenant as active; for a live tenant, or when liveness cannot be read, it
 * stays a failure and the session redelivers.
 */
describe('a reading for a tenant that no longer exists', () => {
  let chain: Chain | undefined;

  beforeEach(() => {
    mqttMock.connect.mockReset();
  });

  afterEach(async () => {
    await chain?.close();
    chain = undefined;
  });

  it('acks and evicts the mapping when the reload fails on the dropped schema of a tenant that is not active', async () => {
    chain = await bootChain();
    chain.store.tenantSchemaDropped = true;
    chain.evictIfTenantInactive.mockResolvedValue(true);

    const done = await chain.deliver(PAYLOAD);

    expect(done).toHaveBeenCalledTimes(1);
    expect(chain.client.end).not.toHaveBeenCalled();
    expect(chain.evictIfTenantInactive).toHaveBeenCalledWith(TENANT_ID);
    expect(chain.writeManaged).not.toHaveBeenCalled();
    expect(chain.store.committedOutbox).toEqual([]);
  });

  it('holds PUBACK when the reload fails for a tenant the platform still lists as active', async () => {
    chain = await bootChain();
    chain.store.tenantSchemaDropped = true;

    const done = await chain.deliver(PAYLOAD);

    expect(chain.evictIfTenantInactive).toHaveBeenCalledWith(TENANT_ID);
    expect(done).not.toHaveBeenCalled();
    expect(chain.client.end).toHaveBeenCalledWith(true);
  });

  it('holds PUBACK when whether the tenant is live cannot be read', async () => {
    chain = await bootChain();
    chain.store.tenantSchemaDropped = true;
    chain.evictIfTenantInactive.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const done = await chain.deliver(PAYLOAD);

    expect(done).not.toHaveBeenCalled();
    expect(chain.client.end).toHaveBeenCalledWith(true);
  });

  it("ACK-drops an erased tenant's message before anything reads its schema (Task 1.8 tombstone)", async () => {
    chain = await bootChain();
    chain.store.tenantSchemaDropped = true;
    chain.isErased.mockReturnValue(true);

    const done = await chain.deliver(PAYLOAD);

    expect(chain.isErased).toHaveBeenCalledWith(TENANT_ID);
    expect(done).toHaveBeenCalledTimes(1);
    expect(chain.client.end).not.toHaveBeenCalled();
    // No reload transaction ran: the tombstone answered from the mapping.
    expect(chain.store.timeline).toEqual(['puback']);
    expect(chain.evictIfTenantInactive).not.toHaveBeenCalled();
  });
});

/**
 * Everything inside the durable leg runs on device-controlled input, and a
 * throw there is a durable failure: it rolls the rows back, holds PUBACK and
 * force-reconnects the ONE shared MQTT connection, and the broker redelivers
 * the same message first on every reconnect. A payload that makes pure code
 * throw would therefore stop MQTT ingestion for every tenant. These payloads
 * are well-formed JSON under the 256 KB cap; each must be acked once its
 * transaction commits.
 */
describe('a payload shape is never a durable failure', () => {
  let chain: Chain | undefined;
  // 40 KB of nested arrays: JSON.parse accepts it, a recursive walk overflows.
  const DEPTH = 20_000;
  const deeplyNested = `${'['.repeat(DEPTH)}1${']'.repeat(DEPTH)}`;

  beforeEach(() => {
    mqttMock.connect.mockReset();
  });

  afterEach(async () => {
    await chain?.close();
    chain = undefined;
  });

  it('acks a reading whose numeric ts is outside the Date range', async () => {
    chain = await bootChain();

    // A nanosecond epoch: finite, but past the last instant a Date can hold.
    const done = await chain.deliver('{"temperature":23.5,"ts":1730000000000000000}');

    expect(done).toHaveBeenCalledTimes(1);
    expect(chain.client.end).not.toHaveBeenCalled();
    expect(chain.store.committedMetrics).toHaveLength(1);
    expect(chain.store.committedOutbox).toHaveLength(1);
  });

  it('acks a reading that carries a deeply nested field beside its channel', async () => {
    chain = await bootChain();

    const done = await chain.deliver(
      `{"temperature":23.5,"ts":1730000000000,"extra":${deeplyNested}}`,
    );

    expect(done).toHaveBeenCalledTimes(1);
    expect(chain.client.end).not.toHaveBeenCalled();
    expect(chain.store.committedMetrics).toHaveLength(1);
    expect(chain.store.committedOutbox).toHaveLength(1);
  });

  it('skips a channel whose value is not a scalar, and acks', async () => {
    chain = await bootChain();

    const done = await chain.deliver(`{"temperature":${deeplyNested}}`);

    expect(done).toHaveBeenCalledTimes(1);
    expect(chain.client.end).not.toHaveBeenCalled();
    expect(chain.store.committedMetrics).toEqual([]);
    expect(chain.store.committedOutbox).toEqual([]);
  });

  // String() used to coerce [23.5] to "23.5", so such a reading was stored.
  // It is skipped now; the skip must be visible and name the remedy, without
  // a log line per message.
  it('warns once per sensor channel that a non-scalar value was skipped, naming the dataPath remedy', async () => {
    chain = await bootChain();
    const warn = jest.spyOn(chain.listener['logger'], 'warn');

    await chain.deliver('{"temperature":[23.5]}');
    await chain.deliver('{"temperature":[23.6]}');

    const skipped = warn.mock.calls.filter(([line]) => String(line).includes('non-scalar'));
    expect(skipped).toHaveLength(1);
    const [line] = skipped[0]!;
    expect(String(line)).toContain(SENSOR_ID);
    expect(String(line)).toContain('dataPath "temperature[0]"');
    expect(chain.store.committedMetrics).toEqual([]);
  });
});
