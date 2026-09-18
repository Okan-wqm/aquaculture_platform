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
import {
  GET_MESSAGE_FOR_BROADCAST_SUBJECT,
  type GetMessageForBroadcastRequest,
  type GetMessageForBroadcastResponse,
  type MessageEnvelope,
} from '@platform/event-contracts';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

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

/**
 * Minimal Redis capability the gateway's presence tracking needs. Kept as a
 * structural type (not the full ioredis surface) so tests mock three calls.
 *
 * MSGFIX-FAZ3 3.4 NOTE: the `REDIS_SERVICE` token is currently NOT provided
 * by any module in gateway-api — `@Optional()` means presence writes are
 * INERT in production until an owner wires a client. The multi-device
 * connection counter below is nevertheless implemented correctly against
 * this interface so the ghost-presence bug is structurally fixed the moment
 * the client is provided. See DEPLOY-FAZ3.md §presence for the full
 * diagnosis (missing provider + `gateway:` key prefix + REDIS_DB 0 vs 3
 * mismatch vs messaging-service's PresenceService keyspace).
 */
interface PresenceRedisClient {
  set(key: string, value: string, mode: string, ttl: number): Promise<string>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
}

interface ConnectedClient {
  socket: Socket;
  userId: string;
  tenantId: string;
  channels: Set<string>;
  reAuthFailures: number;
  lastTyping: Map<string, number>;
}

interface JoinChannelPayload {
  channelId: string;
}
interface LeaveChannelPayload {
  channelId: string;
}
interface TypingPayload {
  channelId: string;
  isTyping?: boolean;
}
interface ResolveNotificationRefPayload {
  notificationRef: string;
}
interface ResolveNotificationRefResult {
  channelId: string;
  messageId: string;
  messageCreatedAt: string;
}

const PRESENCE_TTL_SECONDS = 300;
/**
 * TTL guard for the per-user connection counter (MSGFIX-FAZ3 3.4). Refreshed
 * by every socket heartbeat (30s) — a pod killed without disconnect events
 * leaks its INCRs for at most this long before the key expires and the next
 * connect re-detects a clean 0→1 transition.
 */
