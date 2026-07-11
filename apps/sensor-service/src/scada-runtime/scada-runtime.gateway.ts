/**
 * ScadaRuntimeGateway
 *
 * Socket.IO WebSocket gateway for the SCADA HMI operator runtime.
 * Namespace: /scada
 *
 * Responsibilities:
 *  - JWT authentication on every connection (handshake)
 *  - Tag subscription / unsubscription management (via TagManagerService)
 *  - Tag write forwarding with role-based authorization
 *  - DAQ historical query stub (ready for DAQ service injection)
 *  - Alarm acknowledgement stub (ready for alarm engine injection)
 *  - Server-push helpers: pushTagValues, pushAlarmStatus, broadcastCommand
 *  - Clean disconnection: remove all subscriptions on socket disconnect
 *
 * Security:
 *  - CORS follows the project-wide WS_CORS_ORIGINS env pattern
 *  - JWT extracted from auth object → Authorization header → query param (dev only)
 *  - Write operations require 'operator', 'engineer', 'supervisor', or 'admin' role
 *  - All handlers wrapped in try/catch; errors emitted back to originating socket
 */

import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';

// TODO: Replace with '@aquaculture/scada-types' path alias when monorepo build supports it.
import type { AlarmStatusSummary, HmiRole, TagValueChange } from './scada-types';
import { ScadaSocketEvent } from './scada-types';

import {
  AlarmAckAllDto,
  AlarmAckDto,
  DaqQueryDto,
  SCADA_ERROR_CODES,
  ScadaErrorPayload,
  TagSubscriptionDto,
  TagWriteDto,
} from './dto/scada-socket.dto';
import { TagManagerService } from './services/tag-manager.service';
import { TagResolutionService } from '../process/services/tag-resolution.service';
import { isTagRef } from '@platform/sensor-contracts';

/* ------------------------------------------------------------------ */
/*  CORS helper (mirrors the project-wide pattern)                     */
/* ------------------------------------------------------------------ */

function buildScadaWsCorsConfig(): {
  origin: string[] | boolean;
  credentials: boolean;
  methods?: string[];
} {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const originsConfig = process.env['WS_CORS_ORIGINS'] ?? '';
  const allowedOrigins = originsConfig
    ? originsConfig.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  if (allowedOrigins.length > 0) {
    return { origin: allowedOrigins, credentials: true, methods: ['GET', 'POST'] };
  }
  if (!isProduction) {
    // Development: allow all origins but no credentials (CSWSH-safe)
    return { origin: true, credentials: false, methods: ['GET', 'POST'] };
  }
  // Production without explicit config: deny all
  return { origin: false, credentials: false };
}

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

/** Roles that are permitted to write tag values. */
const WRITE_ALLOWED_ROLES: HmiRole[] = ['operator', 'engineer', 'supervisor', 'admin'];

/** Maximum number of concurrent connections per tenant. */
const MAX_CONNECTIONS_PER_TENANT = 50;

/* ------------------------------------------------------------------ */
/*  Internal types                                                      */
/* ------------------------------------------------------------------ */

interface TokenPayload {
  sub?: string;
  userId?: string;
  tenantId?: string;
  /** HMI role stored in the JWT (maps to HmiRole). */
  role?: HmiRole;
  /** Alternative claim name some issuers use. */
  roles?: HmiRole[];
  [key: string]: unknown;
}

interface ConnectedClient {
  socket: Socket;
  tenantId: string;
  userId: string;
  role: HmiRole;
}

/* ------------------------------------------------------------------ */
/*  Command payload union                                               */
/* ------------------------------------------------------------------ */

export type ScadaCommandPayload =
  | { type: 'SETVIEW'; viewId: string }
  | { type: 'OPENCARD'; screenId: string; x?: number; y?: number }
  | { type: 'TOAST'; message: string; toastType: 'error' | 'warning' | 'success' | 'info' };

/* ------------------------------------------------------------------ */
/*  Gateway                                                             */
/* ------------------------------------------------------------------ */

