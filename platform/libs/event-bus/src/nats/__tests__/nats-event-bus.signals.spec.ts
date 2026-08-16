import 'reflect-metadata';
// NATS v3 (@nats-io/* 3.x): the monolithic `nats` package was split. `connect`
// now lives in @nats-io/transport-node, and jetstream()/jetstreamManager() are
// top-level functions in @nats-io/jetstream (no longer methods on NatsConnection).
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { buildNatsConnectionOptions } from '../nats-connection.factory';
import { NatsEventBus } from '../nats-event-bus';

jest.mock('../nats-connection.factory', () => ({
  buildNatsConnectionOptions: jest.fn(),
  DEFAULT_NATS_URL: 'nats://localhost:4222',
}));

jest.mock('@nats-io/transport-node', () => {
  const actual =
    jest.requireActual<typeof import('@nats-io/transport-node')>('@nats-io/transport-node');
  return {
    ...actual,
    connect: jest.fn(),
  };
});

// v3: jetstream()/jetstreamManager() are top-level functions taking the
// connection (v2 exposed them as methods on NatsConnection). NatsEventBus.connect()
// calls them on the connected client, so they must be mocked to succeed here.
jest.mock('@nats-io/jetstream', () => {
  const actual =
    jest.requireActual<typeof import('@nats-io/jetstream')>('@nats-io/jetstream');
  return {
    ...actual,
    jetstream: jest.fn(),
    jetstreamManager: jest.fn(),
  };
});

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const configService = new ConfigService();
  const values: Record<string, unknown> = {
    NATS_URL: 'tls://nats:4222',
    NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
    SERVICE_NAME: 'auth-service',
    ...overrides,
  };
  jest
    .spyOn(configService, 'get')
    .mockImplementation((key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
    );
  return configService;
}

function completedAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
}

function successfulConnection(): NatsConnection {
  let closed = false;
  // v3: jetstream()/jetstreamManager() are top-level functions, not methods on
  // the connection (mocked separately on the @nats-io/jetstream module). The
  // connection only needs status() for setupConnectionHandlers().
  return Object.assign({} as NatsConnection, {
    status: () => completedAsyncIterable(),
    closed: () => new Promise<void>(() => undefined),
    drain: jest.fn(() => {
      closed = true;
      return Promise.resolve();
    }),
    close: jest.fn(() => {
      closed = true;
      return Promise.resolve();
    }),
    isClosed: () => closed,
  });
}

function successfulManager(): Awaited<ReturnType<typeof jetstreamManager>> {
  return Object.assign({} as Awaited<ReturnType<typeof jetstreamManager>>, {
    streams: {
      info: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue(undefined),
    },
  });
}