const PRESENCE_CONNS_TTL_SECONDS = 300;
const HEARTBEAT_INTERVAL_MS = 30_000;
const REAUTH_INTERVAL_MS = 5 * 60_000;
const MAX_REAUTH_FAILURES = 3;
const TYPING_THROTTLE_MS = 3_000;
const CLUSTER_CHANNEL_MEMBER_REMOVED_EVENT = 'messaging:channelMemberRemoved';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
export class MessagingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
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
    // SEC-MEDIUM-073/082 (2026-08-23 scan №26/№18)
    private readonly connectionLimiter: TenantConnectionLimiter,
    private readonly tokenRevalidator: WsTokenRevalidator,
    @Optional()
    @Inject('REDIS_SERVICE')
    private readonly redisService?: { getClient(): PresenceRedisClient },
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
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
    const clusterAwareServer = _server as Server & {
      on(event: string, listener: (...args: unknown[]) => void): Server;
    };
    clusterAwareServer.on(CLUSTER_CHANNEL_MEMBER_REMOVED_EVENT, (tenantId, channelId, userId) => {
      if (
        typeof tenantId === 'string' &&
        typeof channelId === 'string' &&
        typeof userId === 'string'
      ) {
        this.evictUserFromChannelLocal(tenantId, channelId, userId);
      }
    });
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

      // SEC-MEDIUM-073 (№26): per-tenant ceiling.
      if (!this.connectionLimiter.register(tenantId, client.id)) {
        this.logger.warn(`Tenant ${tenantId} exceeded its WS connection ceiling`);
        client.emit('error', { message: 'Too many connections for this tenant' });
        client.disconnect();
        return;
      }

      // SEC-MEDIUM-082 (№18): hard revocation re-check every cycle — the
      // soft reAuth protocol (best effort, no deadline) stays, but logout /
      // logout-all / suspension no longer depends on the client answering.
      this.tokenRevalidator.register(client.id, {
        tenantId,
        userId,
        jti: typeof payload.jti === 'string' ? payload.jti : '',
        issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
        disconnect: (reason) => {
          this.logger.warn(`Messaging socket ${client.id} disconnected: ${reason}`);
          client.disconnect(true);
        },
      });

      this.clients.set(client.id, {
        socket: client,
        userId,
        tenantId,
        channels: new Set(),
        reAuthFailures: 0,
        lastTyping: new Map(),
      });

      // Join the per-user room (used by evictUserFromChannel / channelMemberRemoved
      // delivery). MSGFIX-FAZ3 3.4: the `tenant:{tenantId}` room join is REMOVED —
      // its only consumer was the N×N `presence` broadcast below, which is also
      // removed (see the comment at the former broadcast site).
      void client.join(`user:${tenantId}:${userId}`);

      // MSGFIX-FAZ3 3.4 (ghost presence, multi-device): the user's presence is
      // now gated by a per-USER connection counter, not by this socket. INCR on
      // connect; only the 0→1 transition (first live socket) marks the user
      // online. Previously ANY connect wrote `online` and ANY disconnect
      // cleared it — the second device going away flipped a still-connected
      // user offline ("ghost offline"), and a reconnect flipped them back,
      // flapping presence on every device switch. The counter lives in Redis,
      // so it is correct across multiple gateway pods; a 5-minute TTL guard
      // (refreshed by every heartbeat) leaks at most one stale counter entry
      // when a pod dies without firing disconnects.
      const becameOnline = await this.incrementPresenceConnections(tenantId, userId);
      if (becameOnline) {
        await this.setPresence(tenantId, userId, 'online');
      }

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

      this.logger.log(`Client ${client.id} connected — user ${userId}, tenant ${tenantId}`);

      client.emit('connected', {
        message: 'Connected to messaging',
        userId,
        tenantId,
      });

      // MSGFIX-FAZ3 3.4: the previous `server.to(`tenant:${tenantId}`)
      // .emit('presence', { userId, isOnline: true, ... })` broadcast is
      // REMOVED. No client consumes the `presence` socket event (the web
      // panel does not subscribe; presence is read through the GraphQL
      // pipeline — messaging-service `userPresence` query backed by
      // PresenceService). Emitting it to every socket of every user in the
      // tenant made each connect/disconnect an N×N fan-out for zero readers.
      // If a socket-consumed presence stream is ever needed, it must be
      // opt-in per subscribing client (a dedicated room), never a tenant-wide
      // broadcast.
    } catch (error) {
      this.logger.error(`Connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const clientData = this.clients.get(client.id);
    this.tokenRevalidator.unregister(client.id);
    if (clientData) {
      this.connectionLimiter.release(clientData.tenantId, client.id);
      // MSGFIX-FAZ3 3.4: DECR the per-user connection counter; only the
      // 1→0 transition (last live socket for that user) clears presence.
      // A user's OTHER device disconnecting no longer marks them offline.
      // The former `tenant:`-wide offline broadcast is removed with its
      // online twin (see handleConnection).
      const becameOffline = await this.decrementPresenceConnections(
        clientData.tenantId,
        clientData.userId,
      );
      if (becameOffline) {
        await this.clearPresence(clientData.tenantId, clientData.userId);
      }
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

    this.logger.debug(`Client ${client.id} joined channel ${payload.channelId}`);
    return { success: true };
  }

  @SubscribeMessage('leaveChannel')
  handleLeaveChannel(client: Socket, payload: LeaveChannelPayload): { success: boolean } {
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

    this.logger.debug(`Client ${client.id} left channel ${payload.channelId}`);
    return { success: true };
  }

  @SubscribeMessage('typing')
  handleTyping(client: Socket, payload: TypingPayload): { success: boolean; reason?: string } {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, reason: 'Not authenticated' };
    }

    if (!payload?.channelId || typeof payload.channelId !== 'string') {
      return { success: false, reason: 'Invalid channelId' };
    }

    // Relay the client-supplied isTyping flag (default true for legacy clients).
    // Throttle only START-typing; a STOP (isTyping:false) must always propagate
    // so remote indicators clear promptly (MSG-HIGH-050: the gateway previously
    // dropped isTyping entirely and throttled stops, so indicators never showed).
    const isTyping = payload?.isTyping !== false;
    const throttleKey = payload.channelId;
    const now = Date.now();
    if (isTyping) {
      const lastTime = clientData.lastTyping.get(throttleKey) ?? 0;
      if (now - lastTime < TYPING_THROTTLE_MS) {
        return { success: false, reason: 'Throttled' };
      }
      clientData.lastTyping.set(throttleKey, now);
    }

    // Broadcast typing to channel (except sender) — TypingEnvelope carries isTyping
    client.to(`channel:${clientData.tenantId}:${payload.channelId}`).emit('typing', {
      userId: clientData.userId,
      channelId: payload.channelId,
      isTyping,
    });

    return { success: true };
  }

  // G1 removed (read-path SSoT): the socket-level `markRead` handler was
  // deleted. It broadcast a `readReceipt` to the channel room WITHOUT
  // persisting anything (no mark-read.handler, no outbox, no NATS) and always
  // returned { success: true } — producing fake "read" signals on the SAME
  // event + room as the real ones, so clients could not tell them apart.
  // The single read-receipt SSoT is the PERSISTENT path: MarkMessagesRead
  // mutation -> mark-read.handler (channel_members.lastReadAt + message_receipts
  // + outbox MessageRead, one transaction) -> NATS -> messaging-nats-bridge
  // `case 'MessageRead'` -> broadcastReadReceipt. Clients mark-as-read via that
  // mutation, never a socket emit.

  @SubscribeMessage('resolveNotificationRef')
  async handleResolveNotificationRef(
    client: Socket,
    payload: ResolveNotificationRefPayload,
  ): Promise<{
    success: boolean;
    reason?: string;
    channelId?: string;
    messageId?: string;
    messageCreatedAt?: string;
  }> {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, reason: 'Not authenticated' };
    }

    if (!payload?.notificationRef || !UUID_REGEX.test(payload.notificationRef)) {
      return { success: false, reason: 'Invalid notificationRef' };
    }

    if (!this.natsClient) {
      this.logger.warn('NATS client not available — notificationRef cannot be resolved');
      return { success: false, reason: 'Resolver unavailable' };
    }

    try {
      const result = await firstValueFrom(
        this.natsClient
          .send<ResolveNotificationRefResult | null>('request.messaging.resolveNotificationRef', {
            notificationRef: payload.notificationRef,
            tenantId: clientData.tenantId,
            userId: clientData.userId,
          })
          .pipe(timeout(MessagingGateway.NATS_VERIFY_TIMEOUT_MS)),
      );

      if (!result) {
        return { success: false, reason: 'Not found' };
      }

      return { success: true, ...result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`notificationRef resolution failed: ${message}`);
      return { success: false, reason: 'Resolver unavailable' };
    }
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

  // newMessage / messageUpdated are emitted ONLY via broadcastHydratedMessage
  // (below), so a thin/flat payload can never reach the client by accident
  // (the MSG-CRITICAL-050 root cause). The old flat-payload broadcastNewMessage
  // / broadcastMessageUpdated emitters were removed.

  broadcastMessageDeleted(tenantId: string, channelId: string, data: { messageId: string }): void {
    // MessageDeletedEnvelope carries channelId so the client targets the right
    // cache key (MSG-MEDIUM-050: the previous payload omitted it).
    this.server
      .to(`channel:${tenantId}:${channelId}`)
      .emit('messageDeleted', { channelId, messageId: data.messageId });
  }

  broadcastReadReceipt(tenantId: string, channelId: string, data: Record<string, unknown>): void {
    this.server.to(`channel:${tenantId}:${channelId}`).emit('readReceipt', data);
  }

  /**
   * Hydrate a thin MessageSent/MessageUpdated/MessageForwarded event into the
   * full WsMessage the client renders, then emit the matching envelope to the
   * channel room (MSG-CRITICAL-050). The bridge cannot build the body itself —
   * it requests it from messaging-service over NATS. On a missing message or a
   * request failure the broadcast is dropped (never an empty envelope, which the
   * client would choke on).
   */
  async broadcastHydratedMessage(
    tenantId: string,
    channelId: string,
    messageId: string,
    eventName: 'newMessage' | 'messageUpdated',
  ): Promise<void> {
    if (!this.natsClient) {
      this.logger.warn(`Cannot hydrate ${eventName} for ${messageId}: NATS client unavailable`);
      return;
    }
    try {
      const request: GetMessageForBroadcastRequest = { tenantId, channelId, messageId };
      const response = await firstValueFrom(
        this.natsClient
          .send<
            GetMessageForBroadcastResponse,
            GetMessageForBroadcastRequest
          >(GET_MESSAGE_FOR_BROADCAST_SUBJECT, request)
          .pipe(timeout(MessagingGateway.NATS_VERIFY_TIMEOUT_MS)),
      );
      if (!response?.message) {
        this.logger.warn(
          `Hydration returned no message for ${messageId} in ${channelId}; emitting sync hint`,
        );
        this.broadcastMessageSyncHint(tenantId, channelId);
        return;
      }
      const envelope: MessageEnvelope = { channelId, message: response.message };
      this.server.to(`channel:${tenantId}:${channelId}`).emit(eventName, envelope);
    } catch (error) {
      this.logger.warn(
        `Hydration request failed for ${messageId} in ${channelId}: ${(error as Error).message}; emitting sync hint`,
      );
      this.broadcastMessageSyncHint(tenantId, channelId);
    }
  }

  /**
   * MSG-HIGH-063: emit a content-free "something is new in this channel, refetch"
   * hint. The newMessage/messageUpdated fan-out requires a synchronous NATS
   * hydration round-trip; when that times out or returns nothing the gateway would
   * otherwise DROP the event with no redelivery (the NATS bridge consumes core
   * NATS, not a JetStream durable consumer), leaving the message permanently absent
   * from an open chat until a manual refresh. This hint makes the drop RECOVERABLE:
   * the client invalidates the channel's message cache and refetches, converging on
   * server truth. It carries no message content, so it cannot corrupt the client
   * cache the way a mis-shaped envelope would.
   */
  private broadcastMessageSyncHint(tenantId: string, channelId: string): void {
    this.server.to(`channel:${tenantId}:${channelId}`).emit('messageSyncHint', { channelId });
  }

  /**
   * Channel lifecycle notification (created / member added / member removed).
   * Emitted on a DISTINCT `channelEvent` name — these MUST NOT ride the
   * `messageUpdated` channel (which now carries a full MessageEnvelope), or they
   * would corrupt the client's message cache (MSG-HIGH-050 / MSG-MEDIUM-050).
   */
  broadcastChannelEvent(
    tenantId: string,
    channelId: string,
    data: { eventType: string; userId?: string },
  ): void {
    this.server.to(`channel:${tenantId}:${channelId}`).emit('channelEvent', { channelId, ...data });
  }

  evictUserFromChannel(tenantId: string, channelId: string, userId: string): void {
    if (!tenantId || !channelId || !userId) {
      this.logger.warn(
        'Cannot evict messaging socket from channel: tenantId, channelId and userId are required',
      );
      return;
    }

    this.evictUserFromChannelLocal(tenantId, channelId, userId);

    const clusterAwareServer = this.server as Server & {
      serverSideEmit?: (event: string, ...args: unknown[]) => void;
    };
    clusterAwareServer.serverSideEmit?.(
      CLUSTER_CHANNEL_MEMBER_REMOVED_EVENT,
      tenantId,
      channelId,
      userId,
    );

    this.server.in(`user:${tenantId}:${userId}`).socketsLeave(`channel:${tenantId}:${channelId}`);
    this.server.to(`user:${tenantId}:${userId}`).emit('channelMemberRemoved', {
      tenantId,
      channelId,
      userId,
      timestamp: new Date().toISOString(),
    });
  }

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  private evictUserFromChannelLocal(tenantId: string, channelId: string, userId: string): void {
    const channelRoom = `channel:${tenantId}:${channelId}`;
    for (const clientData of this.clients.values()) {
      if (clientData.tenantId !== tenantId || clientData.userId !== userId) {
        continue;
      }
      clientData.channels.delete(channelId);
      void clientData.socket.leave(channelRoom);
    }
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
      this.logger.warn(`Client ${clientId} exceeded max re-auth failures, disconnecting`);
      clientData.socket.emit('error', { code: 4401, message: 'Re-authentication failed' });
      clientData.socket.disconnect();
    }
  }

  private async refreshPresence(clientId: string): Promise<void> {
    const clientData = this.clients.get(clientId);
    if (!clientData) return;

    // Keep the user's presence key alive while ANY socket heartbeats, and
    // keep the per-user connection counter's TTL guard fresh (a counter whose
    // whole owning pod died without disconnects must not outlive the guard).
    await this.setPresence(clientData.tenantId, clientData.userId, 'online');
    await this.refreshPresenceCounterTtl(clientData.tenantId, clientData.userId);
  }

  /** Per-user connection counter key (one per tenant+user, shared across pods). */
  private presenceConnsKey(tenantId: string, userId: string): string {
    return `msg:${tenantId}:presence:conns:${userId}`;
  }

  /**
   * INCR the per-user connection counter. Returns true only on the 0→1
   * transition (the user just came online on their first live socket).
   * Refreshes the TTL guard on every connect so a rebuilt key cannot inherit
   * a stale expiry.
   */
  private async incrementPresenceConnections(tenantId: string, userId: string): Promise<boolean> {
    const redisClient = this.redisService?.getClient();
    if (!redisClient) return false;
    try {
      const key = this.presenceConnsKey(tenantId, userId);
      const count = await redisClient.incr(key);
      await redisClient.expire(key, PRESENCE_CONNS_TTL_SECONDS);
      return count === 1;
    } catch (error) {
      // Fail-open: presence is a graceful-degrade feature; a Redis blip must
      // not drop the socket connection. Without the counter, setPresence is
      // skipped and the (Redis-read) presence pipeline simply stays as-is.
      this.logger.warn(`Presence INCR failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * DECR the per-user connection counter. Returns true only when the count
   * dropped to <= 0 (the user's LAST live socket went away) — the caller then
   * clears presence. The key is DELeted at zero (and on negative drift, e.g.
   * a DECR racing an expired key) so Redis's create-on-DECR-at--1 cannot
   * poison later 0→1 detection.
   */
  private async decrementPresenceConnections(tenantId: string, userId: string): Promise<boolean> {
    const redisClient = this.redisService?.getClient();
    if (!redisClient) return false;
    try {
      const key = this.presenceConnsKey(tenantId, userId);
      const count = await redisClient.decr(key);
      if (count <= 0) {
        await redisClient.del(key);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(`Presence DECR failed: ${(error as Error).message}`);
      return false;
    }
  }

  /** Refresh the counter's TTL guard (heartbeats keep it alive while sockets live). */
  private async refreshPresenceCounterTtl(tenantId: string, userId: string): Promise<void> {
    const redisClient = this.redisService?.getClient();
    if (!redisClient) return;
    try {
      await redisClient.expire(this.presenceConnsKey(tenantId, userId), PRESENCE_CONNS_TTL_SECONDS);
    } catch {
      // Heartbeat-scope best effort — never log-spam on a Redis blip.
    }
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
   * which enforces RS256 + issuer + audience at the jsonwebtoken
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
