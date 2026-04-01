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

interface SensorReadingEvent {
  sensorId: string;
  sensorName: string;
  tenantId: string;
  readings: Record<string, number>;
  timestamp: string;
}

interface SubscribedClient {
  socket: Socket;
  tenantId: string;
  sensorIds: Set<string>;
  /** Authorized sensor IDs from tenant's sensors list */
  authorizedSensorIds: Set<string>;
}

interface TokenPayload {
  tenantId?: string;
  /** Optional list of sensor IDs the user can access */
  sensorIds?: string[];
  [key: string]: unknown;
}

/**
 * Sensor authorization service interface
 * Validates sensor ownership for a tenant
 */
export interface ISensorAuthorizationService {
  isSensorOwnedByTenant(sensorId: string, tenantId: string): Promise<boolean>;
  getSensorsByTenant(tenantId: string): Promise<string[]>;
}

/**
 * Injection token for sensor authorization service
 */
export const SENSOR_AUTH_SERVICE = 'SENSOR_AUTH_SERVICE';

/**
 * Build CORS config at module load time from environment.
 * This is the ONLY effective place to set CORS for Socket.io --
 * mutating engine.opts in afterInit has no effect after the server starts.
 */
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
    // Development: allow all origins but disable credentials (CSWSH-safe)
    return { origin: true, credentials: false, methods: ['GET', 'POST'] };
  }
  // Production without config: deny all
  return { origin: false, credentials: false };
}

/**
 * WebSocket Gateway for real-time sensor readings
 * Receives events from NATS and pushes to connected clients
 *
 * SECURITY:
 * - CORS is configured from environment to prevent CSWSH attacks
 * - Credentials are disabled when using wildcard origin
 * - JWT validation is enforced in production
 * - Sensor subscriptions are authorized against tenant ownership
 */
