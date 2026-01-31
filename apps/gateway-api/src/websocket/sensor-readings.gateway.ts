import { Logger, Optional, Inject } from '@nestjs/common';
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
  cors: {
    // SECURITY: CORS is configured dynamically in afterInit
    // to prevent CSWSH vulnerability (wildcard + credentials)
    origin: false,
    credentials: false,
  },
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

  constructor(
    @Optional()
    private readonly jwtService: JwtService | null,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    @Inject(SENSOR_AUTH_SERVICE)
    private readonly sensorAuthService?: ISensorAuthorizationService,
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
    // SECURITY: Configure CORS dynamically to prevent CSWSH attacks
    // Never use origin: '*' with credentials: true
    if (this.server) {
      const serverOpts = this.server.engine?.opts || {};

      if (this.allowedOrigins.length > 0) {
        // Use explicit allowlist
        serverOpts.cors = {
          origin: this.allowedOrigins,
          credentials: true,
          methods: ['GET', 'POST'],
        };
        this.logger.log(
          `WebSocket CORS configured with origins: ${this.allowedOrigins.join(', ')}`,
        );
      } else if (!this.isProduction) {
        // Development: allow all origins but disable credentials
        serverOpts.cors = {
          origin: true,
          credentials: false,
          methods: ['GET', 'POST'],
        };
        this.logger.warn(
          'WebSocket CORS: Development mode - allowing all origins without credentials',
        );
      } else {
        // Production without config: deny all
        serverOpts.cors = {
          origin: false,
          credentials: false,
        };
        this.logger.error('WebSocket CORS: Blocking all connections - configure WS_CORS_ORIGINS');
      }
    }

    this.logger.log('WebSocket Gateway initialized');
  }

  handleConnection(client: Socket): void {
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

    // SECURITY: Only broadcast to the tenant room
    // This ensures cross-tenant isolation - clients can only receive
    // data from sensors belonging to their own tenant
    const tenantRoom = `tenant:${event.tenantId}`;

    // Get all clients in the tenant room
    const tenantClients = this.server.sockets.adapter.rooms.get(tenantRoom);
    if (!tenantClients || tenantClients.size === 0) {
      return;
    }

    // Filter to only clients subscribed to this specific sensor
    for (const clientId of tenantClients) {
      const clientData = this.clients.get(clientId);
      if (clientData && clientData.sensorIds.has(event.sensorId)) {
        // SECURITY: Double-check tenant isolation
        if (clientData.tenantId === event.tenantId) {
          const socket = this.server.sockets.sockets.get(clientId);
          socket?.emit('sensorReading', event);
        }
      }
    }

    // Also emit to tenant room for dashboard-wide updates
    this.server
      .to(tenantRoom)
      .emit('tenantSensorUpdate', {
        sensorId: event.sensorId,
        timestamp: event.timestamp,
      });

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
    // Try Authorization header
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Try query parameter
    const token = client.handshake.query.token;
    if (typeof token === 'string') {
      return token;
    }

    // Try auth object
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') {
      return auth.token;
    }

    return null;
  }

  private validateToken(token: string): TokenPayload | null {
    // SECURITY: Always verify JWT in production
    if (!this.jwtService) {
      if (this.isProduction) {
        this.logger.error(
          'SECURITY: JwtService not available in production. ' +
          'All token validation will fail.',
        );
        return null;
      }

      // Development only: decode without verification
      this.logger.warn('JWT verification disabled - development mode only');
      try {
        const parts = token.split('.');
        if (parts.length !== 3 || !parts[1]) return null;
        const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as unknown;
        return decoded as TokenPayload;
      } catch {
        return null;
      }
    }

    try {
      const result: unknown = this.jwtService.verify(token);
      return result as TokenPayload;
    } catch (error) {
      this.logger.debug(`Token validation failed: ${(error as Error).message}`);
      return null;
    }
  }
}
