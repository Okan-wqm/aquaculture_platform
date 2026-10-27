import { collaborator, stub } from '@aquaculture/testing';
import type { Msg, NatsConnection, Subscription } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import type { ConfigService } from '@nestjs/config';

import { NatsBridgeService } from '../nats-bridge.service';
import type { SensorReadingsGateway } from '../sensor-readings.gateway';

jest.mock('@nats-io/transport-node', () => ({ connect: jest.fn() }));

const T = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const SENSOR = '44444444-4444-4444-8444-444444444444';
const S9 = '33333333-3333-4333-8333-333333333339';
const READING_SUBJECT = 'telemetry.*.SensorReading';

interface Harness {
  bridge: NatsBridgeService;
  broadcastSensorReading: jest.Mock;
  drained: Promise<void>;
}

function reading(tenantId: string): Record<string, unknown> {
  return {
    eventId: 'e1',
    eventType: 'SensorReading',
    version: 3,
    timestamp: '2026-10-27T00:00:00.000Z',
    tenantId,
    sensorId: SENSOR,
    sensorName: 'DO probe',
    siteId: S9,
    readingDissolvedOxygen: 7.2,
  };
}

function message(subject: string, payload: Record<string, unknown>): Msg {
  return collaborator<Msg>({ subject, string: () => JSON.stringify(payload) }, 'Msg');
}

/** A subscription that yields `messages` once; `drained` settles after the bridge handled all. */
function subscriptionOf(messages: readonly Msg[]): { sub: Subscription; drained: Promise<void> } {
  let settle: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    settle = resolve;
  });
  async function* iterate(): AsyncGenerator<Msg> {
    try {
      yield* messages;
    } finally {
      settle();
    }
  }
  const sub = collaborator<Subscription>(
    { [Symbol.asyncIterator]: () => iterate(), unsubscribe: jest.fn() },
    'Subscription',
  );
  return { sub, drained };
}

async function* noStatus(): AsyncGenerator<never> {
  // The connection reports no status change during a spec.
}

async function harness(messages: readonly Msg[]): Promise<Harness> {
  const readings = subscriptionOf(messages);
  const idle = subscriptionOf([]);
  const connection = collaborator<NatsConnection>(
    {
      subscribe: jest
        .fn()
        .mockImplementation((subject: string) =>
          subject === READING_SUBJECT ? readings.sub : idle.sub,
        ),
      status: () => noStatus(),
      isClosed: () => false,
      drain: jest.fn().mockResolvedValue(undefined),
    },
    'NatsConnection',
  );
  jest.mocked(connect).mockResolvedValue(connection);
  const broadcastSensorReading = jest.fn();
  const bridge = new NatsBridgeService(
    stub<ConfigService>({
      get: jest.fn().mockImplementation((_key: string, fallback?: unknown) => fallback),
    }),
    collaborator<SensorReadingsGateway>({ broadcastSensorReading }, 'SensorReadingsGateway'),
  );
  await bridge.onModuleInit();
  return { bridge, broadcastSensorReading, drained: readings.drained };
}

/**
 * SEC-CRITICAL-207: a sensor reading's room tenant comes from its NATS subject
 * (`telemetry.{tenant}.SensorReading`), which the broker stamps, never from the payload the
 * publisher controls (CR-1). A payload that names another tenant is dropped and reaches no room.
 */
describe('NatsBridgeService sensor readings (SEC-CRITICAL-207)', () => {
  it('forwards a reading under the tenant of its subject, with the site it names', async () => {
    const h = await harness([message(`telemetry.${T}.SensorReading`, reading(T))]);
    await h.drained;

    expect(h.broadcastSensorReading).toHaveBeenCalledWith(
      {
        eventId: 'e1',
        sensorId: SENSOR,
        sensorName: 'DO probe',
        tenantId: T,
        readings: { dissolvedOxygen: 7.2 },
        timestamp: '2026-10-27T00:00:00.000Z',
      },
      S9,
    );
    await h.bridge.onModuleDestroy();
  });

  it('drops a reading whose payload tenant differs from its subject tenant: it reaches no room', async () => {
    const h = await harness([
      message(`telemetry.${T}.SensorReading`, reading(OTHER_TENANT)),
      message(`telemetry.${OTHER_TENANT}.SensorReading`, reading(T)),
    ]);
    await h.drained;

    expect(h.broadcastSensorReading).not.toHaveBeenCalled();
    await h.bridge.onModuleDestroy();
  });

  it('drops a reading whose subject carries no canonical tenant id, even when the payload agrees', async () => {
    const h = await harness(
      ['system', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'].map((token) =>
        message(`telemetry.${token}.SensorReading`, reading(token)),
      ),
    );
    await h.drained;

    expect(h.broadcastSensorReading).not.toHaveBeenCalled();
    await h.bridge.onModuleDestroy();
  });
});
