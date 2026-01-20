import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Logger, Inject, Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

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

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    try {
      // Extract and validate JWT token
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token`);
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }

      const payload = await this.validateToken(token);
      if (!payload || !payload.tenantId) {
        this.logger.warn(`Client ${client.id} has invalid token`);
        client.emit('error', { message: 'Invalid token' });
        client.disconnect();
        return;
      }

      // Store client with tenant context
      this.clients.set(client.id, {
        socket: client,
        tenantId: payload.tenantId,
        sensorIds: new Set(),
      });

      // Join tenant-specific room
      client.join(`tenant:${payload.tenantId}`);

      this.logger.log(
        `Client ${client.id} connected for tenant ${payload.tenantId}`,
      );

      client.emit('connected', {
        message: 'Connected to sensor readings stream',
        tenantId: payload.tenantId,
      });
    } catch (error) {
      this.logger.error(`Connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
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
      client.join(`sensor:${sensorId}`);
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
      client.leave(`sensor:${sensorId}`);
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
    if (client.handshake.auth && client.handshake.auth.token) {
      return client.handshake.auth.token;
    }

    return null;
  }

  private async validateToken(token: string): Promise<any> {
    if (!this.jwtService) {
      // If no JWT service, decode without verification (dev mode)
      try {
        const parts = token.split('.');
        if (parts.length !== 3 || !parts[1]) return null;
        return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      } catch {
        return null;
      }
    }

    try {
      return this.jwtService.verify(token);
    } catch {
      return null;
    }
  }
}
