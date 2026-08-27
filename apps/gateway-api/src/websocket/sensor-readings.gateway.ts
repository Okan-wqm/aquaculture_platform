/**
 * WebSocket Gateway for real-time sensor readings.
 *
 * Receives events from NATS (via NatsBridgeService) and pushes them to
 * connected Socket.IO clients. Each client is authenticated via JWT and
 * scoped to a single tenant. Device ownership is verified via
 * DeviceOwnershipService (LRU-cached).
 */

import { Logger, Inject, Optional, OnModuleDestroy } from '@nestjs/common';
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

import { enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';
import { DEVICE_CODE_REGEX, UUID_REGEX } from '@aquaculture/backend-common/constants';
import { buildWsCorsConfig } from '@aquaculture/backend-common/websocket';

import { DeviceOwnershipService } from './services/device-ownership.service';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

/** Inbound sensor reading event from the NATS bridge. */
interface SensorReadingEvent {
  /** Deterministic source identity (Task 1.4) — the client's dedup key. */
  eventId: string;
  sensorId: string;
  sensorName: string;
  tenantId: string;
  readings: Record<string, number>;
  timestamp: string;
}

/** Per-client state tracked by the gateway. */
interface SubscribedClient {
  socket: Socket;
  tenantId: string;
  sensorIds: Set<string>;
  authorizedSensorIds: Set<string>;
}

/**
 * Decoded JWT payload with tenant and sensor claims.
 *
 * `type` and `jti` are required for `enforceAccessTokenType` — refresh
 * and MFA-challenge tokens carry `type !== 'access'` and must be
 * rejected at handshake (H-1 fix).
 */
interface TokenPayload {
  sub: string;
  tenantId?: string;
  sensorIds?: string[];
  type?: string;
  jti?: string;
  iss?: string;
  aud?: string | string[];
  [key: string]: unknown;
}

/** Structured representation of an edge device alarm event (ONEMLI-03). */
export interface EdgeDeviceAlarm {
  alarmId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  timestamp: string;
  acknowledged?: boolean;
}

/** Sensor authorization service interface. */
export interface ISensorAuthorizationService {
  isSensorOwnedByTenant(sensorId: string, tenantId: string): Promise<boolean>;
  getSensorsByTenant(tenantId: string): Promise<string[]>;
}

/** Injection token for sensor authorization service. */
export const SENSOR_AUTH_SERVICE = 'SENSOR_AUTH_SERVICE';

@WebSocketGateway({
  cors: buildWsCorsConfig('SensorReadingsGateway'),
  namespace: '/sensors',
  transports: ['websocket', 'polling'],
})
export class SensorReadingsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SensorReadingsGateway.name);
  private clients = new Map<string, SubscribedClient>();
  private readonly isProduction: boolean;

  /**
   * ConfigService is REQUIRED (no `@Optional()`): `getJwtVerifyOptions`
   * calls `getOrThrow<string>('JWT_SECRET')` on it. A gateway
   * instantiated without ConfigService is a configuration error, not
   * a supported deployment mode — fail-fast at construction time.
   */
  constructor(
    private readonly jwtService: JwtService,
    private readonly deviceOwnershipService: DeviceOwnershipService,
    private readonly configService: ConfigService,
    // SEC-MEDIUM-073/082 (2026-08-23 scan №26/№18): connection ceiling +
    // hard revocation re-check (subscription caps alone didn't bound sockets).
    private readonly connectionLimiter: TenantConnectionLimiter,
    private readonly tokenRevalidator: WsTokenRevalidator,
    @Optional()
    @Inject(SENSOR_AUTH_SERVICE)
    private readonly sensorAuthService?: ISensorAuthorizationService,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    // CORS allowlist validity is enforced at module load by
    // `buildWsCorsConfig('SensorReadingsGateway')`, which throws in
    // production if WS_CORS_ORIGINS is missing. If the process is
    // running, CORS is valid — no per-instance check needed.
  }

  afterInit(): void {
    this.logger.log('Sensor Readings WebSocket Gateway initialized on /sensors');
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
      let authorizedSensorIds = new Set<string>();

      if (payload.sensorIds && Array.isArray(payload.sensorIds)) {
        authorizedSensorIds = new Set(payload.sensorIds);
      } else if (this.sensorAuthService) {
        try {
          const sensors = await this.sensorAuthService.getSensorsByTenant(tenantId);
          authorizedSensorIds = new Set(sensors);
        } catch (err) {
          this.logger.warn(
            `Failed to fetch authorized sensors for tenant ${tenantId}: ${(err as Error).message}`,
          );
        }
      }

      // SEC-MEDIUM-073 (№26): per-tenant ceiling.
      if (!this.connectionLimiter.register(tenantId, client.id)) {
        this.logger.warn(`Tenant ${tenantId} exceeded its WS connection ceiling`);
        client.emit('error', { message: 'Too many connections for this tenant' });
        client.disconnect();
        return;
      }

      // SEC-MEDIUM-082 (№18): periodic revocation re-check.
      this.tokenRevalidator.register(client.id, {
        tenantId,
        userId: typeof payload.sub === 'string' ? payload.sub : 'unknown',
        jti: typeof payload.jti === 'string' ? payload.jti : '',
        issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
        disconnect: (reason) => {
          this.logger.warn(`Sensor socket ${client.id} disconnected: ${reason}`);
          client.disconnect(true);
        },
      });

      this.clients.set(client.id, {
        socket: client,
        tenantId,
        sensorIds: new Set(),
        authorizedSensorIds,
      });
      void client.join(`tenant:${tenantId}`);
      this.logger.log(`Client ${client.id} connected for tenant ${tenantId}`);
      client.emit('connected', { message: 'Connected to sensor readings stream', tenantId });
    } catch (error) {
      this.logger.error(`Connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    const entry = this.clients.get(client.id);
    this.tokenRevalidator.unregister(client.id);
    if (entry) {
      this.connectionLimiter.release(entry.tenantId, client.id);
    }
    this.clients.delete(client.id);
    this.logger.log(`Client ${client.id} disconnected`);
  }

  /** Client subscribes to specific sensors. Validates tenant ownership. */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    client: Socket,
    payload: { sensorIds: string[] },
  ): Promise<{ success: boolean; subscribedTo: string[]; denied?: string[]; reason?: string }> {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, subscribedTo: [], reason: 'Client not authenticated' };
    }
    if (!Array.isArray(payload.sensorIds) || payload.sensorIds.length === 0) {
      return {
        success: false,
        subscribedTo: Array.from(clientData.sensorIds),
        reason: 'Invalid sensorIds',
      };
    }

    const MAX_SUBSCRIPTIONS = 100;
    if (payload.sensorIds.length > MAX_SUBSCRIPTIONS) {
      return {
        success: false,
        subscribedTo: Array.from(clientData.sensorIds),
        reason: `Maximum ${MAX_SUBSCRIPTIONS} sensor subscriptions allowed per request`,
      };
    }

    const validSensorIds = payload.sensorIds.filter(
      (id) => typeof id === 'string' && UUID_REGEX.test(id),
    );
    if (validSensorIds.length !== payload.sensorIds.length) {
      this.logger.warn(`Client ${client.id} sent invalid sensor IDs`);
    }

    const authorizedIds: string[] = [];
    const deniedIds: string[] = [];
    const isProduction = this.configService?.get<string>('NODE_ENV') === 'production';

    for (const sensorId of validSensorIds) {
      if (clientData.authorizedSensorIds.has(sensorId)) {
        authorizedIds.push(sensorId);
      } else if (this.sensorAuthService) {
        try {
          const isAuthorized = await this.sensorAuthService.isSensorOwnedByTenant(
            sensorId,
            clientData.tenantId,
          );
          if (isAuthorized) {
            clientData.authorizedSensorIds.add(sensorId);
            authorizedIds.push(sensorId);
          } else {
            deniedIds.push(sensorId);
          }
        } catch {
          deniedIds.push(sensorId);
        }
      } else if (isProduction) {
        deniedIds.push(sensorId);
      } else {
        authorizedIds.push(sensorId);
      }
    }

    if (deniedIds.length > 0) {
      this.logger.warn(
        `SECURITY: Client ${client.id} (tenant: ${clientData.tenantId}) denied access to sensors: ${deniedIds.join(', ')}`,
      );
    }

    for (const sensorId of authorizedIds) {
      clientData.sensorIds.add(sensorId);
      void client.join(`sensor:${sensorId}`);
    }

    this.logger.debug(`Client ${client.id} subscribed to sensors: ${authorizedIds.join(', ')}`);

    return {
      success: authorizedIds.length > 0,
      subscribedTo: Array.from(clientData.sensorIds),
      denied: deniedIds.length > 0 ? deniedIds : undefined,
      reason: deniedIds.length > 0 ? 'Access denied to some sensors' : undefined,
    };
  }

  /** Client unsubscribes from sensors. */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(client: Socket, payload: { sensorIds: string[] }): { success: boolean } {
    const clientData = this.clients.get(client.id);
    if (!clientData) return { success: false };

    for (const sensorId of payload.sensorIds) {
      clientData.sensorIds.delete(sensorId);
      void client.leave(`sensor:${sensorId}`);
    }
    return { success: true };
  }

  /**
   * SEC-M18: Subscribe to edge device I/O data stream.
   * Validates device code format, verifies ownership, then joins tenant-scoped room.
   */
  @SubscribeMessage('subscribeEdgeIo')
  async handleSubscribeEdgeIo(
    client: Socket,
    payload: { deviceCode: string },
  ): Promise<{ success: boolean; reason?: string }> {
    const clientData = this.clients.get(client.id);
    if (!clientData || !payload?.deviceCode) {
      return { success: false, reason: 'Not authenticated or missing deviceCode' };
    }

    if (!DEVICE_CODE_REGEX.test(payload.deviceCode)) {
      this.logger.warn(
        `SEC-M18: Client ${client.id} sent invalid device code: ${payload.deviceCode.substring(0, 50)}`,
      );
      return { success: false, reason: 'Invalid device code format' };
    }

    const owned = await this.deviceOwnershipService.verifyOwnership(
      payload.deviceCode,
      clientData.tenantId,
    );
    if (!owned) {
      this.logger.warn(
        `SEC-M18: Client ${client.id} denied edge I/O — device ${payload.deviceCode} not owned by tenant ${clientData.tenantId}`,
      );
      return { success: false, reason: 'Device not found or access denied' };
    }

    const room = `edgeIo:${clientData.tenantId}:${payload.deviceCode}`;
    void client.join(room);
    this.logger.debug(
      `Client ${client.id} subscribed to edge I/O: ${payload.deviceCode} (tenant: ${clientData.tenantId})`,
    );
    return { success: true };
  }

  /** Client unsubscribes from edge device I/O data stream. */
  @SubscribeMessage('unsubscribeEdgeIo')
  handleUnsubscribeEdgeIo(client: Socket, payload: { deviceCode: string }): { success: boolean } {
    const clientData = this.clients.get(client.id);
    if (!clientData || !payload?.deviceCode) return { success: false };

    const room = `edgeIo:${clientData.tenantId}:${payload.deviceCode}`;
    void client.leave(room);
    this.logger.debug(`Client ${client.id} unsubscribed from edge I/O: ${payload.deviceCode}`);
    return { success: true };
  }

  /** Broadcast edge device I/O data to subscribed clients. */
  broadcastEdgeIoData(event: {
    tenantId: string;
    deviceCode: string;
    tags: Record<string, unknown>;
    timestamp: string;
  }): void {
    this.server.to(`edgeIo:${event.tenantId}:${event.deviceCode}`).emit('edgeIoData', {
      deviceCode: event.deviceCode,
      tags: event.tags,
      timestamp: event.timestamp,
    });
  }

  /** Broadcast edge device alarm events to subscribed clients. */
  broadcastEdgeAlarm(event: {
    tenantId: string;
    deviceCode: string;
    alarms: EdgeDeviceAlarm[];
    timestamp: string;
  }): void {
    this.server.to(`edgeIo:${event.tenantId}:${event.deviceCode}`).emit('edgeAlarm', {
      deviceCode: event.deviceCode,
      alarms: event.alarms,
      timestamp: event.timestamp,
    });
  }

  /** Broadcast sensor reading to subscribed clients (tenant-isolated via rooms). */
  broadcastSensorReading(event: SensorReadingEvent): void {
    if (!event.tenantId || !event.sensorId) {
      this.logger.warn('Received invalid sensor reading event: missing tenantId or sensorId');
      return;
    }
    this.server.to(`sensor:${event.sensorId}`).emit('sensorReading', event);
    this.logger.debug(
      `Broadcasted reading for sensor ${event.sensorId} to tenant ${event.tenantId}`,
    );
  }

  /** Get connected client count. */
  getConnectedClientCount(): number {
    return this.clients.size;
  }

  /** Extract JWT token from the client handshake. Priority: auth > header > query (dev only). */
  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;

    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7);

    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string') {
      const isProduction = this.configService?.get<string>('NODE_ENV') === 'production';
      if (isProduction) {
        this.logger.warn(
          `SECURITY: Client ${client.id} rejected - query parameter tokens not allowed in production.`,
        );
        return null;
      }
      return queryToken;
    }
    return null;
  }

  /**
   * Validate a JWT token via the shared platform verification helpers.
   * See `farm.gateway.ts:validateToken` for the full rationale — this
   * implementation mirrors it so every gateway applies the same
   * security policy.
   *
   * `getJwtVerifyOptions` enforces RS256 + issuer + audience at the
   * jsonwebtoken library level (not a conditional check). The
   * subsequent `enforceAccessTokenType` rejects refresh and
   * MFA-challenge tokens at handshake (H-1).
   */
  private async validateToken(token: string): Promise<TokenPayload | null> {
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
}
