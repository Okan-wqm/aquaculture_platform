/**
 * FarmGateway
 *
 * Real-time WebSocket gateway for farm domain events. Receives domain events
 * from FarmNatsBridgeService (which subscribes to NATS) and pushes them to
 * connected Socket.IO clients filtered by tenant.
 *
 * Pattern mirrors `SensorReadingsGateway`:
 *   - JWT auth on connect (HS256, issuer + audience claim verification)
 *   - Per-client tenant isolation via `tenant:{tenantId}` Socket.IO room
 *   - Production CORS origin allow-list (WS_CORS_ORIGINS env var)
 *   - Query-parameter tokens rejected in production
 *
 * Subscription model (Phase B — coarse-grained):
 *   - Every authenticated client auto-joins its tenant room on connect
 *   - All farm domain events for a tenant are broadcast to that tenant's room
 *   - Per-farm / per-batch room granularity is reserved for Phase E once
 *     FarmOwnershipService can verify resource ownership against farm-service
 *
 * @see Phase B of farm domain real-time visibility plan.
 */

import { enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';
import { buildWsCorsConfig } from '@aquaculture/backend-common/websocket';
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
import * as promClient from 'prom-client';
import { Server, Socket } from 'socket.io';

/** Per-client state tracked by the gateway. */
interface FarmClient {
  socket: Socket;
  tenantId: string;
  userId?: string;
}

/**
 * Decoded JWT payload with tenant claim.
 *
 * `type` and `jti` are required by `enforceAccessTokenType` from
 * backend-common — refresh and MFA-challenge tokens carry `type !==
 * 'access'` and must be rejected at handshake (H-1 fix).
 */
interface TokenPayload {
  sub: string;
  tenantId?: string;
  type?: string;
  jti?: string;
  iss?: string;
  aud?: string | string[];
  [key: string]: unknown;
}
/**
 * Prometheus gauges for farm WebSocket operational health. Registered as
 * singletons on the default prom-client registry so multiple replicas and
 * test re-instantiations share the same metric objects. The `getSingleMetric`
 * guard prevents double-registration errors when NestJS rebuilds the module.
 */
const farmWsConnections =
  (promClient.register.getSingleMetric(
    'farm_ws_connected_clients',
  ) as promClient.Gauge<string>) ??
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
    help: 'Total number of farm domain events broadcast to tenant rooms',
    labelNames: ['tenant', 'event_type'] as const,
    registers: [promClient.register],
  });

@WebSocketGateway({
  cors: buildWsCorsConfig('FarmGateway'),
  namespace: '/farms',
  transports: ['websocket', 'polling'],
})
export class FarmGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
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
  ) {
    this.isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
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
        this.logger.warn(`Client ${client.id} connected without token`);
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }

      const payload = await this.validateToken(token);
      if (!payload?.tenantId) {
        this.logger.warn(`Client ${client.id} has invalid token`);
        client.emit('error', { message: 'Invalid token' });
        client.disconnect();
        return;
      }

      const tenantId = payload.tenantId;
      this.clients.set(client.id, {
        socket: client,
        tenantId,
        userId: typeof payload.sub === 'string' ? payload.sub : undefined,
      });

      // Auto-join tenant room — all farm events for this tenant land here.
      void client.join(`tenant:${tenantId}`);

      // Observability: bump the per-tenant connection gauge. Labelled by
      // tenant so the Grafana dashboard can show connection distribution
      // and detect tenants with zero or abnormally high connections.
      farmWsConnections.inc({ tenant: tenantId }, 1);

      this.logger.log(
        `Farm client ${client.id} connected for tenant ${tenantId}`,
      );
      client.emit('connected', {
        message: 'Connected to farm domain event stream',
        tenantId,
      });
    } catch (error) {
      this.logger.error(
        `Farm gateway connection error: ${(error as Error).message}`,
      );
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    const clientData = this.clients.get(client.id);
    this.clients.delete(client.id);
    if (clientData) {
      // Decrement the per-tenant gauge. Skipping the gauge update when
      // clientData is missing prevents double-decrement if the same socket
      // somehow disconnects twice.
      farmWsConnections.dec({ tenant: clientData.tenantId }, 1);
    }
    this.logger.log(`Farm client ${client.id} disconnected`);
  }

  // ── Broadcast methods (called by FarmNatsBridgeService) ──────────────
  // Each method emits to the tenant-scoped room. The bridge has already
  // validated event.tenantId before invoking these — gateway just routes.

  /**
   * Shared helper for all broadcast methods: emit to the tenant-scoped
   * Socket.IO room and bump the Prometheus counter. Keeping the
   * increment in a single place ensures no event type is silently
   * missed in the metric.
   */
  private emitFarmEvent(
    tenantId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): void {
    this.server.to(`tenant:${tenantId}`).emit(eventName, payload);
    farmWsBroadcasts.inc({ tenant: tenantId, event_type: eventName }, 1);
    this.logger.debug(`broadcast ${eventName} → tenant ${tenantId}`);
  }

  /** Broadcast a BatchCreated event to all connected clients of the tenant. */
  broadcastBatchCreated(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'batchCreated', payload);
  }

  /** Broadcast a BatchHarvested event. */
  broadcastBatchHarvested(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'batchHarvested', payload);
  }

  /** Broadcast a BatchTransferred event. */
  broadcastBatchTransferred(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'batchTransferred', payload);
  }

  /** Broadcast a BatchStatusChanged event. */
  broadcastBatchStatusChanged(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'batchStatusChanged', payload);
  }

  /** Broadcast a BatchClosed event. */
  broadcastBatchClosed(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'batchClosed', payload);
  }

  /** Broadcast a BatchAllocatedToTank event. */
  broadcastBatchAllocatedToTank(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'batchAllocatedToTank', payload);
  }

  /** Broadcast a MortalityRecorded event. */
  broadcastMortalityRecorded(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'mortalityRecorded', payload);
  }

  /** Broadcast a CullRecorded event. */
  broadcastCullRecorded(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'cullRecorded', payload);
  }

  /** Broadcast a FeedingRecorded event. */
  broadcastFeedingRecorded(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'feedingRecorded', payload);
  }

  /** Broadcast a FeedInventoryLow alert. */
  broadcastFeedInventoryLow(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    this.emitFarmEvent(tenantId, 'feedInventoryLow', payload);
  }

  /** Get connected client count (used by health probes / metrics). */
  getConnectedClientCount(): number {
    return this.clients.size;
  }

  // ── Private auth helpers ────────────────────────────────────────────

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
      const isProduction =
        this.configService?.get<string>('NODE_ENV') === 'production';
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
   * HS256 algorithm, the issuer claim, and the audience claim. This
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
  private async validateToken(token: string): Promise<TokenPayload | null> {
    try {
      const result = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      if (typeof result !== 'object' || result === null) return null;
      if (
        typeof result['tenantId'] !== 'string' ||
        result['tenantId'].length === 0
      ) {
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

      return result as TokenPayload;
    } catch (error) {
      this.logger.debug(
        `Farm token validation failed: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
