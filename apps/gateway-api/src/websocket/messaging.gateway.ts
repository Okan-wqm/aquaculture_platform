import { Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

// Types

interface TokenPayload {
  sub: string;
  tenantId?: string;
  roles?: string[];
  status?: string;
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

// CORS Config (reuse pattern from SensorReadingsGateway)

function buildWsCorsConfig(): { origin: string[] | boolean; credentials: boolean; methods?: string[] } {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const originsConfig = process.env['WS_CORS_ORIGINS'] ?? '';
  const allowedOrigins = originsConfig
    ? originsConfig.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  if (allowedOrigins.length > 0) {
    return { origin: allowedOrigins, credentials: true, methods: ['GET', 'POST'] };
  }
  if (!isProduction) {
    return { origin: true, credentials: false, methods: ['GET', 'POST'] };
  }
  return { origin: false, credentials: false };
}

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
  cors: buildWsCorsConfig(),
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

  constructor(
    private readonly jwtService: JwtService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    @Inject('REDIS_SERVICE')
    private readonly redisService?: { getClient(): { set(key: string, value: string, mode: string, ttl: number): Promise<string>; del(key: string): Promise<number> } },
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    this.isProduction = process.env['NODE_ENV'] === 'production';
  }

  afterInit(): void {
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

      const payload = this.validateToken(token);
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
  handleReAuthResponse(
    client: Socket,
    payload: { token: string },
  ): { success: boolean } {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false };
    }

    if (!payload?.token || typeof payload.token !== 'string') {
      clientData.reAuthFailures++;
      this.checkReAuthFailures(client.id);
      return { success: false };
    }

    const decoded = this.validateToken(payload.token);
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

  private validateToken(token: string): TokenPayload | null {
    try {
      const result: unknown = this.jwtService.verify(token, {
        algorithms: ['HS256'],
      });
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