describe('NatsEventBus boot invariant signals', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalNodeEnv = process.env['NODE_ENV'];
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.mocked(buildNatsConnectionOptions).mockReturnValue({
      servers: ['tls://nats:4222'],
      reconnect: true,
      maxReconnectAttempts: 1,
      reconnectTimeWait: 1,
      authMode: 'mtls-cert',
    });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // Replica count is a TOPOLOGY property, not an environment property: a
  // single-node production deployment is valid because durability is owned by
  // the transactional outbox + event-store, not JetStream replication. The old
  // "must be ≥3 in production or throw" contract bricked the single-node droplet
  // (it demanded an R3 stream a standalone server cannot recover), so it is
  // gone — the value is range-validated and clamped to the live topology.
  it('accepts single-replica JetStream in production (durability is outbox-owned, not JetStream)', () => {
    process.env['NODE_ENV'] = 'production';

    expect(() => new NatsEventBus(config({ NATS_STREAM_REPLICAS: '1' }))).not.toThrow();
  });

  it('defaults stream replicas to 1 when NATS_STREAM_REPLICAS is unset', () => {
    process.env['NODE_ENV'] = 'production';

    expect(() => new NatsEventBus(config())).not.toThrow();
  });

  it('rejects an out-of-range NATS_STREAM_REPLICAS', () => {
    process.env['NODE_ENV'] = 'production';

    expect(() => new NatsEventBus(config({ NATS_STREAM_REPLICAS: '6' }))).toThrow(
      'NATS_STREAM_REPLICAS must be an integer from 1 to 5',
    );
  });

  it('uses the shared connection factory as reconnect-policy SSOT', async () => {
    jest.mocked(buildNatsConnectionOptions).mockReturnValue({
      servers: ['tls://nats:4222'],
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 3,
      authMode: 'mtls-cert',
    });
    jest.mocked(connect).mockResolvedValue(successfulConnection());
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(successfulManager());
    const eventBus = new NatsEventBus(
      config({
        NATS_MAX_RECONNECT_ATTEMPTS: 0,
        NATS_RECONNECT_TIME_WAIT_MS: 0,
      }),
    );

    await eventBus.connect();

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        maxReconnectAttempts: -1,
        reconnectTimeWait: 3,
      }),
    );
    await eventBus.disconnect();
  });

  it('rejects an invalid reconnect policy returned by the shared factory', async () => {
    jest.mocked(buildNatsConnectionOptions).mockReturnValueOnce({
      servers: ['tls://nats:4222'],
      reconnect: true,
      maxReconnectAttempts: 0,
      reconnectTimeWait: 1,
      authMode: 'mtls-cert',
    });

    await expect(new NatsEventBus(config()).connect()).rejects.toThrow(
      'NATS_MAX_RECONNECT_ATTEMPTS must be -1 or a positive integer',
    );
    expect(connect).not.toHaveBeenCalled();

    jest.mocked(buildNatsConnectionOptions).mockReturnValueOnce({
      servers: ['tls://nats:4222'],
      reconnect: true,
      maxReconnectAttempts: 1,
      reconnectTimeWait: 0,
      authMode: 'mtls-cert',
    });

    await expect(new NatsEventBus(config()).connect()).rejects.toThrow(
      'NATS_RECONNECT_TIME_WAIT_MS must be a positive integer',
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('fails optional startup closed instead of retrying an invalid reconnect policy', async () => {
    jest.useFakeTimers();
    jest.mocked(buildNatsConnectionOptions).mockReturnValue({
      servers: ['tls://nats:4222'],
      reconnect: true,
      maxReconnectAttempts: 0,
      reconnectTimeWait: 1,
      authMode: 'mtls-cert',
    });
    const eventBus = new NatsEventBus(config());

    await expect(eventBus.onModuleInit()).rejects.toThrow(
      'NATS_MAX_RECONNECT_ATTEMPTS must be -1 or a positive integer',
    );

    expect(connect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clamps JetStream stream replicas to 1 on a standalone server and warns', async () => {
    process.env['NODE_ENV'] = 'production';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const streamsAdd = jest.fn().mockResolvedValue(undefined);
    const manager = Object.assign({} as Awaited<ReturnType<typeof jetstreamManager>>, {
      streams: {
        info: jest.fn().mockRejectedValue(new Error('stream not found')),
        add: streamsAdd,
      },
    });
    // Standalone server: ServerInfo carries no `cluster` name.
    jest
      .mocked(connect)
      .mockResolvedValue(Object.assign(successfulConnection(), { info: { cluster: undefined } }));
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(manager);

    await new NatsEventBus(config({ NATS_STREAM_REPLICAS: '3' })).onModuleInit();

    expect(streamsAdd).toHaveBeenCalledWith(expect.objectContaining({ num_replicas: 1 }));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('clamping JetStream stream'),
      expect.objectContaining({ effectiveReplicas: 1 }),
    );
  });

  it('keeps the requested replicas on a clustered server', async () => {
    process.env['NODE_ENV'] = 'production';
    const streamsAdd = jest.fn().mockResolvedValue(undefined);
    const manager = Object.assign({} as Awaited<ReturnType<typeof jetstreamManager>>, {
      streams: {
        info: jest.fn().mockRejectedValue(new Error('stream not found')),
        add: streamsAdd,
      },
    });
    // Clustered server: ServerInfo reports a cluster name.
    jest
      .mocked(connect)
      .mockResolvedValue(
        Object.assign(successfulConnection(), { info: { cluster: 'aqua-cluster' } }),
      );
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(manager);

    await new NatsEventBus(config({ NATS_STREAM_REPLICAS: '3' })).onModuleInit();

    expect(streamsAdd).toHaveBeenCalledWith(expect.objectContaining({ num_replicas: 3 }));
  });

  it('emits nats_auth_mode_mtls only after a successful connect', async () => {
    jest.mocked(connect).mockResolvedValue(successfulConnection());
    // v3: connect() resolves the JetStream client + manager via the top-level
    // jetstream()/jetstreamManager() functions (v2 returned them from the
    // connection's methods). The manager also proves stream initialization
    // completes before the connected lifecycle is published.
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(successfulManager());

    await new NatsEventBus(config()).connect();

    expect(logSpy).toHaveBeenCalledWith(
      'NATS auth mode: mtls-cert',
      expect.objectContaining({
        bootSignal: 'nats_auth_mode_mtls',
        status: 'ok',
        authMode: 'mtls-cert',
      }),
    );
  });

  it('does not emit nats_auth_mode_mtls when connect fails', async () => {
    jest.mocked(connect).mockRejectedValue(new Error('broker down'));

    await expect(new NatsEventBus(config()).connect()).rejects.toThrow('broker down');

    expect(logSpy).not.toHaveBeenCalledWith('NATS auth mode: mtls-cert', expect.anything());
    expect(errorSpy).toHaveBeenCalledWith('Failed to connect to NATS', expect.any(Error));
  });

  it('detaches transport state and still closes when drain fails', async () => {
    let closed = false;
    const drain = jest.fn().mockRejectedValue(new Error('drain failed'));
    const close = jest.fn(() => {
      closed = true;
      return Promise.resolve();
    });
    const connection = Object.assign({} as NatsConnection, {
      status: () => completedAsyncIterable(),
      closed: () => new Promise<void>(() => undefined),
      drain,
      close,
      isClosed: () => closed,
    });
    jest.mocked(connect).mockResolvedValue(connection);
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(successfulManager());
    const eventBus = new NatsEventBus(config());
    await eventBus.connect();

    await expect(eventBus.disconnect()).rejects.toBeInstanceOf(AggregateError);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(eventBus.getRawConnection()).toBeNull();
    await expect(eventBus.getHealth()).resolves.toMatchObject({
      isHealthy: false,
      connectionState: 'disconnected',
    });
  });

  it('blocks a replacement connection until failed cleanup is confirmed closed', async () => {
    let closed = false;
    const firstConnection = Object.assign({} as NatsConnection, {
      status: () => completedAsyncIterable(),
      closed: () => new Promise<void>(() => undefined),
      drain: jest.fn().mockRejectedValue(new Error('drain failed')),
      close: jest.fn().mockRejectedValue(new Error('close failed')),
      isClosed: () => closed,
    });
    const secondConnection = successfulConnection();
    jest.mocked(connect).mockResolvedValueOnce(firstConnection).mockResolvedValue(secondConnection);
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(successfulManager());
    const eventBus = new NatsEventBus(config());
    await eventBus.connect();
    await expect(eventBus.disconnect()).rejects.toBeInstanceOf(AggregateError);

    await expect(eventBus.connect()).rejects.toThrow(
      'Cannot establish a replacement NATS connection before the previous connection closes',
    );
    expect(connect).toHaveBeenCalledTimes(1);

    closed = true;
    await eventBus.connect();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(eventBus.getRawConnection()).toBe(secondConnection);
    await eventBus.disconnect();
  });

  it('includes managed Core responder availability in event-bus health', async () => {
    const connection = successfulConnection();
    jest.mocked(connect).mockResolvedValue(connection);
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(successfulManager());
    const eventBus = new NatsEventBus(config());
    await eventBus.connect();

    eventBus.setCoreResponderAvailability('registration', false);
    await expect(eventBus.getHealth()).resolves.toMatchObject({
      isHealthy: false,
      connectionState: 'connected',
      errorMessage: 'One or more Core NATS responders are unavailable',
    });

    eventBus.setCoreResponderAvailability('registration', true);
    await expect(eventBus.getHealth()).resolves.toMatchObject({
      isHealthy: true,
      connectionState: 'connected',
    });
  });

  it('never opens a second socket while a live generation is disconnected or reconnecting', async () => {
    jest.useFakeTimers();
    let emitDisconnect!: () => void;
    let emitReconnecting!: () => void;
    let resolveClosed!: (error: Error) => void;
    let firstClosed = false;
    const disconnectStatus = new Promise<void>((resolve) => {
      emitDisconnect = resolve;
    });
    const reconnectingStatus = new Promise<void>((resolve) => {
      emitReconnecting = resolve;
    });
    const closed = new Promise<Error>((resolve) => {
      resolveClosed = resolve;
    });
    const firstConnection = Object.assign({} as NatsConnection, {
      status: async function* () {
        await disconnectStatus;
        yield { type: 'disconnect' } as const;
        await reconnectingStatus;
        yield { type: 'reconnecting' } as const;
      },
      closed: () => closed,
      drain: jest.fn(() => {
        firstClosed = true;
        return Promise.resolve();
      }),
      close: jest.fn(() => {
        firstClosed = true;
        return Promise.resolve();
      }),
      isClosed: () => firstClosed,
    });
    const replacementConnection = successfulConnection();
    jest
      .mocked(connect)
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(replacementConnection);
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(successfulManager());
    const eventBus = new NatsEventBus(config());
    await eventBus.connect();

    emitDisconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(eventBus.getCoreConnectionSnapshot().state).toBe('disconnected');
    await expect(eventBus.connect()).rejects.toThrow(
      'Existing NATS connection generation is recovering',
    );
    expect(connect).toHaveBeenCalledTimes(1);

    emitReconnecting();
    await jest.advanceTimersByTimeAsync(0);
    expect(eventBus.getCoreConnectionSnapshot().state).toBe('reconnecting');
    await expect(eventBus.connect()).rejects.toThrow(
      'Existing NATS connection generation is recovering',
    );
    expect(connect).toHaveBeenCalledTimes(1);

    firstClosed = true;
    resolveClosed(new Error('internal reconnect budget exhausted'));
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(eventBus.getCoreConnectionSnapshot()).toMatchObject({
      connection: replacementConnection,
      generation: 2,
      state: 'connected',
    });
    await eventBus.disconnect();
  });

  it('replaces an unexpectedly closed connection and advances its lifecycle generation', async () => {
    jest.useFakeTimers();
    let resolveFirstClosed!: (error: Error) => void;
    let firstClosed = false;
    const firstConnection = Object.assign({} as NatsConnection, {
      status: () => completedAsyncIterable(),
      closed: () =>
        new Promise<Error>((resolve) => {
          resolveFirstClosed = resolve;
        }),
      drain: jest.fn(() => {
        firstClosed = true;
        return Promise.resolve();
      }),
      close: jest.fn(() => {
        firstClosed = true;
        return Promise.resolve();
      }),
      isClosed: () => firstClosed,
    });
    const secondConnection = successfulConnection();
    jest
      .mocked(connect)
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection);
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    const manager = Object.assign({} as Awaited<ReturnType<typeof jetstreamManager>>, {
      streams: {
        info: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue(undefined),
      },
    });
    jest.mocked(jetstreamManager).mockResolvedValue(manager);
    const eventBus = new NatsEventBus(config());
    await eventBus.onModuleInit();
    const lifecycle: Array<{ generation: number; state: string }> = [];
    const removeListener = eventBus.onCoreConnectionLifecycle((snapshot) => {
      lifecycle.push({
        generation: snapshot.generation,
        state: snapshot.state,
      });
    });

    resolveFirstClosed(new Error('connection retry budget exhausted'));
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(eventBus.getCoreConnectionSnapshot()).toMatchObject({
      connection: secondConnection,
      generation: 2,
      state: 'connected',
    });
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        { generation: 1, state: 'connected' },
        { generation: 1, state: 'disconnected' },
        { generation: 2, state: 'connected' },
      ]),
    );

    removeListener();
    await eventBus.disconnect();
  });

  it('recovers after an outage longer than the per-connection reconnect budget', async () => {
    jest.useFakeTimers();
    const recoveredConnection = successfulConnection();
    jest
      .mocked(connect)
      .mockRejectedValueOnce(new Error('initial outage'))
      .mockRejectedValueOnce(new Error('outer generation one failed'))
      .mockRejectedValueOnce(new Error('outer generation two failed'))
      .mockResolvedValue(recoveredConnection);
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    const manager = Object.assign({} as Awaited<ReturnType<typeof jetstreamManager>>, {
      streams: {
        info: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue(undefined),
      },
    });
    jest.mocked(jetstreamManager).mockResolvedValue(manager);
    const eventBus = new NatsEventBus(config());

    await eventBus.onModuleInit();
    for (let generation = 0; generation < 3; generation += 1) {
      await jest.runOnlyPendingTimersAsync();
    }

    expect(connect).toHaveBeenCalledTimes(4);
    expect(eventBus.getCoreConnectionSnapshot()).toMatchObject({
      connection: recoveredConnection,
      generation: 1,
      state: 'connected',
    });
    expect(jest.getTimerCount()).toBe(0);
    await eventBus.onModuleDestroy();
  });

  it('retains outer recovery when its timer meets a concurrent connect attempt', async () => {
    jest.useFakeTimers();
    let rejectConcurrentConnect!: (error: Error) => void;
    const concurrentConnect = new Promise<NatsConnection>((_resolve, reject) => {
      rejectConcurrentConnect = reject;
    });
    const recoveredConnection = successfulConnection();
    jest
      .mocked(connect)
      .mockRejectedValueOnce(new Error('initial outage'))
      .mockReturnValueOnce(concurrentConnect)
      .mockResolvedValue(recoveredConnection);
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    const manager = Object.assign({} as Awaited<ReturnType<typeof jetstreamManager>>, {
      streams: {
        info: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue(undefined),
      },
    });
    jest.mocked(jetstreamManager).mockResolvedValue(manager);
    const eventBus = new NatsEventBus(config());
    await eventBus.onModuleInit();

    const externalConnect = eventBus.connect();
    jest.advanceTimersByTime(1);
    const observedExternalFailure = expect(externalConnect).rejects.toThrow(
      'concurrent connect failed',
    );
    rejectConcurrentConnect(new Error('concurrent connect failed'));
    await observedExternalFailure;
    await Promise.resolve();
    await Promise.resolve();

    expect(jest.getTimerCount()).toBe(1);
    await jest.runOnlyPendingTimersAsync();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(eventBus.getCoreConnectionSnapshot()).toMatchObject({
      connection: recoveredConnection,
      state: 'connected',
    });
    await eventBus.onModuleDestroy();
  });
});