@WebSocketGateway({
  cors: buildScadaWsCorsConfig(),
  namespace: '/scada',
  // Dedicated engine.io path so nginx can route SCADA traffic straight to this
  // service instead of the gateway's default /socket.io/ (which has no /scada).
  // Must match the client's `path` in web ScadaSocketService.
  path: '/scada-ws/',
  transports: ['websocket', 'polling'],
})
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class ScadaRuntimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ScadaRuntimeGateway.name);

  /** Live client registry: socketId → ConnectedClient */
  private readonly clients = new Map<string, ConnectedClient>();

  private readonly isProduction: boolean;

  constructor(
    private readonly jwtService: JwtService,
    private readonly tagManager: TagManagerService,
    private readonly configService: ConfigService,
    private readonly tagResolution: TagResolutionService,
  ) {
    this.isProduction = process.env['NODE_ENV'] === 'production';
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  afterInit(): void {
    const corsOrigins = this.configService.get<string>('WS_CORS_ORIGINS', '');
    if (corsOrigins) {
      this.logger.log(`SCADA WebSocket Gateway initialised — CORS origins: ${corsOrigins}`);
    } else if (!this.isProduction) {
      this.logger.warn('SCADA WebSocket Gateway initialised — CORS: development mode (all origins)');
    } else {
      this.logger.error(
        'SCADA WebSocket Gateway: WS_CORS_ORIGINS not set in production — connections blocked',
      );
    }
    this.logger.log('ScadaRuntimeGateway initialised on namespace /scada');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      // --- Authentication ---
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`[connect] ${client.id} — no token provided`);
        this.emitError(client, ScadaSocketEvent.AUTH, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Authentication required');
        client.disconnect();
        return;
      }

      const payload = await this.validateToken(token);
      if (!payload?.tenantId) {
        this.logger.warn(`[connect] ${client.id} — invalid or expired token`);
        this.emitError(client, ScadaSocketEvent.AUTH, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Invalid or expired token');
        client.disconnect();
        return;
      }

      const { tenantId } = payload;
      const userId = payload.userId ?? payload.sub ?? 'unknown';
      const role: HmiRole = payload.role ?? (Array.isArray(payload.roles) ? payload.roles[0] : 'viewer') ?? 'viewer';

      // --- Tenant connection cap ---
      if (this.getConnectionCountForTenant(tenantId) >= MAX_CONNECTIONS_PER_TENANT) {
        this.logger.warn(
          `[connect] ${client.id} — tenant ${tenantId} exceeded max connections (${MAX_CONNECTIONS_PER_TENANT})`,
        );
        this.emitError(client, ScadaSocketEvent.AUTH, SCADA_ERROR_CODES.FORBIDDEN, 'Too many connections for this tenant');
        client.disconnect();
        return;
      }

      // --- Register client ---
      this.clients.set(client.id, { socket: client, tenantId, userId, role });

      // Join a tenant-scoped room for broadcast helpers
      void client.join(`tenant:${tenantId}`);

      this.logger.log(
        `[connect] ${client.id} — tenant=${tenantId} userId=${userId} role=${role}`,
      );

      client.emit(ScadaSocketEvent.AUTH, {
        status: 'authenticated',
        userId,
        tenantId,
        role,
      });
    } catch (error) {
      this.logger.error(`[connect] ${client.id} error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    try {
      this.tagManager.removeSocket(client.id);
      this.clients.delete(client.id);
      this.logger.log(`[disconnect] ${client.id}`);
    } catch (error) {
      this.logger.error(`[disconnect] ${client.id} cleanup error: ${(error as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  TAG_SUBSCRIBE                                                     */
  /* ---------------------------------------------------------------- */

  @SubscribeMessage(ScadaSocketEvent.TAG_SUBSCRIBE)
  async handleTagSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TagSubscriptionDto,
  ): Promise<void> {
    try {
      const clientData = this.clients.get(client.id);
      if (!clientData) {
        this.emitError(client, ScadaSocketEvent.TAG_SUBSCRIBE, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Client not authenticated');
        return;
      }

      if (!payload?.tagIds || !Array.isArray(payload.tagIds) || payload.tagIds.length === 0) {
        this.emitError(client, ScadaSocketEvent.TAG_SUBSCRIBE, SCADA_ERROR_CODES.VALIDATION_ERROR, 'tagIds must be a non-empty array');
        return;
      }

      // Sanitise tag IDs — reject empty strings
      const sanitised = payload.tagIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
      if (sanitised.length === 0) {
        this.emitError(client, ScadaSocketEvent.TAG_SUBSCRIBE, SCADA_ERROR_CODES.VALIDATION_ERROR, 'No valid tagIds provided');
        return;
      }

      // Registry gate (Faz 6): canonical `deviceCode/localName` TagRefs MUST
      // resolve against THIS tenant's unified_tags registry — a socket can no
      // longer subscribe to an arbitrary or another tenant's tag by guessing
      // its fqn. Legacy non-TagRef keys (dotted device-local ids) are
      // grandfathered through until the client fully migrates to TagRefs
      // (tracked debt), but every subscription is still tenant-fenced inside
      // TagManager.
      const { accepted, rejected } = await this.partitionSubscribableTags(
        clientData.tenantId,
        sanitised,
      );

      if (rejected.length > 0) {
        this.logger.warn(
          `[subscribe] ${client.id} (tenant ${clientData.tenantId}) — rejected ${rejected.length} unregistered tag ref(s): ${JSON.stringify(rejected)}`,
        );
        this.emitError(
          client,
          ScadaSocketEvent.TAG_SUBSCRIBE,
          SCADA_ERROR_CODES.VALIDATION_ERROR,
          `Rejected ${rejected.length} tag ref(s) not registered for this tenant: ${rejected.join(', ')}`,
        );
      }

      if (accepted.length === 0) return;

      // Register subscriptions (tenant-fenced) and receive cached values
      const initialValues = this.tagManager.subscribeSocket(
        client.id,
        clientData.tenantId,
        accepted,
      );

      this.logger.debug(
        `[subscribe] ${client.id} — ${accepted.length} tag(s) subscribed; ` +
          `${initialValues.length} cached value(s) returned`,
      );

      // Immediately push any cached values to the client
      if (initialValues.length > 0) {
        client.emit(ScadaSocketEvent.TAG_VALUES, { values: initialValues });
      }
    } catch (error) {
      this.logger.error(`[subscribe] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.TAG_SUBSCRIBE, SCADA_ERROR_CODES.INTERNAL_ERROR, 'Subscription failed');
    }
  }

  /**
   * Split a subscribe request into tags the tenant may subscribe to and
   * canonical TagRefs that don't resolve (rejected). A key that is NOT a
   * TagRef by grammar is treated as a legacy device-local id and passed
   * through (grandfathered); a grammar-valid TagRef must exist and be
   * non-retired in this tenant's registry.
   */
  private async partitionSubscribableTags(
    tenantId: string,
    keys: string[],
  ): Promise<{ accepted: string[]; rejected: string[] }> {
    const tagRefCandidates = keys.filter((k) => isTagRef(k));
    const legacyKeys = keys.filter((k) => !isTagRef(k));

    if (tagRefCandidates.length === 0) {
      return { accepted: legacyKeys, rejected: [] };
    }

    const { resolved } = await this.tagResolution.resolve(tenantId, tagRefCandidates);
    const resolvedRefs = new Set(resolved.map((r) => r.ref as string));
    const accepted = [...legacyKeys];
    const rejected: string[] = [];
    for (const ref of tagRefCandidates) {
      if (resolvedRefs.has(ref)) accepted.push(ref);
      else rejected.push(ref);
    }
    return { accepted, rejected };
  }

  /* ---------------------------------------------------------------- */
  /*  TAG_UNSUBSCRIBE                                                   */
  /* ---------------------------------------------------------------- */

  @SubscribeMessage(ScadaSocketEvent.TAG_UNSUBSCRIBE)
  handleTagUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TagSubscriptionDto,
  ): void {
    try {
      const clientData = this.clients.get(client.id);
      if (!clientData) {
        this.emitError(client, ScadaSocketEvent.TAG_UNSUBSCRIBE, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Client not authenticated');
        return;
      }

      if (!payload?.tagIds || !Array.isArray(payload.tagIds) || payload.tagIds.length === 0) {
        this.emitError(client, ScadaSocketEvent.TAG_UNSUBSCRIBE, SCADA_ERROR_CODES.VALIDATION_ERROR, 'tagIds must be a non-empty array');
        return;
      }

      const sanitised = payload.tagIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

      this.tagManager.unsubscribeSocket(client.id, sanitised);

      this.logger.debug(`[unsubscribe] ${client.id} — ${sanitised.length} tag(s) removed`);
    } catch (error) {
      this.logger.error(`[unsubscribe] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.TAG_UNSUBSCRIBE, SCADA_ERROR_CODES.INTERNAL_ERROR, 'Unsubscription failed');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  TAG_WRITE                                                         */
  /* ---------------------------------------------------------------- */

  @SubscribeMessage(ScadaSocketEvent.TAG_WRITE)
  handleTagWrite(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TagWriteDto,
  ): void {
    try {
      const clientData = this.clients.get(client.id);
      if (!clientData) {
        this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Client not authenticated');
        return;
      }

      // Role-based authorisation
      if (!WRITE_ALLOWED_ROLES.includes(clientData.role)) {
        this.logger.warn(
          `[tag-write] SECURITY: ${client.id} (userId=${clientData.userId}, role=${clientData.role}) ` +
            `denied write to tagId=${payload?.tagId}`,
        );
        this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.FORBIDDEN, `Role '${clientData.role}' is not permitted to write tag values`);
        return;
      }

      if (!payload?.tagId || typeof payload.tagId !== 'string' || payload.tagId.trim().length === 0) {
        this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.VALIDATION_ERROR, 'tagId must be a non-empty string');
        return;
      }

      if (payload.value === undefined || payload.value === null) {
        this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.VALIDATION_ERROR, 'value is required');
        return;
      }

      const writeFunction = payload.function ?? 'set';

      this.tagManager.writeTagValue(
        payload.tagId.trim(),
        payload.value,
        clientData.userId,
        writeFunction,
      );

      this.logger.debug(
        `[tag-write] ${client.id} — tagId=${payload.tagId} function=${writeFunction} userId=${clientData.userId}`,
      );

      // ACK back to the originating client
      client.emit(ScadaSocketEvent.TAG_WRITE_ACK, {
        tagId: payload.tagId,
        status: 'accepted',
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.error(`[tag-write] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.INTERNAL_ERROR, 'Tag write failed');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  DAQ_QUERY (stub)                                                  */
  /* ---------------------------------------------------------------- */

  @SubscribeMessage(ScadaSocketEvent.DAQ_QUERY)
  handleDaqQuery(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: DaqQueryDto,
  ): void {
    try {
      const clientData = this.clients.get(client.id);
      if (!clientData) {
        this.emitError(client, ScadaSocketEvent.DAQ_QUERY, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Client not authenticated');
        return;
      }

      if (!payload?.queryId || typeof payload.queryId !== 'string') {
        this.emitError(client, ScadaSocketEvent.DAQ_QUERY, SCADA_ERROR_CODES.VALIDATION_ERROR, 'queryId is required');
        return;
      }

      this.logger.debug(
        `[daq-query] ${client.id} — queryId=${payload.queryId} tags=${payload.tagIds?.length ?? 0}`,
      );

      // TODO: Inject DaqService and forward the query when available.
      // Return an empty result so the client knows the query was received.
      client.emit(ScadaSocketEvent.DAQ_RESULT, {
        queryId: payload.queryId,
        data: {},
        hasMore: false,
      });
    } catch (error) {
      this.logger.error(`[daq-query] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.DAQ_QUERY, SCADA_ERROR_CODES.INTERNAL_ERROR, 'DAQ query failed');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  ALARM_ACK (stub)                                                  */
  /* ---------------------------------------------------------------- */

  @SubscribeMessage(ScadaSocketEvent.ALARM_ACK)
  handleAlarmAck(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: AlarmAckDto,
  ): void {
    try {
      const clientData = this.clients.get(client.id);
      if (!clientData) {
        this.emitError(client, ScadaSocketEvent.ALARM_ACK, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Client not authenticated');
        return;
      }

      if (!WRITE_ALLOWED_ROLES.includes(clientData.role)) {
        this.emitError(client, ScadaSocketEvent.ALARM_ACK, SCADA_ERROR_CODES.FORBIDDEN, `Role '${clientData.role}' cannot acknowledge alarms`);
        return;
      }

      if (!payload?.alarmInstanceId || typeof payload.alarmInstanceId !== 'string') {
        this.emitError(client, ScadaSocketEvent.ALARM_ACK, SCADA_ERROR_CODES.VALIDATION_ERROR, 'alarmInstanceId is required');
        return;
      }

      this.logger.log(
        `[alarm-ack] ${client.id} — alarmInstanceId=${payload.alarmInstanceId} userId=${clientData.userId}`,
      );

      // TODO: Forward to AlarmEngineService when available.
      // The alarm engine will broadcast the updated AlarmStatusSummary once processed.
    } catch (error) {
      this.logger.error(`[alarm-ack] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.ALARM_ACK, SCADA_ERROR_CODES.INTERNAL_ERROR, 'Alarm acknowledgement failed');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  ALARM_ACK_ALL (stub)                                              */
  /* ---------------------------------------------------------------- */

  @SubscribeMessage(ScadaSocketEvent.ALARM_ACK_ALL)
  handleAlarmAckAll(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: AlarmAckAllDto,
  ): void {
    try {
      const clientData = this.clients.get(client.id);
      if (!clientData) {
        this.emitError(client, ScadaSocketEvent.ALARM_ACK_ALL, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Client not authenticated');
        return;
      }

      if (!WRITE_ALLOWED_ROLES.includes(clientData.role)) {
        this.emitError(client, ScadaSocketEvent.ALARM_ACK_ALL, SCADA_ERROR_CODES.FORBIDDEN, `Role '${clientData.role}' cannot acknowledge alarms`);
        return;
      }

      this.logger.log(
        `[alarm-ack-all] ${client.id} — group=${payload?.group ?? 'all'} userId=${clientData.userId}`,
      );

      // TODO: Forward to AlarmEngineService when available.
    } catch (error) {
      this.logger.error(`[alarm-ack-all] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.ALARM_ACK_ALL, SCADA_ERROR_CODES.INTERNAL_ERROR, 'Alarm acknowledgement failed');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  HEARTBEAT                                                         */
  /* ---------------------------------------------------------------- */

  @SubscribeMessage(ScadaSocketEvent.HEARTBEAT)
  handleHeartbeat(@ConnectedSocket() client: Socket): void {
    // Acknowledge so the client knows the connection is still alive
    client.emit(ScadaSocketEvent.HEARTBEAT, { timestamp: Date.now() });
  }

  /* ---------------------------------------------------------------- */
  /*  Server-push helpers (called by other services)                   */
  /* ---------------------------------------------------------------- */

  /**
   * Route a batch of tag value changes for `tenantId` only to that
   * tenant's sockets that have subscribed to those tags. Uses
   * TagManagerService for the tenant-fenced routing map so a value can
   * never be delivered to another tenant's socket.
   */
  pushTagValues(tenantId: string, values: TagValueChange[]): void {
    if (!values || values.length === 0) return;

    try {
      const routingMap = this.tagManager.updateTagValues(tenantId, values);

      for (const [socketId, socketValues] of routingMap) {
        const clientData = this.clients.get(socketId);
        if (!clientData) {
          // Socket disconnected between routing and emit — clean up
          this.tagManager.removeSocket(socketId);
          continue;
        }

        clientData.socket.emit(ScadaSocketEvent.TAG_VALUES, {
          values: socketValues,
        });
      }

      this.logger.debug(
        `[push-tag-values] ${values.length} value(s) routed to ${routingMap.size} socket(s)`,
      );
    } catch (error) {
      this.logger.error(`[push-tag-values] error: ${(error as Error).message}`);
    }
  }

  /**
   * Broadcast an alarm status summary to all clients of a specific tenant.
   */
  pushAlarmStatus(tenantId: string, summary: AlarmStatusSummary): void {
    try {
      this.server.to(`tenant:${tenantId}`).emit(ScadaSocketEvent.ALARM_STATUS, summary);

      this.logger.debug(
        `[push-alarm-status] tenant=${tenantId} — critical=${summary.critical} high=${summary.high}`,
      );
    } catch (error) {
      this.logger.error(`[push-alarm-status] error: ${(error as Error).message}`);
    }
  }

  /**
   * Send a SETVIEW / OPENCARD / TOAST command to all clients of a tenant,
   * or to a specific socket if socketId is provided.
   */
  broadcastCommand(tenantId: string, command: ScadaCommandPayload, socketId?: string): void {
    try {
      let eventName: ScadaSocketEvent;

      switch (command.type) {
        case 'SETVIEW':
          eventName = ScadaSocketEvent.COMMAND_SET_VIEW;
          break;
        case 'OPENCARD':
          eventName = ScadaSocketEvent.COMMAND_OPEN_CARD;
          break;
        case 'TOAST':
          eventName = ScadaSocketEvent.COMMAND_TOAST;
          break;
        default: {
          // Exhaustiveness guard
          const _exhaustive: never = command;
          this.logger.error(`[broadcast-command] unknown command type: ${(_exhaustive as ScadaCommandPayload).type}`);
          return;
        }
      }

      if (socketId) {
        const clientData = this.clients.get(socketId);
        if (clientData) {
          clientData.socket.emit(eventName, command);
        } else {
          this.logger.warn(`[broadcast-command] socketId ${socketId} not found`);
        }
      } else {
        this.server.to(`tenant:${tenantId}`).emit(eventName, command);
      }

      this.logger.debug(
        `[broadcast-command] tenant=${tenantId} type=${command.type}` +
          (socketId ? ` socketId=${socketId}` : ''),
      );
    } catch (error) {
      this.logger.error(`[broadcast-command] error: ${(error as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Diagnostics                                                       */
  /* ---------------------------------------------------------------- */

  /** Number of currently connected and authenticated clients. */
  getConnectedClientCount(): number {
    return this.clients.size;
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Emit a structured error event back to the originating socket.
   */
  private emitError(
    client: Socket,
    event: string,
    code: string,
    message: string,
  ): void {
    const payload: ScadaErrorPayload = {
      event,
      code,
      message,
      timestamp: Date.now(),
    };
    client.emit('scada:error', payload);
  }

  /**
   * Extract JWT from the connection handshake.
   *
   * Priority order (mirrors project-wide pattern):
   *   1. socket.io auth object — most secure, not logged
   *   2. Authorization header  — standard HTTP Bearer token
   *   3. Query parameter       — allowed only in development (logged in URLs)
   */
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
          `SECURITY: ${client.id} rejected — query-parameter tokens are not allowed in production. ` +
            `Use socket.io auth object or Authorization header.`,
        );
        return null;
      }
      return queryToken;
    }

    return null;
  }

  /**
   * Verify the JWT via the shared platform verification helpers — identical
   * policy to every HTTP guard and the sensor-readings/farm WS gateways.
   *
   * `getJwtVerifyOptions` enforces RS256 + issuer + audience at the
   * jsonwebtoken library level (not a per-call `algorithms` override), which
   * closes the RS256->HS256 algorithm-confusion hole the old hand-rolled
   * `JWT_ALGORITHM='HS256'` default opened on the physical-actuation control
   * plane. `enforceAccessTokenType` then rejects refresh / MFA-challenge
   * tokens at the handshake. Returns null on any failure.
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

  /** Count the number of connections for a given tenant. */
  private getConnectionCountForTenant(tenantId: string): number {
    let count = 0;
    for (const c of this.clients.values()) {
      if (c.tenantId === tenantId) count++;
    }
    return count;
  }
}
