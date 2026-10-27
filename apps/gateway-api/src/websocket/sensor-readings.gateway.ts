/**
 * WebSocket Gateway for real-time sensor readings and edge device I/O.
 *
 * Receives events from NATS (via NatsBridgeService) and pushes them to
 * connected Socket.IO clients (SEC-CRITICAL-207; ADR-051 §3 step 1):
 *
 *   - The handshake requires a sensor grant: `decideAccess` module('sensor')
 *     through the token's `moduleAccess`. Roles without one are refused.
 *   - Every room is built by the backend-common room vocabulary under the
 *     tenant: `t:{tenant}:m:sensor[:site:{site}]:sensor:{id}` for readings,
 *     `t:{tenant}:m:sensor:edge-io:{code}` for a device.
 *   - A member tenant-wide in sensor joins the room of each sensor it asks
 *     for; a site-bound sensor operator joins the site-qualified room of each
 *     of its sites. A reading reaches the sensor room and the room of the site
 *     the reading names (SensorReading.siteId), so the operator receives only
 *     readings of its sites and never one of no site, without a lookup.
 *   - Edge I/O events name no site, so a device's site comes from
 *     DeviceOwnershipService (request.sensor.verifyDeviceOwnership) before a
 *     site-bound operator may join its room.
 *   - A revoked token drops the socket within one WsTokenRevalidator cycle.
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
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';
import { DEVICE_CODE_REGEX, UUID_REGEX } from '@aquaculture/backend-common/constants';
import {
  TenantConnectionLimiter,
  WsTokenRevalidator,
  buildWsCorsConfig,
  emitToModuleRooms,
  eventModuleRooms,
  joinModuleRooms,
  leaveModuleRooms,
  memberModuleRooms,
  moduleRoom,
  moduleSocketScope,
  scopeAdmitsSite,
  socketMemberOf,
  type ModuleResource,
  type ModuleSocketScope,
  type SocketMember,
} from '@aquaculture/backend-common/websocket';

import { DeviceOwnershipService } from './services/device-ownership.service';

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
  member: SocketMember;
  /** The member's sensor scope, decided once at the handshake. */
  scope: ModuleSocketScope;
  sensorIds: Set<string>;
}

/** Structured representation of an edge device alarm event (ONEMLI-03). */
export interface EdgeDeviceAlarm {
  alarmId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  timestamp: string;
  acknowledged?: boolean;
}

const MAX_SUBSCRIPTIONS = 100;

function sensorResource(sensorId: string): ModuleResource {
  return { kind: 'sensor', id: sensorId };
}

