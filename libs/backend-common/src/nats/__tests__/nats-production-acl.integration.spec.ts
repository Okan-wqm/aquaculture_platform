import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { AckPolicy, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { createInbox, type Msg, type NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { ConfigService } from '@nestjs/config';
import { NatsEventBus } from '@platform/event-bus';
import { lastValueFrom, Observable, timeout } from 'rxjs';
import { parse } from 'yaml';

import storagePolicy from '../../../../../platform/libs/event-bus/src/nats/jetstream-storage-policy.json';
import { buildNatsConnectionOptions } from '../nats-connection.factory';
import responsePolicy from '../nats-response-policy.json';
import { NatsV3Client } from '../nats-v3-client.proxy';
import { NatsV3Server } from '../nats-v3-server.strategy';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function registryConsumers(): string[] {
  const registry: unknown = parse(readFileSync('infrastructure/nats/services.yaml', 'utf8'));
  if (!record(registry) || !Array.isArray(registry.services)) throw new Error('Invalid NATS registry');
  return registry.services.flatMap((service: unknown) => {
    if (!record(service) || typeof service.name !== 'string' || !Array.isArray(service.publish)) {
      throw new Error('Invalid NATS registry identity');
    }
    return service.publish.includes('$JS.API.INFO') ? [service.name] : [];
  });
}

const consumers = registryConsumers();
const connections: NatsConnection[] = [];
const closeables: { close(): Promise<void> }[] = [];
const buses: NatsEventBus[] = [];
const originalEnvironment = process.env;

function identity(name: string): void {
  const root = process.env.NATS_ACL_CERT_ROOT;
  if (!root) throw new Error('Hosted fixture certificate root is required');
  process.env.NATS_TLS_CA = join(root, 'certs/ca-cert.pem');
  process.env.NATS_TLS_CERT = join(root, `clients/${name}-cert.pem`);
  process.env.NATS_TLS_KEY = join(root, `clients/${name}-key.pem`);
}

async function connection(name: string): Promise<NatsConnection> {
  identity(name);
  const options = buildNatsConnectionOptions(`display-name-unrelated-to-${name}`);
  expect(options.authMode).toBe('mtls-cert');
  expect(options.user).toBeUndefined();
  expect(options.pass).toBeUndefined();
  expect(options.token).toBeUndefined();
  const nc = await connect(options);
  connections.push(nc);
  return nc;
}

async function bounded<T>(work: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('NATS proof deadline exceeded')), milliseconds);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function deniedPublish(nc: NatsConnection, subject: string): Promise<void> {
  const denied = (async (): Promise<void> => {
    for await (const status of nc.status()) {
      if (status.type === 'error' && status.error.message.includes(subject) &&
        /permissions violation/i.test(status.error.message)) return;
    }
    throw new Error('Connection closed without broker permission rejection');
  })();
  nc.publish(subject, 'must-be-denied');
  await nc.flush();
  await bounded(denied);
}

async function startServer(name: string, subject: string): Promise<NatsV3Server> {
  identity(name);
  const server = new NatsV3Server({ serviceName: 'deliberately-different-display-name' });
  // A delayed completion exercises Nest's two-packet unary framing, rather
  // than accidentally relying only on its same-tick disposal coalescing.
  server.addHandler(subject, async () => new Observable<string>((subscriber) => {
    subscriber.next('roundtrip-ok');
    const timer = setTimeout(() => subscriber.complete(), 25);
    return () => clearTimeout(timer);
  }));
  closeables.push(server);
  await new Promise<void>((resolve, reject) => {
    void server.listen((error: unknown) => error === undefined ? resolve() : reject(error));
  });
  await server.unwrap<NatsConnection>().flush();
  return server;
}

async function startBus(): Promise<NatsEventBus> {
  identity('sensor_service');
  const bus = new NatsEventBus(new ConfigService({
    NATS_URL: process.env.NATS_URL,
    SERVICE_NAME: 'sensor-service',
  }), { required: true });
  buses.push(bus);
  await bus.onModuleInit();
  return bus;
}

beforeAll(() => {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !/^tls:\/\/127\.0\.0\.1:\d+$/.test(process.env.NATS_URL ?? '') ||
    !/^aqua-nats-production-acl-\d+-\d+$/.test(process.env.NATS_ACL_TEST_CONTAINER ?? '')) {
    throw new Error('This proof requires the isolated hosted broker harness');
  }
  process.env = { ...process.env, NODE_ENV: 'production', NATS_TLS_ENABLED: 'true' };
  delete process.env.NATS_AUTH_USER;
  delete process.env.NATS_AUTH_PASS;
  delete process.env.NATS_AUTH_TOKEN;
  delete process.env.NATS_TLS_INSECURE_ALLOW;
  expect(consumers.length).toBeGreaterThan(0);
});

