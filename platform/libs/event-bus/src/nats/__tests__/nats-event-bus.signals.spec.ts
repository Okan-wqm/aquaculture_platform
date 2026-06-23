import 'reflect-metadata';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
// NATS v3 (@nats-io/* 3.x): the monolithic `nats` package was split. `connect`
// now lives in @nats-io/transport-node, and jetstream()/jetstreamManager() are
// top-level functions in @nats-io/jetstream (no longer methods on NatsConnection).
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NatsEventBus } from '../nats-event-bus';

jest.mock('@aquaculture/backend-common/nats', () => ({
  buildNatsConnectionOptions: jest.fn(),
}));

jest.mock('@nats-io/transport-node', () => {
  const actual = jest.requireActual<typeof import('@nats-io/transport-node')>(
    '@nats-io/transport-node',
  );
  return {
    ...actual,
    connect: jest.fn(),
  };
});

// v3: jetstream()/jetstreamManager() are top-level functions taking the
// connection (v2 exposed them as methods on NatsConnection). NatsEventBus.connect()
// calls them on the connected client, so they must be mocked to succeed here.
jest.mock('@nats-io/jetstream', () => {
  const actual = jest.requireActual('@nats-io/jetstream');
  return {
    ...actual,
    jetstream: jest.fn(),
    jetstreamManager: jest.fn(),
  };
});

function config(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        NATS_URL: 'tls://nats:4222',
        NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
        SERVICE_NAME: 'auth-service',
        NATS_MAX_RECONNECT_ATTEMPTS: 1,
        NATS_RECONNECT_TIME_WAIT_MS: 1,
        ...overrides,
      };
      return key in values ? values[key] : defaultValue;
    }),
  } as unknown as ConfigService;
}

function successfulConnection(): NatsConnection {
  async function* status() {
    return;
  }
  // v3: jetstream()/jetstreamManager() are top-level functions, not methods on
  // the connection (mocked separately on the @nats-io/jetstream module). The
  // connection only needs status() for setupConnectionHandlers().
  return {
    status,
  } as unknown as NatsConnection;
}

describe('NatsEventBus boot invariant signals', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
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

    expect(
      () => new NatsEventBus(config({ NATS_STREAM_REPLICAS: '1' })),
    ).not.toThrow();
  });

  it('defaults stream replicas to 1 when NATS_STREAM_REPLICAS is unset', () => {
    process.env['NODE_ENV'] = 'production';

    expect(() => new NatsEventBus(config())).not.toThrow();
  });

  it('rejects an out-of-range NATS_STREAM_REPLICAS', () => {
    process.env['NODE_ENV'] = 'production';

    expect(
      () => new NatsEventBus(config({ NATS_STREAM_REPLICAS: '6' })),
    ).toThrow('NATS_STREAM_REPLICAS must be an integer from 1 to 5');
  });

  it('clamps JetStream stream replicas to 1 on a standalone server and warns', async () => {
    process.env['NODE_ENV'] = 'production';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const streamsAdd = jest.fn().mockResolvedValue(undefined);
    const manager = Object.assign(
      {} as Awaited<ReturnType<typeof jetstreamManager>>,
      {
        streams: {
          info: jest.fn().mockRejectedValue(new Error('stream not found')),
          add: streamsAdd,
        },
      },
    );
    // Standalone server: ServerInfo carries no `cluster` name.
    jest
      .mocked(connect)
      .mockResolvedValue(
        Object.assign(successfulConnection(), { info: { cluster: undefined } }),
      );
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(manager);

    await new NatsEventBus(config({ NATS_STREAM_REPLICAS: '3' })).onModuleInit();

    expect(streamsAdd).toHaveBeenCalledWith(
      expect.objectContaining({ num_replicas: 1 }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('clamping JetStream stream'),
      expect.objectContaining({ effectiveReplicas: 1 }),
    );
  });

  it('keeps the requested replicas on a clustered server', async () => {
    process.env['NODE_ENV'] = 'production';
    const streamsAdd = jest.fn().mockResolvedValue(undefined);
    const manager = Object.assign(
      {} as Awaited<ReturnType<typeof jetstreamManager>>,
      {
        streams: {
          info: jest.fn().mockRejectedValue(new Error('stream not found')),
          add: streamsAdd,
        },
      },
    );
    // Clustered server: ServerInfo reports a cluster name.
    jest
      .mocked(connect)
      .mockResolvedValue(
        Object.assign(successfulConnection(), { info: { cluster: 'aqua-cluster' } }),
      );
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest.mocked(jetstreamManager).mockResolvedValue(manager);

    await new NatsEventBus(config({ NATS_STREAM_REPLICAS: '3' })).onModuleInit();

    expect(streamsAdd).toHaveBeenCalledWith(
      expect.objectContaining({ num_replicas: 3 }),
    );
  });

  it('emits nats_auth_mode_mtls only after a successful connect', async () => {
    jest.mocked(connect).mockResolvedValue(successfulConnection());
    // v3: connect() resolves the JetStream client + manager via the top-level
    // jetstream()/jetstreamManager() functions (v2 returned them from the
    // connection's methods). Return empty stand-ins so connect() completes.
    jest.mocked(jetstream).mockReturnValue({} as ReturnType<typeof jetstream>);
    jest
      .mocked(jetstreamManager)
      .mockResolvedValue({} as Awaited<ReturnType<typeof jetstreamManager>>);

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

    await expect(new NatsEventBus(config()).connect()).rejects.toThrow(
      'broker down',
    );

    expect(logSpy).not.toHaveBeenCalledWith(
      'NATS auth mode: mtls-cert',
      expect.anything(),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to connect to NATS',
      expect.any(Error),
    );
  });
});
