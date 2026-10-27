import { of } from 'rxjs';
import { collaborator, stub } from '@aquaculture/testing';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import type { Socket } from 'socket.io';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

import { AiChatGateway } from '../ai-chat.gateway';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

interface Connected {
  gateway: AiChatGateway;
  client: Socket;
  natsSend: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}

async function connect(claims: Record<string, unknown>): Promise<Connected> {
  const natsSend = jest
    .fn()
    .mockReturnValue(of({ content: 'ok', conversationId: 'c1', metadata: null, toolCalls: [] }));
  const emit = jest.fn();
  const disconnect = jest.fn();
  const jwtService = {
    verifyAsync: jest.fn().mockResolvedValue({
      sub: USER,
      tenantId: TENANT,
      type: 'access',
      jti: 'j1',
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use'],
      ...claims,
    }),
  } as Partial<JwtService> as JwtService;
  const configService = {
    get: jest.fn().mockReturnValue('test'),
  } as Partial<ConfigService> as ConfigService;
  const natsClient = { send: natsSend } as Partial<ClientProxy> as ClientProxy;
  const gateway = new AiChatGateway(
    jwtService,
    configService,
    new TenantConnectionLimiter(),
    new WsTokenRevalidator({ intervalMs: 3_600_000, isStillValid: async () => true }),
    natsClient,
  );
  const client = collaborator<Socket>(
    stub<Socket>({
      id: 'sock-1',
      emit,
      disconnect,
      handshake: stub<Socket['handshake']>({ auth: { token: 't' }, headers: {} }),
    }),
    'Socket',
  );
  await gateway.handleConnection(client);
  return { gateway, client, natsSend, emit, disconnect };
}

/**
 * RBAC-HIGH-028 on the AI chat path: request.ai.chat carries the caller's module grants and
 * sites from the verified handshake token (ADR-051 §2 Transport), so ai-service can decide by
 * module once its tools gate (PKG-09, PKG-12). A token that predates the claim means no grants.
 */
describe('AiChatGateway forwards moduleAccess and assignedSiteIds (RBAC-HIGH-028)', () => {
  it('forwards the grants and sites of the handshake token', async () => {
    const connected = await connect({
      moduleAccess: { farm: 'MODULE_USER' },
      assignedSiteIds: [SITE],
    });

    await connected.gateway.handleChat(connected.client, { message: 'hi' });

    expect(connected.natsSend).toHaveBeenCalledWith(
      'request.ai.chat',
      expect.objectContaining({ moduleAccess: { farm: 'MODULE_USER' }, assignedSiteIds: [SITE] }),
    );
  });

  it('forwards no grants and no sites for a token that carries neither', async () => {
    const connected = await connect({});

    await connected.gateway.handleChat(connected.client, { message: 'hi' });

    expect(connected.natsSend).toHaveBeenCalledWith(
      'request.ai.chat',
      expect.objectContaining({ moduleAccess: {}, assignedSiteIds: [] }),
    );
  });

  it.each([
    ['moduleAccess', { moduleAccess: { alert: 'MODULE_USER' } }],
    ['moduleAccess', { moduleAccess: { farm: 'TENANT_ADMIN' } }],
    ['assignedSiteIds', { assignedSiteIds: 'S1' }],
  ])('refuses a handshake whose %s claim is malformed', async (_claim, claims) => {
    const connected = await connect(claims);

    expect(connected.emit).toHaveBeenCalledWith('ai:error', {
      code: 'AUTH_INVALID',
      message: 'Invalid token',
    });
    expect(connected.disconnect).toHaveBeenCalled();
    await connected.gateway.handleChat(connected.client, { message: 'hi' });
    expect(connected.natsSend).not.toHaveBeenCalled();
  });
});