function edgeIoResource(deviceCode: string): ModuleResource {
  return { kind: 'edge-io', id: deviceCode };
}

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

      // SEC-CRITICAL-207: sensor data needs a sensor grant (and, for a
      // MODULE_USER, an assigned site); decided once, here.
      const scope = moduleSocketScope(member, 'sensor');
      if (scope === null) {
        this.refuse(client, 'Forbidden', 'holds no sensor grant');
        return;
      }

      const { tenantId } = member;
      // SEC-MEDIUM-073 (№26): per-tenant ceiling.
      if (!this.connectionLimiter.register(tenantId, client.id)) {
        this.refuse(client, 'Too many connections for this tenant', 'exceeded the tenant ceiling');
        return;
      }

      // SEC-MEDIUM-082 (№18): periodic revocation re-check.
      this.tokenRevalidator.register(client.id, {
        tenantId,
        userId: member.caller.userId,
        jti: typeof claims['jti'] === 'string' ? claims['jti'] : '',
        issuedAt: typeof claims['iat'] === 'number' ? claims['iat'] : undefined,
        disconnect: (reason) => {
          this.logger.warn(`Sensor socket ${client.id} disconnected: ${reason}`);
          client.disconnect(true);
        },
      });

      this.clients.set(client.id, { socket: client, member, scope, sensorIds: new Set() });
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
      this.connectionLimiter.release(entry.member.tenantId, client.id);
    }
    this.clients.delete(client.id);
    this.logger.log(`Client ${client.id} disconnected`);
  }

  /**
   * Client subscribes to specific sensors. Each sensor's room is qualified by
   * the tenant and, for a site-bound operator, by each of its sites, so a
   * subscription to a sensor of another tenant or another site receives
   * nothing.
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    client: Socket,
    payload: { sensorIds: string[] },
  ): Promise<{ success: boolean; subscribedTo: string[]; reason?: string }> {
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

    for (const sensorId of validSensorIds) {
      await joinModuleRooms(
        client,
        memberModuleRooms(clientData.member, 'sensor', sensorResource(sensorId)),
      );
      clientData.sensorIds.add(sensorId);
    }

    this.logger.debug(`Client ${client.id} subscribed to sensors: ${validSensorIds.join(', ')}`);
    return { success: validSensorIds.length > 0, subscribedTo: Array.from(clientData.sensorIds) };
  }

  /** Client unsubscribes from sensors. */
  @SubscribeMessage('unsubscribe')
  async handleUnsubscribe(
    client: Socket,
    payload: { sensorIds: string[] },
  ): Promise<{ success: boolean }> {
    const clientData = this.clients.get(client.id);
    if (!clientData || !Array.isArray(payload.sensorIds)) return { success: false };

    for (const sensorId of payload.sensorIds) {
      if (!clientData.sensorIds.delete(sensorId)) continue;
      await leaveModuleRooms(
        client,
        memberModuleRooms(clientData.member, 'sensor', sensorResource(sensorId)),
      );
    }
    return { success: true };
  }

  /**
   * SEC-M18: Subscribe to edge device I/O data stream. Validates the device
   * code, asks sensor-service where the tenant's device stands, and admits a
   * site-bound operator only to a device on one of its sites.
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

    const { tenantId } = clientData.member;
    const placement = await this.deviceOwnershipService.devicePlacement(
      payload.deviceCode,
      tenantId,
    );
    if (placement === null || !scopeAdmitsSite(clientData.scope, placement.siteId)) {
      this.logger.warn(
        `SEC-M18: Client ${client.id} denied edge I/O — device ${payload.deviceCode} is not in its scope (tenant ${tenantId})`,
      );
      return { success: false, reason: 'Device not found or access denied' };
    }

    await joinModuleRooms(client, [
      moduleRoom(tenantId, 'sensor', { resource: edgeIoResource(payload.deviceCode) }),
    ]);
    this.logger.debug(
      `Client ${client.id} subscribed to edge I/O: ${payload.deviceCode} (tenant: ${tenantId})`,
    );
    return { success: true };
  }

  /** Client unsubscribes from edge device I/O data stream. */
  @SubscribeMessage('unsubscribeEdgeIo')
  async handleUnsubscribeEdgeIo(
    client: Socket,
    payload: { deviceCode: string },
  ): Promise<{ success: boolean }> {
    const clientData = this.clients.get(client.id);
    if (!clientData || !payload?.deviceCode || !DEVICE_CODE_REGEX.test(payload.deviceCode)) {
      return { success: false };
    }

    await leaveModuleRooms(client, [
      moduleRoom(clientData.member.tenantId, 'sensor', {
        resource: edgeIoResource(payload.deviceCode),
      }),
    ]);
    this.logger.debug(`Client ${client.id} unsubscribed from edge I/O: ${payload.deviceCode}`);
    return { success: true };
  }

  /** Broadcast edge device I/O data to the device's room. */
  broadcastEdgeIoData(event: {
    tenantId: string;
    deviceCode: string;
    tags: Record<string, unknown>;
    timestamp: string;
  }): void {
    emitToModuleRooms(
      this.server,
      eventModuleRooms(event.tenantId, 'sensor', null, edgeIoResource(event.deviceCode)),
      'edgeIoData',
      { deviceCode: event.deviceCode, tags: event.tags, timestamp: event.timestamp },
    );
  }

  /** Broadcast edge device alarm events to the device's room. */
  broadcastEdgeAlarm(event: {
    tenantId: string;
    deviceCode: string;
    alarms: EdgeDeviceAlarm[];
    timestamp: string;
  }): void {
    emitToModuleRooms(
      this.server,
      eventModuleRooms(event.tenantId, 'sensor', null, edgeIoResource(event.deviceCode)),
      'edgeAlarm',
      { deviceCode: event.deviceCode, alarms: event.alarms, timestamp: event.timestamp },
    );
  }

  /**
   * Broadcast a sensor reading to the sensor's room and, when the reading
   * names the sensor's site, to that site's room of the sensor.
   */
  broadcastSensorReading(event: SensorReadingEvent, siteId: string | null): void {
    if (!event.tenantId || !event.sensorId) {
      this.logger.warn('Received invalid sensor reading event: missing tenantId or sensorId');
      return;
    }
    emitToModuleRooms(
      this.server,
      eventModuleRooms(event.tenantId, 'sensor', siteId, sensorResource(event.sensorId)),
      'sensorReading',
      event,
    );
    this.logger.debug(
      `Broadcasted reading for sensor ${event.sensorId} to tenant ${event.tenantId}`,
    );
  }

  /** Get connected client count. */
  getConnectedClientCount(): number {
    return this.clients.size;
  }

  /** Tell the client why, then drop it. */
  private refuse(client: Socket, message: string, reason: string): void {
    this.logger.warn(`Sensor client ${client.id} refused: ${reason}`);
    client.emit('error', { message });
    client.disconnect();
  }

  /** Extract JWT token from the client handshake. Priority: auth > header > query (dev only). */
  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;

    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7);

    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string') {
      if (this.isProduction) {
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
      this.logger.debug(`Token validation failed: ${(error as Error).message}`);
      return null;
    }
  }
}
