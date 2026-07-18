/**
 * AMQP credential handling (SENSOR-MEDIUM-059).
 *
 * The adapter used to build an `amqp(s)://username:password@host` URL and hand
 * it to the driver — a string that leaks the password into stack traces,
 * structured logs, and the tenant-visible ConnectionTestResult.error on any
 * connect failure. These tests pin that credentials now travel as discrete
 * `Options.Connect` fields and that no credential-bearing URL string is ever
 * constructed or passed to the driver.
 */
import type { Options } from 'amqplib';
import * as amqplib from 'amqplib';
import { SsrfValidatorService } from '@aquaculture/backend-common/ai-safety';

import { AmqpAdapter, AmqpConfiguration } from '../amqp.adapter';

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

const PASSWORD = 'S3cr3t-broker-pw!';

const baseConfig: AmqpConfiguration = {
  host: 'broker.example.com',
  port: 5672,
  vhost: '/prod',
  username: 'svc-sensor',
  password: PASSWORD,
  exchangeName: 'sensors',
  exchangeType: 'topic',
  queueName: 'q.sensor',
  routingKey: 'sensor.#',
  durable: true,
  prefetchCount: 4,
  heartbeat: 30,
  useTls: false,
  messageFormat: 'json',
  sensorId: 's1',
  tenantId: 't1',
};

function makeChannel(): Record<string, jest.Mock> {
  return {
    prefetch: jest.fn().mockResolvedValue(undefined),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'q.sensor.resolved' }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function makeConnection(): Record<string, jest.Mock> {
  return {
    createChannel: jest.fn().mockResolvedValue(makeChannel()),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('AmqpAdapter credential handling (SENSOR-MEDIUM-059)', () => {
  let adapter: AmqpAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AmqpAdapter();
    jest.spyOn(SsrfValidatorService.prototype, 'validateHost').mockResolvedValue({ safe: true });
    jest.mocked(amqplib.connect).mockResolvedValue(makeConnection() as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('passes credentials as discrete connection options, never as a URL string', async () => {
    await adapter.connect(baseConfig);

    expect(amqplib.connect).toHaveBeenCalledTimes(1);
    const firstArg = jest.mocked(amqplib.connect).mock.calls[0]![0];

    // Options-object form — not a `user:pass@host` URL string.
    expect(typeof firstArg).not.toBe('string');
    const opts = firstArg as Options.Connect;
    expect(opts.username).toBe('svc-sensor');
    expect(opts.password).toBe(PASSWORD);
    expect(opts.hostname).toBe('broker.example.com');
    expect(opts.port).toBe(5672);
    expect(opts.vhost).toBe('/prod');
    expect(opts.protocol).toBe('amqp');
    expect(opts.heartbeat).toBe(30);
  });

  it('does not embed the password in any argument handed to the driver', async () => {
    await adapter.connect(baseConfig);

    // The password may legitimately appear as a discrete option field, but must
    // never appear inside a `username:password@` URL authority anywhere.
    const serialized = JSON.stringify(jest.mocked(amqplib.connect).mock.calls[0]);
    expect(serialized).not.toContain(`:${PASSWORD}@`);
    expect(serialized).not.toContain(`svc-sensor:${PASSWORD}`);
  });

  it('selects the amqps protocol when TLS is enabled', async () => {
    await adapter.connect({ ...baseConfig, useTls: true });

    const opts = jest.mocked(amqplib.connect).mock.calls[0]![0] as Options.Connect;
    expect(opts.protocol).toBe('amqps');
  });

  it('rejects an unsafe broker host before opening the connection', async () => {
    jest
      .spyOn(SsrfValidatorService.prototype, 'validateHost')
      .mockResolvedValue({ safe: false, reason: 'Localhost addresses are not allowed.' });

    await expect(adapter.connect({ ...baseConfig, host: '127.0.0.1' })).rejects.toThrow('Connection failed');
    expect(amqplib.connect).not.toHaveBeenCalled();
  });
});
