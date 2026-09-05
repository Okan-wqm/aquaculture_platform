import { of, throwError } from 'rxjs';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import type { Server } from 'socket.io';

import { MessagingGateway } from '../messaging.gateway';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

/**
 * broadcastHydratedMessage hydration-failure recovery (MSG-HIGH-063).
 *
 * The newMessage/messageUpdated fan-out requires a synchronous NATS hydration
 * round-trip. On timeout or an empty response the gateway used to DROP the event
 * with no redelivery (the bridge consumes core NATS), leaving the message
 * permanently absent from an open chat. It now emits a content-free messageSyncHint
 * to the channel room so the client refetches and converges. These tests pin that
 * a failure emits the hint (not the message) and success emits the message (not
 * the hint).
 */
describe('MessagingGateway.broadcastHydratedMessage — hydration failure recovery (MSG-HIGH-063)', () => {
  let gateway: MessagingGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let natsSend: jest.Mock;

  beforeEach(() => {
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    natsSend = jest.fn();

    const jwtService = {} as Partial<JwtService> as JwtService;
    const configService = {
      get: jest.fn().mockReturnValue('test'),
    } as Partial<ConfigService> as ConfigService;
    const natsClient = { send: natsSend } as Partial<ClientProxy> as ClientProxy;

    // SEC-MEDIUM-073/082: guard doubles (register/no-op semantics suffice
    // for hydration-broadcast tests).
    const limiter = new TenantConnectionLimiter();
    const revalidator = new WsTokenRevalidator({
      intervalMs: 3_600_000,
      isStillValid: async () => true,
    });
    gateway = new MessagingGateway(
      jwtService,
      configService,
      limiter,
      revalidator,
      undefined,
      natsClient,
    );
    gateway.server = { to } as Partial<Server> as Server;
  });

  it('emits messageSyncHint (not the message) when hydration returns no message', async () => {
    natsSend.mockReturnValue(of({ message: null }));

    await gateway.broadcastHydratedMessage('t1', 'c1', 'm1', 'newMessage');

    expect(to).toHaveBeenCalledWith('channel:t1:c1');
    expect(emit).toHaveBeenCalledWith('messageSyncHint', { channelId: 'c1' });
    expect(emit).not.toHaveBeenCalledWith('newMessage', expect.anything());
  });

  it('emits messageSyncHint when the hydration request throws (timeout)', async () => {
    natsSend.mockReturnValue(throwError(() => new Error('NATS timeout')));

    await gateway.broadcastHydratedMessage('t1', 'c1', 'm1', 'newMessage');

    expect(emit).toHaveBeenCalledWith('messageSyncHint', { channelId: 'c1' });
    expect(emit).not.toHaveBeenCalledWith('newMessage', expect.anything());
  });

  it('emits the hydrated newMessage (never a hint) on success', async () => {
    const message = { id: 'm1', channelId: 'c1', content: 'hi' };
    natsSend.mockReturnValue(of({ message }));

    await gateway.broadcastHydratedMessage('t1', 'c1', 'm1', 'newMessage');

    expect(emit).toHaveBeenCalledWith('newMessage', { channelId: 'c1', message });
    expect(emit).not.toHaveBeenCalledWith('messageSyncHint', expect.anything());
  });
});