afterEach(async () => {
  await Promise.all(buses.splice(0).map((bus) => bus.onModuleDestroy()));
  await Promise.all(closeables.splice(0).map((item) => item.close()));
  await Promise.all(connections.splice(0).map((nc) => nc.close()));
});
afterAll(() => { process.env = originalEnvironment; });

describe('committed production NATS mTLS and delivered-response authorization', () => {
  it.each(consumers)('initializes the actual JetStream manager for registry CN %s', async (name) => {
    const nc = await connection(name);
    const manager = await jetstreamManager(nc);
    expect((await manager.getAccountInfo()).streams).toBeGreaterThanOrEqual(0);
  });

  const routes = [
    ['admin_api_service', 'auth_service', 'request.auth.admin.checkUserLimit'],
    ['ai_service', 'farm_service', 'request.farm.getTankRegistry'],
    ['gateway_service', 'sensor_service', 'request.sensor.verifyDeviceOwnership'],
    ['admin_api_service', 'billing_service', 'request.billing.tenant.provisionSubscription'],
    ['hr_service', 'notification_service', 'commands.notification.sendEmail'],
    ['gateway_service', 'ai_service', 'request.ai.chat'],
    ['gateway_service', 'messaging_service', 'request.messaging.verifyMembership'],
    ['billing_service', 'config_service', 'config.runtime.get'],
  ];
  it.each(routes)('completes actual unary proxy/server framing %s to %s', async (caller, responder, subject) => {
    await startServer(responder, subject);
    identity(caller);
    const client = new NatsV3Client({ serviceName: 'display-name-is-not-authority' });
    closeables.push(client);
    await client.connect();
    expect(await lastValueFrom(client.send<string>(subject, {}).pipe(timeout(5000)))).toBe('roundtrip-ok');
  });

  it.each([
    ['billing_service', '_INBOXBILLINGCFG', 'config.runtime.get_secret'],
    ['farm_service', '_INBOXFARMMARINECFG', 'config.marine_credentials.resolve'],
  ])('preserves dedicated reply contract %s / %s', async (caller, inboxPrefix, subject) => {
    await startServer('config_service', subject);
    identity(caller);
    const client = new NatsV3Client({ inboxPrefix });
    closeables.push(client);
    await client.connect();
    expect(await lastValueFrom(client.send<string>(subject, {}).pipe(timeout(5000)))).toBe('roundtrip-ok');
    const other = await connection('gateway_service');
    const denied = new Promise<Error>((resolve) => {
      other.subscribe(`${inboxPrefix}.>`, { callback: (error) => { if (error) resolve(error); } });
    });
    await other.flush();
    expect((await bounded(denied)).message).toMatch(/permissions violation/i);
  });

  it('rejects unsolicited replies and a third response to an actually delivered RPC', async () => {
    const caller = await connection('messaging_service');
    const responder = await connection('auth_service');
    const reply = createInbox('_INBOXMESSAGING_SERVICE');
    const received: string[] = [];
    const receivedBoth = new Promise<void>((resolve, reject) => {
      caller.subscribe(reply, { callback: (error, message) => {
        if (error) { reject(error); return; }
        received.push(message.string());
        if (received.length === responsePolicy.maxUnaryResponses) resolve();
      } });
    });
    await caller.flush();
    await deniedPublish(responder, reply);
    const delivered = new Promise<Msg>((resolve) => {
      responder.subscribe('request.auth.verifyPassword', { max: 1,
        callback: (error, message) => { if (error) throw error; resolve(message); } });
    });
    await responder.flush();
    caller.publish('request.auth.verifyPassword', 'fixture', { reply });
    const message = await bounded(delivered);
    expect(message.respond('first')).toBe(true);
    expect(message.respond('disposed')).toBe(true);
    await responder.flush();
    await deniedPublish(responder, reply);
    await bounded(receivedBoth);
    expect(received).toEqual(['first', 'disposed']);
    expect(responsePolicy.maxUnaryResponses).toBe(2);
  });

  it('expires an unused delivered-response grant at the real production lifetime', async () => {
    const caller = await connection('messaging_service');
    const responder = await connection('auth_service');
    const reply = createInbox('_INBOXMESSAGING_SERVICE');
    const inbox = caller.subscribe(reply);
    const delivered = new Promise<Msg>((resolve) => {
      responder.subscribe('request.auth.verifyPassword', { max: 1,
        callback: (error, message) => { if (error) throw error; resolve(message); } });
    });
    await responder.flush();
    caller.publish('request.auth.verifyPassword', 'fixture', { reply });
    await bounded(delivered);
    await delay(responsePolicy.expirySeconds * 1000 + 250);
    await deniedPublish(responder, reply);
    await caller.flush();
    expect(inbox.getReceived()).toBe(0);
  }, responsePolicy.expirySeconds * 1000 + 20000);

  it('boots real EventBus stream budgets and preserves them and data across broker restart', async () => {
    const bus = await startBus();
    const nc = await connection('sensor_service');
    const manager = await jetstreamManager(nc);
    const expected = [
      ['AQUACULTURE_EVENTS', storagePolicy.streams.events.max_bytes],
      ['AQUACULTURE_TELEMETRY', storagePolicy.streams.telemetry.max_bytes],
      ['AQUACULTURE_DLQ', storagePolicy.streams.dlq.max_bytes],
    ] satisfies [string, number][];
    for (const [name, bytes] of expected) expect((await manager.streams.info(name)).config.max_bytes).toBe(bytes);
    const acknowledgement = await jetstream(nc).publish('events.system.SensorReading', 'retained-sentinel');
    const before = await manager.streams.info('AQUACULTURE_EVENTS');
    await bus.onModuleDestroy();
    buses.splice(buses.indexOf(bus), 1);
    await nc.close();
    connections.splice(connections.indexOf(nc), 1);
    const container = process.env.NATS_ACL_TEST_CONTAINER;
    if (!container) throw new Error('Missing owned broker identity');
    execFileSync('docker', ['restart', container], { stdio: 'pipe', timeout: 30000 });
    await bounded((async (): Promise<void> => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          execFileSync('docker', ['exec', container, 'wget', '-q', '--spider', 'http://localhost:8222/healthz'],
            { stdio: 'pipe', timeout: 2000 });
          return;
        } catch {
          await delay(100);
        }
      }
      throw new Error('Restarted broker did not become healthy');
    })());
    await startBus();
    const restarted = await jetstreamManager(await connection('sensor_service'));
    for (const [name, bytes] of expected) expect((await restarted.streams.info(name)).config.max_bytes).toBe(bytes);
    const after = await restarted.streams.info('AQUACULTURE_EVENTS');
    expect(after.created).toBe(before.created);
    expect(after.state.last_seq).toBe(acknowledgement.seq);
  }, 60000);

  it('ACKs and NAKs actual pull deliveries and verifies broker pending/redelivery state', async () => {
    await startBus();
    const producer = await connection('auth_service');
    const receiver = await connection('hydroponics_service');
    const manager = await jetstreamManager(receiver);
    const name = 'hosted-acl-ack-contract';
    const subject = 'events.system.UserLoggedIn';
    await manager.consumers.add('AQUACULTURE_EVENTS', {
      durable_name: name, ack_policy: AckPolicy.Explicit, filter_subject: subject,
      ack_wait: 30_000_000_000,
    });
    await jetstream(producer).publish(subject, 'ack-proof');
    const consumer = await jetstream(receiver).consumers.get('AQUACULTURE_EVENTS', name);
    const first = await consumer.next({ expires: 5000 });
    if (!first) throw new Error('Broker did not deliver fixture message');
    expect((await manager.consumers.info('AQUACULTURE_EVENTS', name)).num_ack_pending).toBe(1);
    first.nak(50);
    await receiver.flush();
    const redelivered = await consumer.next({ expires: 5000 });
    if (!redelivered) throw new Error('NAK did not produce a broker redelivery');
    expect(redelivered.info.deliveryCount).toBe(2);
    expect(redelivered.seq).toBe(first.seq);
    redelivered.ack();
    await receiver.flush();
    const final = await bounded((async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const info = await manager.consumers.info('AQUACULTURE_EVENTS', name);
        if (info.num_ack_pending === 0) return info;
        await delay(25);
      }
      throw new Error('Broker did not commit the acknowledgement');
    })());
    expect(final.num_ack_pending).toBe(0);
    expect(final.ack_floor.stream_seq).toBe(redelivered.seq);
    expect(responsePolicy.maxAckResponses).toBe(1);
  });
});
