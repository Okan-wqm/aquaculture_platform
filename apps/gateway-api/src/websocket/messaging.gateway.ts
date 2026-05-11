import { enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';
import { buildWsCorsConfig } from '@aquaculture/backend-common/websocket';
import { Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClientProxy } from '@nestjs/microservices';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
} from '@nestjs/websockets';
import { firstValueFrom, timeout } from 'rxjs';
import { Server, Socket } from 'socket.io';

// Types

/**
 * Decoded JWT payload for messaging clients.
 *
 * `type` and `jti` are required for `enforceAccessTokenType` — refresh
 * and MFA-challenge tokens carry `type !== 'access'` and must be
 * rejected at handshake (H-1 fix).
 */
interface TokenPayload {
  sub: string;
  tenantId?: string;
  roles?: string[];
  status?: string;
  type?: string;
  jti?: string;
  [key: string]: unknown;
}

interface ConnectedClient {
  socket: Socket;
  userId: string;
  tenantId: string;
  channels: Set<string>;
  reAuthFailures: number;
  lastTyping: Map<string, number>;
}

interface JoinChannelPayload { channelId: string }
interface LeaveChannelPayload { channelId: string }
interface TypingPayload { channelId: string }
interface MarkReadPayload { channelId: string; messageId: string }

const PRESENCE_TTL_SECONDS = 300;
const HEARTBEAT_INTERVAL_MS = 30_000;
const REAUTH_INTERVAL_MS = 5 * 60_000;
const MAX_REAUTH_FAILURES = 3;
const TYPING_THROTTLE_MS = 3_000;

/**
 * WebSocket Gateway for real-time messaging
 * Handles user presence, channel subscriptions, typing indicators, and read receipts.
 *
 * SECURITY:
 * - JWT authentication on connection with periodic re-auth
 * - CORS configured from environment
 * - Tenant isolation via channel membership checks
 * - Typing throttle to prevent abuse
 */
