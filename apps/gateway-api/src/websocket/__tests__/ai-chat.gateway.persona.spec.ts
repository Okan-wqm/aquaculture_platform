import { of } from 'rxjs';
import { collaborator, stub } from '@aquaculture/testing';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import type { Socket } from 'socket.io';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';
import { AiChatGateway } from '../ai-chat.gateway';

/**
 * AISAFETY-MEDIUM-024 at the socket boundary: persona ids are validated with
 * the shared grammar (so a farm specialist id passes), an ill-formed id is a
 * BAD_REQUEST before anything is sent, and no persona means `null` — the
 * tenant default is resolved by ai-service, never defaulted here.
 */
describe('AiChatGateway persona forwarding', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';

  let gateway: AiChatGateway;
  let natsSend: jest.Mock;
  let emit: jest.Mock;
  let client: Socket;

  beforeEach(async () => {
    natsSend = jest.fn().mockReturnValue(
      of({
        content: 'ok',
        conversationId: 'c1',
        metadata: { persona: 'operator-v1' },
        toolCalls: [],
      }),
    );
    emit = jest.fn();
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: USER,
        tenantId: TENANT,
        type: 'access',
        jti: 'j1',
        roles: ['MODULE_USER'],
        resourcePermissions: ['ai_assistant:use', 'ai_personas:expert', 'ai_specialties:farm'],
      }),
    } as Partial<JwtService> as JwtService;
    const configService = {
      get: jest.fn().mockReturnValue('test'),
    } as Partial<ConfigService> as ConfigService;
    const natsClient = { send: natsSend } as Partial<ClientProxy> as ClientProxy;

    // SEC-MEDIUM-073/082: guard doubles (register/no-op semantics suffice
    // for persona-forwarding tests).
    const limiter = new TenantConnectionLimiter();
    const revalidator = new WsTokenRevalidator({
      intervalMs: 3_600_000,
      isStillValid: async () => true,
    });
    gateway = new AiChatGateway(jwtService, configService, limiter, revalidator, natsClient);
    // The handler touches only id / emit / disconnect / handshake; a
    // collaborator double fails loudly if the gateway ever reaches further.
    client = collaborator<Socket>(
      stub<Socket>({
        id: 'sock-1',
        emit,
        disconnect: jest.fn(),
        handshake: stub<Socket['handshake']>({ auth: { token: 't' }, headers: {} }),
      }),
      'Socket',
    );
    await gateway.handleConnection(client);
    emit.mockClear();
  });

  it('forwards a farm specialist id verbatim', async () => {
    await gateway.handleChat(client, { message: 'hi', persona: 'expert-farm-production-v1' });

    expect(natsSend).toHaveBeenCalledWith(
      'request.ai.chat',
      expect.objectContaining({
        tenantId: TENANT,
        userId: USER,
        persona: 'expert-farm-production-v1',
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      'ai:response',
      expect.objectContaining({ conversationId: 'c1' }),
    );
  });

  it('rejects an ill-formed persona id before sending', async () => {
    await gateway.handleChat(client, { message: 'hi', persona: 'bogus' });

    expect(natsSend).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('ai:error', {
      code: 'BAD_REQUEST',
      message: 'Invalid persona',
    });
  });

  it('sends null when no persona is named (tenant default, resolved by ai-service)', async () => {
    await gateway.handleChat(client, { message: 'hi' });

    expect(natsSend).toHaveBeenCalledWith(
      'request.ai.chat',
      expect.objectContaining({ persona: null }),
    );
  });
});
