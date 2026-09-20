import 'reflect-metadata';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import { stub } from '@aquaculture/testing';
import { JetStreamApiError, jetstream, jetstreamManager } from '@nats-io/jetstream';
import type {
  ConsumerAPI,
  ConsumerInfo,
  Consumers,
  JetStreamClient,
  JetStreamManager,
  StreamAPI,
  StreamInfo,
} from '@nats-io/jetstream';
import type { NatsConnection, Status } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { HandlerOutcome } from '../../interfaces/handler-outcome';
import { NatsEventBus } from '../nats-event-bus';

jest.mock('@aquaculture/backend-common/nats', () => ({
  buildNatsConnectionOptions: jest.fn(),
}));

jest.mock('@nats-io/transport-node', () => {
  const actual =
    jest.requireActual<typeof import('@nats-io/transport-node')>('@nats-io/transport-node');
  return { ...actual, connect: jest.fn() };
});

jest.mock('@nats-io/jetstream', () => {
  const actual = jest.requireActual<typeof import('@nats-io/jetstream')>('@nats-io/jetstream');
  return { ...actual, jetstream: jest.fn(), jetstreamManager: jest.fn() };
});

/**
 * ARCH-020 under the v3 client: a durable consumer is created when new and
 * UPDATED in place when it already exists with a previous release's
 * configuration.
 *
 * WHY: @nats-io/jetstream 3.x `consumers.add()` sends the server action
 * `create`, which nats-server refuses with "consumer already exists" (10148)
 * whenever the durable exists with any other configuration; the v2 client
 * sent create-or-update. After Task 1.6 moved max_deliver 3 → -1 every
 * subscriber died at onModuleInit on the first deploy that reached a broker
 * holding the old consumers — the last blocker of the 2026-09-20 outage,
 * invisible to CI because its broker never holds a previous release's
 * consumers. Verified against nats:2.10.24: `update` keeps the durable and
 * its ack position; a non-updatable change still fails (10012).
 */
describe('NatsEventBus durable consumer create-or-update', () => {
  const SUBJECT = 'events.*.TenantSubscriptionChanged';
  const STREAM = 'AQUACULTURE_EVENTS';
  // clientId is `aquaculture-<SERVICE_NAME>`; the durable name derives from it and the subject.
  const CONSUMER_NAME = 'aquaculture-auth-service-events---TenantSubscriptionChanged';

  let consumersAdd: jest.Mock;
  let consumersUpdate: jest.Mock;
  let consumersGet: jest.Mock;

  function noConnectionStatuses(): AsyncIterable<Status> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Status> => ({
        next: (): Promise<IteratorResult<Status>> =>
          Promise.resolve({ done: true, value: undefined }),
      }),
    };
  }

  function alreadyExists(): JetStreamApiError {
    return new JetStreamApiError({
      code: 400,
      err_code: 10148,
      description: 'consumer already exists',
    });
  }

  async function boot(): Promise<NatsEventBus> {
    const configService = new ConfigService();
    const values: Record<string, unknown> = {
      NATS_URL: 'tls://nats:4222',
      NATS_STREAM_NAME: STREAM,
      SERVICE_NAME: 'auth-service',
      NATS_MAX_RECONNECT_ATTEMPTS: '2',
    };
    jest
      .spyOn(configService, 'get')
      .mockImplementation((key: string, defaultValue?: unknown) =>
        key in values ? values[key] : defaultValue,
      );

    consumersUpdate = jest.fn().mockResolvedValue(stub<ConsumerInfo>({}));
    consumersGet = jest.fn().mockResolvedValue({
      consume: () => Promise.resolve({ stop: jest.fn() }),
    });

    const connection = stub<NatsConnection>({
      status: () => noConnectionStatuses(),
      closed: () => new Promise<void>(() => undefined),
      drain: jest.fn(() => Promise.resolve()),
      close: jest.fn(() => Promise.resolve()),
      isClosed: () => false,
    });
    jest.mocked(connect).mockResolvedValue(connection);
    jest.mocked(jetstreamManager).mockResolvedValue(
      stub<JetStreamManager>({
        streams: stub<StreamAPI>({
          info: jest.fn().mockResolvedValue(stub<StreamInfo>({})),
          add: jest.fn().mockResolvedValue(stub<StreamInfo>({})),
          update: jest.fn().mockResolvedValue(stub<StreamInfo>({})),
        }),
        consumers: stub<ConsumerAPI>({ add: consumersAdd, update: consumersUpdate }),
      }),
    );
    jest.mocked(jetstream).mockReturnValue(
      stub<JetStreamClient>({
        consumers: stub<Consumers>({ get: consumersGet }),
      }),
    );

    const bus = new NatsEventBus(configService);
    await bus.connect();
    return bus;
  }

  async function subscribe(bus: NatsEventBus): Promise<void> {
    await bus.subscribeWildcard('TenantSubscriptionChanged', {
      handle: () => Promise.resolve(HandlerOutcome.ack()),
      getEventType: () => 'TenantSubscriptionChanged',
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.mocked(buildNatsConnectionOptions).mockReturnValue({
      servers: ['tls://nats:4222'],
      reconnect: true,
      maxReconnectAttempts: 2,
      reconnectTimeWait: 1,
      authMode: 'mtls-cert',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a durable that does not exist yet, without touching update', async () => {
    consumersAdd = jest.fn().mockResolvedValue(stub<ConsumerInfo>({}));
    const bus = await boot();

    await subscribe(bus);

    expect(consumersAdd).toHaveBeenCalledWith(
      STREAM,
      expect.objectContaining({ durable_name: CONSUMER_NAME, filter_subject: SUBJECT }),
    );
    expect(consumersUpdate).not.toHaveBeenCalled();
    expect(consumersGet).toHaveBeenCalledWith(STREAM, CONSUMER_NAME);
  });

  it('updates a durable that exists with a previous configuration, keeping its name', async () => {
    consumersAdd = jest.fn().mockRejectedValue(alreadyExists());
    const bus = await boot();

    await subscribe(bus);

    expect(consumersUpdate).toHaveBeenCalledTimes(1);
    expect(consumersUpdate).toHaveBeenCalledWith(
      STREAM,
      CONSUMER_NAME,
      expect.objectContaining({ durable_name: CONSUMER_NAME, filter_subject: SUBJECT }),
    );
    expect(consumersGet).toHaveBeenCalledWith(STREAM, CONSUMER_NAME);
  });

  it('propagates every other creation failure without attempting an update', async () => {
    consumersAdd = jest.fn().mockRejectedValue(
      new JetStreamApiError({
        code: 400,
        err_code: 10012,
        description: 'deliver policy can not be updated',
      }),
    );
    const bus = await boot();

    await expect(subscribe(bus)).rejects.toThrow('deliver policy can not be updated');
    expect(consumersUpdate).not.toHaveBeenCalled();
  });
});