@WebSocketGateway({
  cors: buildWsCorsConfig('MessagingGateway'),
  namespace: '/messaging',
  transports: ['websocket', 'polling'],
})
export class MessagingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MessagingGateway.name);
  private clients = new Map<string, ConnectedClient>();
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private reAuthTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly isProduction: boolean;

  /** Timeout for NATS membership verification requests in ms */
  private static readonly NATS_VERIFY_TIMEOUT_MS = 5_000;

  /**
   * ConfigService is REQUIRED (no `@Optional()`): `getJwtVerifyOptions`
   * calls `getOrThrow<string>('JWT_SECRET')` on it, and the platform's
   * ConfigModule is global. A gateway instantiated without
   * ConfigService is a configuration error, not a supported deployment
   * mode — fail-fast at construction time.
   *
   * `REDIS_SERVICE` stays optional because it is used for presence TTL
   * tracking (set/del on a Redis key), which is a graceful-degrade
   * feature — messaging still works without presence. `NATS_SERVICE`
   * stays optional for the same reason (channel membership check falls
   * back to `false` when NATS is unavailable).
   */
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject('REDIS_SERVICE')
    private readonly redisService?: { getClient(): { set(key: string, value: string, mode: string, ttl: number): Promise<string>; del(key: string): Promise<number> } },
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    this.isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
  }

  /**
   * Lifecycle hook — runs after the Socket.IO server for this gateway
   * has been created and the app-level `RedisIoAdapter` (registered in
   * `main.ts` via `app.useWebSocketAdapter`) has already attached the
   * Redis pub/sub adapter to `server`. This gateway therefore does
   * NOT wire its own adapter — a per-gateway adapter would create a
   * duplicate pair of Redis pub/sub clients and fragment lifecycle
   * ownership for no benefit. See
   * `apps/gateway-api/src/websocket/adapters/redis-io.adapter.ts`
   * for the app-level design rationale.
   */
  afterInit(_server: Server): void {
    this.logger.log('Messaging WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token`);
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }

      const payload = await this.validateToken(token);
      if (!payload?.tenantId || !payload.sub) {
        this.logger.warn(`Client ${client.id} has invalid token`);
        client.emit('error', { message: 'Invalid token' });
        client.disconnect();
        return;
      }

      if (payload.status === 'suspended') {
        this.logger.warn(`Client ${client.id} user suspended`);
        client.emit('error', { code: 4403, message: 'User suspended' });
        client.disconnect();
        return;
      }

      const userId = payload.sub;
      const tenantId = payload.tenantId;

      this.clients.set(client.id, {
        socket: client,
        userId,
        tenantId,
        channels: new Set(),
        reAuthFailures: 0,
        lastTyping: new Map(),
      });

      // Join tenant room for presence broadcasts
      void client.join(`tenant:${tenantId}`);

      // Update presence in Redis
      await this.setPresence(tenantId, userId, 'online');

      // Start heartbeat timer
      const heartbeatTimer = setInterval(() => {
        void this.refreshPresence(client.id);
      }, HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimers.set(client.id, heartbeatTimer);

      // Start re-auth timer
      const reAuthTimer = setInterval(() => {
        this.requestReAuth(client.id);
      }, REAUTH_INTERVAL_MS);
      this.reAuthTimers.set(client.id, reAuthTimer);

      this.logger.log(
        `Client ${client.id} connected — user ${userId}, tenant ${tenantId}`,
      );

      client.emit('connected', {
        message: 'Connected to messaging',
        userId,
        tenantId,
      });

      // Broadcast presence to tenant
      this.server.to(`tenant:${tenantId}`).emit('presence', {
        userId,
        status: 'online',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(`Connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const clientData = this.clients.get(client.id);
    if (clientData) {
      // Clear presence
      await this.clearPresence(clientData.tenantId, clientData.userId);

      // Broadcast offline
      this.server.to(`tenant:${clientData.tenantId}`).emit('presence', {
        userId: clientData.userId,
        status: 'offline',
        timestamp: new Date().toISOString(),
      });
    }

    // Clear timers
    const heartbeatTimer = this.heartbeatTimers.get(client.id);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      this.heartbeatTimers.delete(client.id);
    }
    const reAuthTimer = this.reAuthTimers.get(client.id);
    if (reAuthTimer) {
      clearInterval(reAuthTimer);
      this.reAuthTimers.delete(client.id);
    }

    this.clients.delete(client.id);
    this.logger.log(`Client ${client.id} disconnected`);
  }

  @SubscribeMessage('joinChannel')
  async handleJoinChannel(
    client: Socket,
    payload: JoinChannelPayload,
  ): Promise<{ success: boolean; reason?: string }> {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, reason: 'Not authenticated' };
    }

    if (!payload?.channelId || typeof payload.channelId !== 'string') {
      return { success: false, reason: 'Invalid channelId' };
    }

    // Verify channel membership via NATS request-reply to messaging-service
    const isMember = await this.verifyChannelMembership(
      payload.channelId,
      clientData.userId,
      clientData.tenantId,
    );
    if (!isMember) {
      this.logger.warn(
        `Client ${client.id} denied join — not a member of channel ${payload.channelId}`,
      );
      return { success: false, reason: 'Not a member of this channel' };
    }

    const room = `channel:${clientData.tenantId}:${payload.channelId}`;
    clientData.channels.add(payload.channelId);
    void client.join(room);

    this.logger.debug(
      `Client ${client.id} joined channel ${payload.channelId}`,
    );
    return { success: true };
  }

  @SubscribeMessage('leaveChannel')
  handleLeaveChannel(
    client: Socket,
    payload: LeaveChannelPayload,
  ): { success: boolean } {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false };
    }

    if (!payload?.channelId) {
      return { success: false };
    }

    const room = `channel:${clientData.tenantId}:${payload.channelId}`;
    clientData.channels.delete(payload.channelId);
    void client.leave(room);

    this.logger.debug(
      `Client ${client.id} left channel ${payload.channelId}`,
    );
    return { success: true };
  }

  @SubscribeMessage('typing')
  handleTyping(
    client: Socket,
    payload: TypingPayload,
  ): { success: boolean; reason?: string } {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, reason: 'Not authenticated' };
    }

    if (!payload?.channelId || typeof payload.channelId !== 'string') {
      return { success: false, reason: 'Invalid channelId' };
    }

    // Throttle: max 1 typing event per 3 seconds per user per channel
    const throttleKey = payload.channelId;
    const now = Date.now();
    const lastTime = clientData.lastTyping.get(throttleKey) ?? 0;

    if (now - lastTime < TYPING_THROTTLE_MS) {
      return { success: false, reason: 'Throttled' };
    }

    clientData.lastTyping.set(throttleKey, now);

    // Broadcast typing to channel (except sender)
    client.to(`channel:${clientData.tenantId}:${payload.channelId}`).emit('typing', {
      userId: clientData.userId,
      channelId: payload.channelId,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  @SubscribeMessage('markRead')
  handleMarkRead(
    client: Socket,
    payload: MarkReadPayload,
  ): { success: boolean; reason?: string } {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, reason: 'Not authenticated' };
    }

    if (!payload?.channelId || !payload?.messageId) {
      return { success: false, reason: 'Invalid payload' };
    }

    // Broadcast read receipt to channel
    this.server.to(`channel:${clientData.tenantId}:${payload.channelId}`).emit('readReceipt', {
      userId: clientData.userId,
      channelId: payload.channelId,
      messageId: payload.messageId,
      timestamp: new Date().toISOString(),
    });

    return { success: true };
  }

  @SubscribeMessage('reAuthResponse')
  async handleReAuthResponse(
    client: Socket,
    payload: { token: string },
  ): Promise<{ success: boolean }> {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false };
    }

    if (!payload?.token || typeof payload.token !== 'string') {
      clientData.reAuthFailures++;
      this.checkReAuthFailures(client.id);
      return { success: false };
    }

    const decoded = await this.validateToken(payload.token);
    if (!decoded || decoded.sub !== clientData.userId) {
      clientData.reAuthFailures++;
      this.checkReAuthFailures(client.id);
      return { success: false };
    }

    if (decoded.status === 'suspended') {
      this.logger.warn(`User ${clientData.userId} suspended during re-auth`);
      client.emit('error', { code: 4403, message: 'User suspended' });
      client.disconnect();
      return { success: false };
    }

    // Reset failure counter on success
    clientData.reAuthFailures = 0;
    return { success: true };
  }

  broadcastNewMessage(tenantId: string, channelId: string, message: Record<string, unknown>): void {
    this.server.to(`channel:${tenantId}:${channelId}`).emit('newMessage', message);
  }

  broadcastMessageUpdated(tenantId: string, channelId: string, message: Record<string, unknown>): void {
    this.server.to(`channel:${tenantId}:${channelId}`).emit('messageUpdated', message);
  }

  broadcastMessageDeleted(tenantId: string, channelId: string, data: { messageId: string }): void {
    this.server.to(`channel:${tenantId}:${channelId}`).emit('messageDeleted', data);
  }

  broadcastReadReceipt(tenantId: string, channelId: string, data: Record<string, unknown>): void {
    this.server.to(`channel:${tenantId}:${channelId}`).emit('readReceipt', data);
  }

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  private requestReAuth(clientId: string): void {
    const clientData = this.clients.get(clientId);
    if (!clientData) return;

    clientData.socket.emit('reAuth', {
      message: 'Token refresh required',
      timestamp: new Date().toISOString(),
    });
  }

  private checkReAuthFailures(clientId: string): void {
    const clientData = this.clients.get(clientId);
    if (!clientData) return;

    if (clientData.reAuthFailures >= MAX_REAUTH_FAILURES) {
      this.logger.warn(
        `Client ${clientId} exceeded max re-auth failures, disconnecting`,
      );
      clientData.socket.emit('error', { code: 4401, message: 'Re-authentication failed' });
      clientData.socket.disconnect();
    }
  }

  private async refreshPresence(clientId: string): Promise<void> {
    const clientData = this.clients.get(clientId);
    if (!clientData) return;

    await this.setPresence(clientData.tenantId, clientData.userId, 'online');
  }

  private async setPresence(tenantId: string, userId: string, status: string): Promise<void> {
    try {
      const redisClient = this.redisService?.getClient();
      if (redisClient) {
        const key = `msg:${tenantId}:presence:${userId}`;
        await redisClient.set(key, status, 'EX', PRESENCE_TTL_SECONDS);
      }
    } catch (error) {
      this.logger.warn(`Failed to set presence: ${(error as Error).message}`);
    }
  }

  private async clearPresence(tenantId: string, userId: string): Promise<void> {
    try {
      const redisClient = this.redisService?.getClient();
      if (redisClient) {
        const key = `msg:${tenantId}:presence:${userId}`;
        await redisClient.del(key);
      }
    } catch (error) {
      this.logger.warn(`Failed to clear presence: ${(error as Error).message}`);
    }
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') {
      return auth.token;
    }

    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string') {
      if (this.isProduction) {
        this.logger.warn(
          `SECURITY: Client ${client.id} rejected — query parameter tokens not allowed in production`,
        );
        return null;
      }
      return queryToken;
    }

    return null;
  }

  /**
   * Validate a JWT token via the shared platform verification helpers.
   *
   * Uses `verifyAsync` (async, non-blocking) + `getJwtVerifyOptions`
   * which enforces HS256 + issuer + audience at the jsonwebtoken
   * library level, and `enforceAccessTokenType` which rejects refresh
   * and MFA-challenge tokens at handshake (H-1).
   *
   * The previous implementation used sync `verify()` with only
   * `algorithms: ['HS256']` — no iss, no aud, no type check. All four
   * gaps are closed by this refactor.
   */
  private async validateToken(token: string): Promise<TokenPayload | null> {
    try {
      const result = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      if (typeof result !== 'object' || result === null) return null;
      if (typeof result['sub'] !== 'string' || result['sub'].length === 0) {
        return null;
      }

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
    } catch (error) {
      this.logger.debug(`Token validation failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Verify channel membership via NATS request-reply to messaging-service.
   * Returns true if the user is an active member; false otherwise.
   * Gracefully defaults to false when NATS is unavailable.
   */
  private async verifyChannelMembership(
    channelId: string,
    userId: string,
    tenantId: string,
  ): Promise<boolean> {
    if (!this.natsClient) {
      this.logger.warn('NATS client not available — membership check skipped');
      return false;
    }
    try {
      const result = await firstValueFrom(
        this.natsClient
          .send<boolean>('request.messaging.verifyMembership', {
            channelId,
            userId,
            tenantId,
          })
          .pipe(timeout(MessagingGateway.NATS_VERIFY_TIMEOUT_MS)),
      );
      return !!result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Membership verification failed: ${message}`);
      return false;
    }
  }
}
