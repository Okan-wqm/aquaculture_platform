/**
 * FarmGateway
 *
 * Real-time WebSocket gateway for farm domain events. Receives domain events
 * from FarmNatsBridgeService (which subscribes to NATS) and pushes them to the
 * Socket.IO rooms their access entry derives (SEC-CRITICAL-206).
 *
 *   - JWT auth on connect (RS256, issuer + audience claim verification)
 *   - Production CORS origin allow-list (WS_CORS_ORIGINS env var)
 *   - Query-parameter tokens rejected in production
 *
 * Rooms (ADR-051 §3 step 1): a socket joins only the rooms `decideAccess`
 * allows from the token's `moduleAccess` and assigned sites — the farm module
 * room when the member is tenant-wide in farm, the room of each assigned site
 * when it holds a farm MODULE_USER grant, and the registry room of each module
 * of its common-registry scope. A socket allowed no room is refused. Every
 * event is emitted only through `broadcastFarmEvent`, whose rooms derive from
 * FARM_WS_EVENT_ACCESS (farm-ws-event-access.ts); no tenant-wide room exists.
 * A socket whose token is revoked — PKG-06 revokes it when a grant changes — is
 * dropped by WsTokenRevalidator within one 60 s cycle.
 */

import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as promClient from 'prom-client';
import { enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';
import {
  TenantConnectionLimiter,
  WsTokenRevalidator,
  buildWsCorsConfig,
  emitToModuleRooms,
  joinModuleRooms,
  socketMemberOf,
} from '@aquaculture/backend-common/websocket';

import {
  farmEventRooms,
  farmSocketEventName,
  farmSocketRooms,
  type FarmWsEvent,
  type FarmWsEventType,
} from './farm-ws-event-access';

/** Per-client state tracked by the gateway. */
interface FarmClient {
  socket: Socket;
  tenantId: string;
  userId: string;
}

/**
 * Prometheus gauges for farm WebSocket operational health. Registered as
 * singletons on the default prom-client registry so multiple replicas and
 * test re-instantiations share the same metric objects. The `getSingleMetric`
 * guard prevents double-registration errors when NestJS rebuilds the module.
 */
const farmWsConnections =
  (promClient.register.getSingleMetric('farm_ws_connected_clients') as promClient.Gauge<string>) ??
  new promClient.Gauge({
    name: 'farm_ws_connected_clients',
    help: 'Number of Socket.IO clients currently connected to /farms',
    labelNames: ['tenant'] as const,
    registers: [promClient.register],
  });

const farmWsBroadcasts =
  (promClient.register.getSingleMetric(
    'farm_ws_events_broadcast_total',
  ) as promClient.Counter<string>) ??
  new promClient.Counter({
    name: 'farm_ws_events_broadcast_total',
    help: 'Total number of farm domain events broadcast to module and registry rooms',
    labelNames: ['tenant', 'event_type'] as const,
    registers: [promClient.register],
  });

@WebSocketGateway({
  cors: buildWsCorsConfig('FarmGateway'),
  namespace: '/farms',
  transports: ['websocket', 'polling'],
})
export class FarmGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(FarmGateway.name);
  private clients = new Map<string, FarmClient>();
  private readonly isProduction: boolean;

  /**
   * ConfigService is REQUIRED (no `@Optional()`): the shared
   * `getJwtVerifyOptions` helper calls `configService.getOrThrow`
   * for JWT_SECRET, and the platform's ConfigModule is global. A
   * gateway instantiated without ConfigService is a configuration
   * error, not a supported deployment mode — fail-fast at
   * construction time rather than logging warnings at runtime.
   */
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    // SEC-MEDIUM-073/082 (2026-08-23 scan №26/№18): shared socket guards
    private readonly connectionLimiter: TenantConnectionLimiter,
    private readonly tokenRevalidator: WsTokenRevalidator,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    // CORS allowlist validity is enforced at module-load time by
    // `buildWsCorsConfig('FarmGateway')`, which throws in production
    // if WS_CORS_ORIGINS is missing. No per-instance check needed —
    // if the process is running, CORS is valid.
  }

  afterInit(): void {
    this.logger.log('Farm Gateway initialised on namespace /farms');
  }

  onModuleDestroy(): void {
    this.clients.clear();
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.refuse(client, 'Authentication required', 'connected without token');
        return;
      }

      const claims = await this.validateToken(token);
      if (claims === null) {
        this.refuse(client, 'Invalid token', 'has invalid token');
        return;
      }
      const member = socketMemberOf(claims);
      if (member === null) {
        this.refuse(client, 'Invalid token', 'has malformed access claims');
        return;
      }

      const { tenantId } = member;
      const userId = member.caller.userId;

      // SEC-CRITICAL-206: the rooms decideAccess allows; none means no farm event is the
      // member's to receive, so the socket is refused rather than held open.
      const rooms = farmSocketRooms(member);
      if (rooms.length === 0) {
        this.refuse(client, 'Forbidden', 'holds no farm or registry grant');
        return;
      }

      // SEC-MEDIUM-073 (№26): per-tenant connection ceiling — a single valid
      // token previously held unlimited sockets (FD exhaustion).
      if (!this.connectionLimiter.register(tenantId, client.id)) {
        this.refuse(client, 'Too many connections for this tenant', 'exceeded the tenant ceiling');
        return;
      }

      this.clients.set(client.id, { socket: client, tenantId, userId });

      // SEC-MEDIUM-082 (№18): re-check the handshake credential every cycle —
      // logout, suspension and a grant change now bound a live socket to one
      // revalidation interval.
      this.tokenRevalidator.register(client.id, {
        tenantId,
        userId,
        jti: typeof claims['jti'] === 'string' ? claims['jti'] : '',
        issuedAt: typeof claims['iat'] === 'number' ? claims['iat'] : undefined,
        disconnect: (reason) => {
          this.logger.warn(`Farm socket ${client.id} disconnected: ${reason}`);
          client.disconnect(true);
        },
      });

      await joinModuleRooms(client, rooms);

      // Observability: bump the per-tenant connection gauge. Labelled by
      // tenant so the Grafana dashboard can show connection distribution
      // and detect tenants with zero or abnormally high connections.
      farmWsConnections.inc({ tenant: tenantId }, 1);

      this.logger.log(`Farm client ${client.id} connected for tenant ${tenantId}`);
      client.emit('connected', {
        message: 'Connected to farm domain event stream',
        tenantId,
      });
    } catch (error) {
      this.logger.error(`Farm gateway connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    const clientData = this.clients.get(client.id);
    this.clients.delete(client.id);
    this.tokenRevalidator.unregister(client.id);
    if (clientData) {
      this.connectionLimiter.release(clientData.tenantId, client.id);
      // Decrement the per-tenant gauge. Skipping the gauge update when
      // clientData is missing prevents double-decrement if the same socket
      // somehow disconnects twice.
      farmWsConnections.dec({ tenant: clientData.tenantId }, 1);
    }
    this.logger.log(`Farm client ${client.id} disconnected`);
  }

  /**
   * Emit one bridged farm event (called by FarmNatsBridgeService, which has
   * validated the event and taken the tenant from the NATS subject). The rooms
   * derive from the event's FARM_WS_EVENT_ACCESS entry, so a farm-private
   * event reaches only the farm module room and its site room.
   */
  broadcastFarmEvent(tenantId: string, eventType: FarmWsEventType, event: FarmWsEvent): void {
    const eventName = farmSocketEventName(eventType);
    emitToModuleRooms(this.server, farmEventRooms(tenantId, eventType, event), eventName, event);
    farmWsBroadcasts.inc({ tenant: tenantId, event_type: eventName }, 1);
    this.logger.debug(`broadcast ${eventName} → tenant ${tenantId}`);
  }

  /** Get connected client count (used by health probes / metrics). */
  getConnectedClientCount(): number {
    return this.clients.size;
  }

  // ── Private auth helpers ────────────────────────────────────────────

  /** Tell the client why, then drop it. */
  private refuse(client: Socket, message: string, reason: string): void {
    this.logger.warn(`Farm client ${client.id} refused: ${reason}`);
    client.emit('error', { message });
    client.disconnect();
  }

  /**
   * Extract JWT token from the client handshake. Priority order:
   *   1. handshake.auth.token
   *   2. Authorization: Bearer header
   *   3. Query parameter (REJECTED in production for security)
   */
  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;

    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string') {
      const isProduction = this.configService?.get<string>('NODE_ENV') === 'production';
      if (isProduction) {
        this.logger.warn(
          `SECURITY: Farm client ${client.id} rejected — query parameter ` +
            `tokens not allowed in production.`,
        );
        return null;
      }
      return queryToken;
    }
    return null;
  }

  /**
   * Validate a JWT token asynchronously via the shared platform
   * verification helpers.
   *
   * Uses `getJwtVerifyOptions(configService)` to enforce — at the
   * jsonwebtoken library level, not by conditional checks — the
   * RS256 algorithm, the issuer claim, and the audience claim. This
   * closes the "conditional `if (payload.iss && ...)` bypass" where
   * tokens without `iss` or `aud` were silently accepted by the
   * previous inline implementation.
   *
   * After verifyAsync succeeds, `enforceAccessTokenType` throws if
   * `payload.type !== 'access'` — refusing refresh tokens (7-day TTL)
   * and MFA-challenge tokens (pre-2FA) at the WebSocket handshake.
   * This is H-1 from the comprehensive review and closes an auth
   * bypass where long-lived non-access tokens could establish live
   * event streams.
   *
   * Any failure — verification error, wrong token type, missing jti
   * in production — returns `null` so the caller can cleanly
   * disconnect the client with a generic error.
   */
  private async validateToken(token: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      if (typeof result !== 'object' || result === null) return null;
      if (typeof result['tenantId'] !== 'string' || result['tenantId'].length === 0) {
        return null;
      }
      if (typeof result['sub'] !== 'string' || result['sub'].length === 0) {
        return null;
      }

      // H-1 enforcement: reject refresh + MFA-challenge tokens.
      // Throws UnauthorizedException on failure — caught and converted
      // to `null` below so the gateway disconnects gracefully.
      enforceAccessTokenType(
        {
          type: typeof result['type'] === 'string' ? result['type'] : undefined,
          sub: result['sub'],
          jti: typeof result['jti'] === 'string' ? result['jti'] : undefined,
        },
        this.logger,
        this.isProduction,
      );

      return result;
    } catch (error) {
      this.logger.debug(`Farm token validation failed: ${(error as Error).message}`);
      return null;
    }
  }
}
