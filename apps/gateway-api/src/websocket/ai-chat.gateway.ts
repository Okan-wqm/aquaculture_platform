import { enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';
import {
  hasResourcePermission,
  type ResourcePermissionUser,
} from '@aquaculture/backend-common/decorators';
import { buildWsCorsConfig } from '@aquaculture/backend-common/websocket';
import { Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClientProxy } from '@nestjs/microservices';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { firstValueFrom, timeout } from 'rxjs';
import { Server, Socket } from 'socket.io';

/** JWT claims we consume — the full claim set (incl. resourcePermissions) rides along. */
interface TokenPayload {
  sub: string;
  tenantId?: string;
  roles?: string[];
  status?: string;
  type?: string;
  jti?: string;
  resourcePermissions?: string[];
  [key: string]: unknown;
}

/** Per-connection identity resolved once at handshake. */
interface AiClient {
  userId: string;
  tenantId: string;
  roles: string[];
  resourcePermissions: string[];
}

interface AiChatMessagePayload {
  message: string;
  conversationId?: string;
  persona?: string;
}

/** Mirror of ai-service AiChatNatsResponse (loose NATS contract). */
interface AiChatNatsResponse {
  content: string;
  conversationId: string | null;
  metadata: Record<string, unknown> | null;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
  error?: { code: string; message: string };
}

const NATS_REQUEST_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_LEN = 10_000;
const PERSONA_RE = /^(operator|manager|expert|supervisor)-v\d+$/;

/**
 * AI assistant real-time gateway. The panel/mobile assistant opens a socket.io
 * connection to `/ai`, emits `ai:chat`, and receives `ai:response` — the same
 * NATS request-reply + socket.io path every other live surface uses (messaging,
 * sensor, st-language). This replaces the hand-rolled REST proxy
 * (`routes/v2/ai.routes.ts`): identity is the handshake JWT, ai-service is
 * reached over `request.ai.chat` (queue-grouped), and there is no bespoke auth,
 * path mismatch, or signing gap.
 */
@WebSocketGateway({
  namespace: '/ai',
  cors: buildWsCorsConfig('AiChatGateway'),
})
export class AiChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AiChatGateway.name);
  private readonly clients = new Map<string, AiClient>();
  private readonly isProduction: boolean;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    // Optional so the gateway still boots in environments without NATS wired;
    // an ai:chat then fails closed with a clear error rather than crashing.
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        client.emit('ai:error', { code: 'AUTH_REQUIRED', message: 'Authentication required' });
        client.disconnect();
        return;
      }
      const payload = await this.validateToken(token);
      if (!payload?.tenantId || !payload.sub) {
        client.emit('ai:error', { code: 'AUTH_INVALID', message: 'Invalid token' });
        client.disconnect();
        return;
      }
      if (payload.status === 'suspended') {
        client.emit('ai:error', { code: 'AUTH_SUSPENDED', message: 'User suspended' });
        client.disconnect();
        return;
      }
      this.clients.set(client.id, {
        userId: payload.sub,
        tenantId: payload.tenantId,
        roles: Array.isArray(payload.roles) ? payload.roles : [],
        resourcePermissions: Array.isArray(payload.resourcePermissions)
          ? payload.resourcePermissions
          : [],
      });
      client.emit('ai:connected', { userId: payload.sub, tenantId: payload.tenantId });
    } catch (error) {
      this.logger.warn(`AI socket ${client.id} auth failed: ${(error as Error).message}`);
      client.emit('ai:error', { code: 'AUTH_INVALID', message: 'Invalid token' });
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.clients.delete(client.id);
  }

  @SubscribeMessage('ai:chat')
  async handleChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: AiChatMessagePayload,
  ): Promise<void> {
    const identity = this.clients.get(client.id);
    if (!identity) {
      client.emit('ai:error', { code: 'AUTH_REQUIRED', message: 'Not authenticated' });
      return;
    }

    const message = body?.message?.trim();
    if (!message) {
      client.emit('ai:error', { code: 'BAD_REQUEST', message: 'A message is required' });
      return;
    }
    if (message.length > MAX_MESSAGE_LEN) {
      client.emit('ai:error', { code: 'BAD_REQUEST', message: 'Message too long' });
      return;
    }
    if (body.persona && !PERSONA_RE.test(body.persona)) {
      client.emit('ai:error', { code: 'BAD_REQUEST', message: 'Invalid persona' });
      return;
    }

    // Faz 7c: using the AI assistant needs ai_assistant:use (admins bypass).
    const user: ResourcePermissionUser = {
      roles: identity.roles,
      resourcePermissions: identity.resourcePermissions,
    };
    if (!hasResourcePermission(user, 'ai_assistant:use')) {
      client.emit('ai:error', {
        code: 'FORBIDDEN',
        message: 'Missing required permission: ai_assistant:use',
      });
      return;
    }

    if (!this.natsClient) {
      client.emit('ai:error', { code: 'UNAVAILABLE', message: 'AI service is not reachable' });
      return;
    }

    client.emit('ai:thinking', { conversationId: body.conversationId ?? null });

    try {
      const response = await firstValueFrom(
        this.natsClient
          .send<AiChatNatsResponse>('request.ai.chat', {
            tenantId: identity.tenantId,
            userId: identity.userId,
            message,
            conversationId: body.conversationId,
            persona: body.persona ?? 'operator-v1',
            userRoles: identity.roles,
            resourcePermissions: identity.resourcePermissions,
          })
          .pipe(timeout(NATS_REQUEST_TIMEOUT_MS)),
      );

      if (response.error) {
        client.emit('ai:error', { code: response.error.code, message: response.error.message });
        return;
      }
      client.emit('ai:response', {
        content: response.content,
        conversationId: response.conversationId,
        toolCalls: response.toolCalls ?? [],
        metadata: response.metadata,
      });
    } catch (error) {
      this.logger.error(
        `ai:chat request failed for tenant ${identity.tenantId}: ${(error as Error).message}`,
      );
      client.emit('ai:error', {
        code: 'INTERNAL',
        message: 'The AI request could not be completed.',
      });
    }
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7);
    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string' && !this.isProduction) return queryToken;
    return null;
  }

  private async validateToken(token: string): Promise<TokenPayload | null> {
    const result = await this.jwtService.verifyAsync<Record<string, unknown>>(
      token,
      getJwtVerifyOptions(this.configService),
    );
    if (typeof result !== 'object' || result === null) return null;
    if (typeof result['sub'] !== 'string' || result['sub'].length === 0) return null;
    enforceAccessTokenType(
      {
        type: typeof result['type'] === 'string' ? result['type'] : undefined,
        sub: result['sub'],
        jti: typeof result['jti'] === 'string' ? result['jti'] : undefined,
      },
      this.logger,
      this.isProduction,
    );
    return result as TokenPayload;
  }
}
