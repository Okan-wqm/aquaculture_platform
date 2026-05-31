import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection } from 'nats';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';
import {
  JETSTREAM_DUPLICATE_WINDOW_NS,
  NatsEventBus,
} from '../nats-event-bus';

jest.mock('@aquaculture/backend-common/nats', () => ({
  buildNatsConnectionOptions: jest.fn(),
}));

jest.mock('nats', () => {
  const actual = jest.requireActual('nats');
  return {
    ...actual,
    connect: jest.fn(),
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
  return {
    jetstream: jest.fn(() => ({})),
    jetstreamManager: jest.fn(async () => ({})),
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

  it('keeps JetStream duplicate memory longer than the outbox lease window', () => {
    expect(JETSTREAM_DUPLICATE_WINDOW_NS).toBeGreaterThanOrEqual(
      10 * 60 * 1_000_000_000,
    );
  });
});
