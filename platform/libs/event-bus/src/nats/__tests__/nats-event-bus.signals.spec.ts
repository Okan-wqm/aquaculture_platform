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

function config(): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        NATS_URL: 'tls://nats:4222',
        NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
        SERVICE_NAME: 'auth-service',
        NATS_MAX_RECONNECT_ATTEMPTS: 1,
        NATS_RECONNECT_TIME_WAIT_MS: 1,
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

  beforeEach(() => {
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
    jest.restoreAllMocks();
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