@WebSocketGateway({
  cors: buildWsCorsConfig(),
  namespace: '/sensors',
  transports: ['websocket', 'polling'],
})
export class SensorReadingsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(SensorReadingsGateway.name);
  private clients = new Map<string, SubscribedClient>();
  private readonly isProduction: boolean;
  private readonly allowedOrigins: string[];

  /**
   * SEC-M18: In-memory cache for device ownership verification results.
   * Key format: `${tenantId}:${deviceCode}` -> { owned, expiresAt }.
   * TTL prevents stale positive results from lingering when a device
   * is moved or decommissioned, while avoiding repeated DB round-trips
   * for legitimate high-frequency subscription attempts.
   */
  private readonly deviceOwnershipCache = new Map<string, { owned: boolean; expiresAt: number }>();

  /** SEC-M18: Cache TTL for device ownership results (5 minutes) */
  private static readonly DEVICE_OWNERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;

  /** SEC-M18: Timeout for NATS device ownership verification requests */
  private static readonly DEVICE_OWNERSHIP_VERIFY_TIMEOUT_MS = 5_000;

  constructor(
    private readonly jwtService: JwtService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    @Inject(SENSOR_AUTH_SERVICE)
    private readonly sensorAuthService?: ISensorAuthorizationService,
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    this.isProduction = process.env['NODE_ENV'] === 'production';

    // Parse allowed origins from config
    const originsConfig = this.configService?.get<string>('WS_CORS_ORIGINS', '');
    this.allowedOrigins = originsConfig
      ? originsConfig.split(',').map((o) => o.trim()).filter(Boolean)
      : [];

    // SECURITY: In production, require explicit origins
    if (this.isProduction && this.allowedOrigins.length === 0) {
      this.logger.error(
        'SECURITY: WS_CORS_ORIGINS must be configured in production. ' +
        'WebSocket connections will be rejected until configured.',
      );
    }
  }

  afterInit(): void {
    // CORS is configured via the @WebSocketGateway decorator using buildWsCorsConfig().
    // Mutating engine.opts after initialization has no effect on Socket.io.
    if (this.allowedOrigins.length > 0) {
      this.logger.log(
        `WebSocket CORS configured with origins: ${this.allowedOrigins.join(', ')}`,
      );
    } else if (!this.isProduction) {
      this.logger.warn(
        'WebSocket CORS: Development mode - allowing all origins without credentials',
      );
    } else {
      this.logger.error('WebSocket CORS: Blocking all connections - configure WS_CORS_ORIGINS');
    }

    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      // Extract and validate JWT token
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token`);
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }

      const payload = this.validateToken(token);
      if (!payload?.tenantId) {
        this.logger.warn(`Client ${client.id} has invalid token`);
        client.emit('error', { message: 'Invalid token' });
        client.disconnect();
        return;
      }

      const tenantId = payload.tenantId;

      // Get authorized sensors for this tenant
      let authorizedSensorIds = new Set<string>();
      if (payload.sensorIds && Array.isArray(payload.sensorIds)) {
        // Use sensors from JWT claim if available
        authorizedSensorIds = new Set(payload.sensorIds);
      } else if (this.sensorAuthService) {
        // Fetch from authorization service
        try {
          const sensors = await this.sensorAuthService.getSensorsByTenant(tenantId);
          authorizedSensorIds = new Set(sensors);
        } catch (err) {
          this.logger.warn(`Failed to fetch authorized sensors for tenant ${tenantId}: ${(err as Error).message}`);
        }
      }

      // Store client with tenant context and authorization
      this.clients.set(client.id, {
        socket: client,
        tenantId,
        sensorIds: new Set(),
        authorizedSensorIds,
      });

      // Join tenant-specific room
      void client.join(`tenant:${tenantId}`);

      this.logger.log(
        `Client ${client.id} connected for tenant ${tenantId}`,
      );

      client.emit('connected', {
        message: 'Connected to sensor readings stream',
        tenantId,
      });
    } catch (error) {
      this.logger.error(`Connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.clients.delete(client.id);
    this.logger.log(`Client ${client.id} disconnected`);
  }

  /**
   * Client subscribes to specific sensors
   * SECURITY: Validates that sensors belong to the client's tenant
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    client: Socket,
    payload: { sensorIds: string[] },
  ): Promise<{ success: boolean; subscribedTo: string[]; denied?: string[]; reason?: string }> {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, subscribedTo: [], reason: 'Client not authenticated' };
    }

    // Validate input
    if (!Array.isArray(payload.sensorIds) || payload.sensorIds.length === 0) {
      return { success: false, subscribedTo: Array.from(clientData.sensorIds), reason: 'Invalid sensorIds' };
    }

    // Limit subscription size to prevent resource exhaustion
    const MAX_SENSOR_SUBSCRIPTIONS = 100;
    if (payload.sensorIds.length > MAX_SENSOR_SUBSCRIPTIONS) {
      return { success: false, subscribedTo: Array.from(clientData.sensorIds), reason: `Maximum ${MAX_SENSOR_SUBSCRIPTIONS} sensor subscriptions allowed per request` };
    }

    // SECURITY: Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const validSensorIds = payload.sensorIds.filter((id) => typeof id === 'string' && uuidRegex.test(id));

    if (validSensorIds.length !== payload.sensorIds.length) {
      this.logger.warn(`Client ${client.id} sent invalid sensor IDs`);
    }

    // SECURITY: Authorize sensor access
    const authorizedIds: string[] = [];
    const deniedIds: string[] = [];

    for (const sensorId of validSensorIds) {
      // Check if sensor is in the authorized list
      if (clientData.authorizedSensorIds.has(sensorId)) {
        authorizedIds.push(sensorId);
      } else if (this.sensorAuthService) {
        // Dynamic check for sensors not in cache
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
      } else {
        // No authorization service - deny by default in production
        if (this.isProduction) {
          deniedIds.push(sensorId);
        } else {
          // Development: allow for backwards compatibility
          authorizedIds.push(sensorId);
        }
      }
    }

    // Log unauthorized access attempts
    if (deniedIds.length > 0) {
      this.logger.warn(
        `SECURITY: Client ${client.id} (tenant: ${clientData.tenantId}) denied access to sensors: ${deniedIds.join(', ')}`,
      );
    }

    // Add authorized sensor IDs to subscription
    for (const sensorId of authorizedIds) {
      clientData.sensorIds.add(sensorId);
      void client.join(`sensor:${sensorId}`);
    }

    this.logger.debug(
      `Client ${client.id} subscribed to sensors: ${authorizedIds.join(', ')}`,
    );

    return {
      success: authorizedIds.length > 0,
      subscribedTo: Array.from(clientData.sensorIds),
      denied: deniedIds.length > 0 ? deniedIds : undefined,
      reason: deniedIds.length > 0 ? 'Access denied to some sensors' : undefined,
    };
  }

  /**
   * Client unsubscribes from sensors
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    client: Socket,
    payload: { sensorIds: string[] },
  ): { success: boolean } {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false };
    }

    for (const sensorId of payload.sensorIds) {
      clientData.sensorIds.delete(sensorId);
      void client.leave(`sensor:${sensorId}`);
    }

    return { success: true };
  }

  /**
   * SEC-M18: Client subscribes to edge device I/O data stream.
   *
   * Validates device code format, verifies device ownership via a NATS
   * request-reply to sensor-service, and only then subscribes the client
   * to the tenant-scoped room. Without the ownership check, any authenticated
   * user could subscribe to data from a device in their own tenant's namespace
   * by guessing device codes, even if that device does not belong to their tenant.
   *
   * The room name `edgeIo:{tenantId}:{deviceCode}` already prevents cross-tenant
   * data leakage at the broadcast level. The ownership verification adds defense-in-depth
   * by ensuring the device actually exists under the requesting tenant.
   *
   * Ownership results are cached for 5 minutes to reduce NATS/DB round-trips
   * on repeated subscription attempts for the same device.
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

    // SEC-M18: Validate device code format -- only alphanumeric, hyphens, and underscores allowed.
    // Prevents injection of special characters (e.g., colons, slashes) into the room name.
    const DEVICE_CODE_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
    if (!DEVICE_CODE_REGEX.test(payload.deviceCode)) {
      this.logger.warn(
        `SEC-M18: Client ${client.id} sent invalid device code format: ${payload.deviceCode.substring(0, 50)}`,
      );
      return { success: false, reason: 'Invalid device code format' };
    }

    // SEC-M18: Verify device ownership via NATS request to sensor-service.
    // The device must exist in the database with a matching tenantId.
    const owned = await this.verifyDeviceOwnership(
      payload.deviceCode,
      clientData.tenantId,
    );

    if (!owned) {
      this.logger.warn(
        `SEC-M18: Client ${client.id} denied edge I/O subscription — device ${payload.deviceCode} not owned by tenant ${clientData.tenantId}`,
      );
      return { success: false, reason: 'Device not found or access denied' };
    }

    // SEC-M18: The room is always scoped to the client's tenantId from JWT.
    // This ensures tenant isolation -- a client cannot subscribe to another tenant's
    // device stream because the tenantId is derived from the authenticated JWT, not
    // from the payload. Combined with ownership verification above, both layers
    // guarantee that only legitimate device owners receive data.
    const room = `edgeIo:${clientData.tenantId}:${payload.deviceCode}`;
    void client.join(room);
    this.logger.debug(
      `Client ${client.id} subscribed to edge I/O: ${payload.deviceCode} (tenant: ${clientData.tenantId})`,
    );
    return { success: true };
  }

  /**
   * Client unsubscribes from edge device I/O data stream
   */
  @SubscribeMessage('unsubscribeEdgeIo')
  handleUnsubscribeEdgeIo(
    client: Socket,
    payload: { deviceCode: string },
  ): { success: boolean } {
    const clientData = this.clients.get(client.id);
    if (!clientData || !payload?.deviceCode) {
      return { success: false };
    }

    const room = `edgeIo:${clientData.tenantId}:${payload.deviceCode}`;
    void client.leave(room);
    this.logger.debug(
      `Client ${client.id} unsubscribed from edge I/O: ${payload.deviceCode}`,
    );
    return { success: true };
  }

  /**
   * Broadcast edge device I/O data to subscribed clients
   * Called by NATS bridge for EdgeDeviceIoData events
   */
  broadcastEdgeIoData(event: {
    tenantId: string;
    deviceCode: string;
    tags: Record<string, unknown>;
    timestamp: string;
  }): void {
    const room = `edgeIo:${event.tenantId}:${event.deviceCode}`;
    this.server.to(room).emit('edgeIoData', {
      deviceCode: event.deviceCode,
      tags: event.tags,
      timestamp: event.timestamp,
    });
  }

  /**
   * Broadcast edge device alarm events to subscribed clients
   * Called by NATS bridge for EdgeDeviceAlarm events
   */
  broadcastEdgeAlarm(event: {
    tenantId: string;
    deviceCode: string;
    alarms: unknown[];
    timestamp: string;
  }): void {
    const room = `edgeIo:${event.tenantId}:${event.deviceCode}`;
    this.server.to(room).emit('edgeAlarm', {
      deviceCode: event.deviceCode,
      alarms: event.alarms,
      timestamp: event.timestamp,
    });
  }

  /**
   * Broadcast sensor reading to subscribed clients
   * Called by NATS event handler
   *
   * SECURITY: Only broadcasts to clients in the same tenant
   * to ensure cross-tenant data isolation
   */
  broadcastSensorReading(event: SensorReadingEvent): void {
    // SECURITY: Validate event has required fields
    if (!event.tenantId || !event.sensorId) {
      this.logger.warn('Received invalid sensor reading event: missing tenantId or sensorId');
      return;
    }

    // Use Socket.IO room targeting for O(1) routing instead of manual O(n_clients) loop.
    // handleSubscribe() already calls client.join(`sensor:${sensorId}`) for each
    // subscription, so the `sensor:<id>` room contains exactly the subscribed clients.
    // Tenant isolation is enforced at subscription time in handleSubscribe(),
    // which verifies sensor ownership before joining the room.
    const sensorRoom = `sensor:${event.sensorId}`;
    this.server.to(sensorRoom).emit('sensorReading', event);

    this.logger.debug(
      `Broadcasted reading for sensor ${event.sensorId} to tenant ${event.tenantId}`,
    );
  }

  /**
   * Get connected client count
   */
  getConnectedClientCount(): number {
    return this.clients.size;
  }

  private extractToken(client: Socket): string | null {
    // SECURITY PRIORITY ORDER:
    // 1. socket.io auth object (most secure - encrypted in WebSocket handshake)
    // 2. Authorization header (standard approach)
    // 3. Query parameter (least secure - logged in URLs, visible in referrers)

    // Try auth object first (recommended)
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') {
      return auth.token;
    }

    // Try Authorization header
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // SECURITY: Reject query-parameter tokens in production.
    // JWT tokens in WebSocket upgrade URLs appear in nginx access logs,
    // browser history, and referrer headers.
    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string') {
      if (this.isProduction) {
        this.logger.warn(
          `SECURITY: Client ${client.id} rejected - query parameter tokens are ` +
          `not allowed in production. Use socket.io auth object or Authorization header.`,
        );
        return null;
      }
      return queryToken;
    }

    return null;
  }

  private validateToken(token: string): TokenPayload | null {
    try {
      // SECURITY: Always use JwtService.verify() with explicit algorithm restriction
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
   * SEC-M18: Verify that an edge device belongs to a specific tenant.
   *
   * Sends a NATS request-reply to sensor-service, which performs the
   * database lookup. Results are cached for DEVICE_OWNERSHIP_CACHE_TTL_MS
   * to avoid repeated round-trips for the same device/tenant pair.
   *
   * Safe defaults:
   * - If NATS client is not available: deny (production), allow (development)
   * - If sensor-service is unreachable or times out: deny
   * - If cache entry exists and has not expired: use cached result
   *
   * @param deviceCode - The edge device code to verify
   * @param tenantId - The tenant ID from the authenticated JWT
   * @returns true if the device belongs to the tenant, false otherwise
   */
  private async verifyDeviceOwnership(
    deviceCode: string,
    tenantId: string,
  ): Promise<boolean> {
    // Check cache first
    const cacheKey = `${tenantId}:${deviceCode}`;
    const cached = this.deviceOwnershipCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.owned;
    }

    // Evict expired entry
    if (cached) {
      this.deviceOwnershipCache.delete(cacheKey);
    }

    if (!this.natsClient) {
      this.logger.warn(
        'SEC-M18: NATS client not available for device ownership verification',
      );
      // Safe default: deny in production, allow in development for backwards compatibility
      return !this.isProduction;
    }

    try {
      const result = await firstValueFrom(
        this.natsClient
          .send<{ owned: boolean }>('request.sensor.verifyDeviceOwnership', {
            deviceCode,
            tenantId,
          })
          .pipe(timeout(SensorReadingsGateway.DEVICE_OWNERSHIP_VERIFY_TIMEOUT_MS)),
      );

      const owned = !!result?.owned;

      // Cache the result (both positive and negative)
      this.deviceOwnershipCache.set(cacheKey, {
        owned,
        expiresAt: Date.now() + SensorReadingsGateway.DEVICE_OWNERSHIP_CACHE_TTL_MS,
      });

      return owned;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `SEC-M18: Device ownership verification failed (denying access): ${message}`,
      );
      // Safe default: deny access when sensor-service is unreachable
      return false;
    }
  }
}
