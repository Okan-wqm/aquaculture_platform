import { Logger, Optional } from '@nestjs/common';
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
}

interface TokenPayload {
  tenantId?: string;
  [key: string]: unknown;
}

/**
 * WebSocket Gateway for real-time sensor readings
 * Receives events from NATS and pushes to connected clients
 */
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
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

  constructor(
    @Optional()
    private readonly jwtService: JwtService | null,
  ) {}

  afterInit(): void {
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

      // Store client with tenant context
      this.clients.set(client.id, {
        socket: client,
        tenantId,
        sensorIds: new Set(),
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
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    client: Socket,
    payload: { sensorIds: string[] },
  ): { success: boolean; subscribedTo: string[] } {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return { success: false, subscribedTo: [] };
    }

    // Add sensor IDs to subscription
    for (const sensorId of payload.sensorIds) {
      clientData.sensorIds.add(sensorId);
      void client.join(`sensor:${sensorId}`);
    }

    this.logger.debug(
      `Client ${client.id} subscribed to sensors: ${payload.sensorIds.join(', ')}`,
    );

    return {
      success: true,
      subscribedTo: Array.from(clientData.sensorIds),
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
   */
  broadcastSensorReading(event: SensorReadingEvent): void {
    // Broadcast to sensor-specific room
    this.server
      .to(`sensor:${event.sensorId}`)
      .emit('sensorReading', event);

    // Also broadcast to tenant room for dashboard-wide updates
    this.server
      .to(`tenant:${event.tenantId}`)
      .emit('sensorReading', event);

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
    if (!this.jwtService) {
      // If no JWT service, decode without verification (dev mode)
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
    } catch {
      return null;
    }
  }
}
