import type { NatsConnection, Subscription } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import type { ReadPacket, WritePacket } from '@nestjs/microservices';
import {
  CONFIG_RUNTIME_INBOX_PREFIX,
  MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX,
} from '@platform/event-contracts';

import { buildNatsConnectionOptions } from '../nats-connection.factory';
import { NatsV3Client } from '../nats-v3-client.proxy';

jest.mock('@nats-io/transport-node', () => ({ connect: jest.fn() }));
jest.mock('../nats-connection.factory', () => ({ buildNatsConnectionOptions: jest.fn() }));

class RequestClient extends NatsV3Client {
  request(packet: ReadPacket, callback: (response: WritePacket) => void): () => void {
    return this.publish(packet, callback);
  }
}

describe('NatsV3Client reply inbox selection', () => {
  const unsubscribe = jest.fn();
  const subscription = Object.assign({} as Subscription, { unsubscribe });
  const subscribe = jest
    .fn<ReturnType<NatsConnection['subscribe']>, Parameters<NatsConnection['subscribe']>>()
    .mockReturnValue(subscription);
  const publish =
    jest.fn<ReturnType<NatsConnection['publish']>, Parameters<NatsConnection['publish']>>();
  const connection = Object.assign({} as NatsConnection, { subscribe, publish });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(buildNatsConnectionOptions).mockReturnValue({
      servers: ['tls://nats:4222'],
      authMode: 'mtls-cert',
      reconnect: true,
      maxReconnectAttempts: 1,
      reconnectTimeWait: 1,
      inboxPrefix: '_INBOXAUTH_SERVICE',
    });
    jest.mocked(connect).mockResolvedValue(connection);
  });

  it('subscribes and requests replies under the resolved certificate inbox by default', async () => {
    const client = new RequestClient({ serviceName: 'aquaculture-auth-service' });
    await client.connect();
    const callback = jest.fn();
    const cleanup = client.request(
      { pattern: 'request.farm.validateSiteAssignment', data: {} },
      callback,
    );

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ inboxPrefix: '_INBOXAUTH_SERVICE' }),
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(
      expect.stringMatching(/^_INBOXAUTH_SERVICE\.[^.]+$/),
      expect.any(Object),
    );
    subscribe.mock.calls.forEach(([reply]) => {
      expect(publish).toHaveBeenCalledWith(
        'request.farm.validateSiteAssignment',
        expect.any(Uint8Array),
        { reply },
      );
    });
    expect(callback).not.toHaveBeenCalled();
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each([CONFIG_RUNTIME_INBOX_PREFIX, MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX])(
    'preserves the explicit secret-returning domain inbox %s',
    async (inboxPrefix) => {
      const client = new RequestClient({ serviceName: 'consumer', inboxPrefix });
      await client.connect();
      client.request({ pattern: 'config.runtime.read', data: {} }, jest.fn());
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${inboxPrefix}\\.[^.]+$`)),
        expect.any(Object),
      );
      subscribe.mock.calls.forEach(([reply]) => {
        expect(publish).toHaveBeenCalledWith('config.runtime.read', expect.any(Uint8Array), {
          reply,
        });
      });
    },
  );
});
