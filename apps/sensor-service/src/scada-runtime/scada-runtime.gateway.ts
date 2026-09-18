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
import { EventEmitter2 } from '@nestjs/event-emitter';
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
  PinVerifyDto,
  DAQ_AGG_MAX_SPAN_MS,
  DAQ_INTERVAL_MS,
  DAQ_MAX_TOTAL_POINTS,
  DAQ_RAW_ASSUMED_SAMPLE_INTERVAL_MS,
  DAQ_RAW_MAX_SPAN_MS,
  DAQ_RATE_BURST,
  DAQ_RATE_REFILL_PER_SEC,
} from './dto/scada-socket.dto';
import { TagManagerService } from './services/tag-manager.service';
import { DaqStorageService } from './services/daq-storage.service';
import { TagResolutionService } from '../process/services/tag-resolution.service';
import { ScadaPackageService } from '../process/services/scada-package.service';
import { TagDirection } from '../process/entities/unified-tag.entity';
import {
  SCADA_ALARM_ACK_EVENT,
  SCADA_ALARM_ACK_ALL_EVENT,
} from './services/alarm-ack.events';
import {
  SCADA_TENANT_OPERATOR_CONNECTED,
  SCADA_TENANT_OPERATOR_DISCONNECTED,
  type ScadaTenantOperatorEvent,
} from './services/scada-activation.events';
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
  /** PIN elevation (SENSOR-CRITICAL-006): epoch-ms until which pin-protected writes are allowed. */
  pinElevatedUntil?: number;
}

/**
 * Server-side PIN lockout state (M3), keyed by `tenantId:packageId` — NOT by
 * socket.id, so a brute-forcer cannot reset the budget by reconnecting.
 */
interface PinLockoutState {
  /** Consecutive failed attempts since the last success / lockout expiry. */
  failCount: number;
  /** Completed lockouts — drives the exponential backoff multiplier. */
  lockoutNumber: number;
  /** Epoch-ms until which PIN_VERIFY for this key is refused. */
  lockedUntil: number;
  /** Epoch-ms of the last state change (sweep staleness bound). */
  lastActivityAt: number;
}

/** Per-socket DAQ_QUERY token bucket (M7). */
interface DaqRateBucket {
  tokens: number;
  lastRefill: number;
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

  /**
   * PIN lockout registry (M3): `tenantId:packageId` → state. In-memory by
   * design (documented trade-off): a restart clears lockouts, which costs at
   * most one extra 5-attempt budget per key per process lifetime — far
   * cheaper than a DB round-trip on the hot PIN_VERIFY path. A periodic
   * sweep (below) drops expired entries so the map cannot grow unbounded.
   */
  private readonly pinLockouts = new Map<string, PinLockoutState>();

  /** Per-socket DAQ token buckets (M7): socketId → bucket. */
  private readonly daqRateBuckets = new Map<string, DaqRateBucket>();

  /** Periodic sweep that evicts expired PIN-lockout entries. */
  private pinLockoutSweep: ReturnType<typeof setInterval> | null = null;

  private readonly isProduction: boolean;

  constructor(
    private readonly jwtService: JwtService,
    private readonly tagManager: TagManagerService,
    private readonly configService: ConfigService,
    private readonly tagResolution: TagResolutionService,
    private readonly eventEmitter: EventEmitter2,
    private readonly daqStorage: DaqStorageService,
    private readonly scadaPackageService: ScadaPackageService,
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
    // Periodic cleanup (M3): drop PIN-lockout entries that are fully expired
    // (lockout elapsed AND no residual fail budget) or stale (no activity for
    // an hour), so the registry cannot grow unbounded across reconnect churn.
    this.pinLockoutSweep = setInterval(() => {
      const now = Date.now();
      for (const [key, state] of this.pinLockouts) {
        const idleTooLong = now - state.lastActivityAt > 60 * 60 * 1000;
        if (idleTooLong || (state.lockedUntil <= now && state.failCount === 0)) {
          this.pinLockouts.delete(key);
        }
      }
    }, 5 * 60 * 1000);
    this.pinLockoutSweep.unref?.();
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
      // Count BEFORE registering this socket: 0 ⇒ this is the tenant's first
      // operator (the lazy-activation edge, RT-011 Faz 3).
      const priorTenantConnections = this.getConnectionCountForTenant(tenantId);
      if (priorTenantConnections >= MAX_CONNECTIONS_PER_TENANT) {
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

      // First operator for this tenant → signal the activation bridge to load
      // its PUBLISHED SCADA package into the engine (D4 lazy activation). Crosses
      // the boundary as an event — the engine depends on this gateway (circular).
      if (priorTenantConnections === 0) {
        this.eventEmitter.emit(SCADA_TENANT_OPERATOR_CONNECTED, {
          tenantId,
        } satisfies ScadaTenantOperatorEvent);
      }

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
      // Capture the tenant BEFORE removing the client so we can detect the
      // tenant's last operator leaving (→0 ⇒ idle, RT-011 Faz 3).
      const tenantId = this.clients.get(client.id)?.tenantId;
      this.tagManager.removeSocket(client.id);
      this.clients.delete(client.id);
      // The DAQ token bucket is per-socket (M7) — the socket is gone, so is
      // its bucket. (PIN lockouts intentionally SURVIVE disconnects: they
      // are keyed tenant+package, not socket.)
      this.daqRateBuckets.delete(client.id);
      this.logger.log(`[disconnect] ${client.id}`);

      // Last operator for this tenant → signal the activation bridge to start
      // the idle clock (the eviction sweep deactivates it after the grace period).
      if (tenantId && this.getConnectionCountForTenant(tenantId) === 0) {
        this.eventEmitter.emit(SCADA_TENANT_OPERATOR_DISCONNECTED, {
          tenantId,
        } satisfies ScadaTenantOperatorEvent);
      }
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
  async handleTagWrite(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TagWriteDto,
  ): Promise<void> {
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

      const tagId = payload.tagId.trim();

      // Tenant + registry ownership gate. Unlike the subscribe path — which
      // grandfathers legacy non-TagRef keys — a control WRITE must resolve
      // STRICTLY against THIS tenant's registry: the target must be a
      // registered tag of clientData.tenantId, and it must be writable
      // (an INPUT tag cannot be actuated). This closes cross-tenant actuation
      // by a predictable deviceCode/localName (SENSOR-CRITICAL-005).
      const resolution = await this.tagResolution.resolve(clientData.tenantId, [tagId]);
      const binding = resolution.resolved[0];
      if (!binding) {
        this.logger.warn(
          `[tag-write] SECURITY: ${client.id} (tenant=${clientData.tenantId}) denied — ` +
            `tagId=${tagId} not registered for this tenant`,
        );
        this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.FORBIDDEN, 'Tag is not registered for this tenant');
        return;
      }
      if (binding.direction === TagDirection.INPUT) {
        this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.FORBIDDEN, 'Tag is read-only (input) and cannot be written');
        return;
      }

      // Control-security PIN gate (SENSOR-CRITICAL-006): a tag bound to a
      // pin-protected widget in ANY of this tenant's packages requires a
      // server-verified PIN elevation on this socket. Keyed by TAG, not by
      // caller-supplied package context, so a direct socket.emit cannot opt
      // out of the widget's protection.
      if (await this.isPinProtectedTag(clientData.tenantId, tagId)) {
        const elevated =
          typeof clientData.pinElevatedUntil === 'number' &&
          clientData.pinElevatedUntil > Date.now();
        if (!elevated) {
          this.logger.warn(
            `[tag-write] SECURITY: ${client.id} (tenant=${clientData.tenantId}) denied — ` +
              `tagId=${tagId} is PIN-protected and the socket is not PIN-elevated`,
          );
          this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.FORBIDDEN, 'PIN verification required for this control (send PIN_VERIFY first)');
          return;
        }
      }

      const writeFunction = payload.function ?? 'set';

      this.tagManager.writeTagValue(
        tagId,
        payload.value,
        clientData.userId,
        clientData.tenantId,
        writeFunction,
      );

      this.logger.debug(
        `[tag-write] ${client.id} — tenant=${clientData.tenantId} tagId=${tagId} function=${writeFunction} userId=${clientData.userId}`,
      );

      // ACK 'queued', not 'accepted': the write is emitted as an internal event
      // for a device-driver adapter to fulfil; the gateway has no confirmation
      // that it reached a device, so it must not assert success (a confirmed
      // ACK is gated on a real completion event — tracked follow-on).
      client.emit(ScadaSocketEvent.TAG_WRITE_ACK, {
        tagId: payload.tagId,
        status: 'queued',
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.error(`[tag-write] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.TAG_WRITE, SCADA_ERROR_CODES.INTERNAL_ERROR, 'Tag write failed');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  DAQ_QUERY                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Token-bucket rate limit for 'scada:daq:query' (M7): 5 req/s sustained,
   * burst 10, per socket. Returns true when the request is admitted.
   */
  private admitDaqQuery(socketId: string): boolean {
    const now = Date.now();
    const bucket = this.daqRateBuckets.get(socketId) ?? {
      tokens: DAQ_RATE_BURST,
      lastRefill: now,
    };
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      DAQ_RATE_BURST,
      bucket.tokens + elapsedSec * DAQ_RATE_REFILL_PER_SEC,
    );
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      this.daqRateBuckets.set(socketId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.daqRateBuckets.set(socketId, bucket);
    return true;
  }

  /**
   * Span + total-points bounds for a DAQ query (M7):
   *  - raw (no aggregation) spans are capped at DAQ_RAW_MAX_SPAN_MS (7 d);
   *  - aggregated spans are capped at DAQ_AGG_MAX_SPAN_MS (365 d);
   *  - the estimated point total (tags × buckets, raw estimated at one
   *    sample per 10 s per tag) is capped at DAQ_MAX_TOTAL_POINTS.
   * Returns an error message when the query must be rejected, else null.
   */
  private validateDaqQueryBounds(payload: DaqQueryDto): string | null {
    const from = Number(payload.from);
    const to = Number(payload.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return `'to' must be greater than 'from'`;
    }
    const spanMs = to - from;
    const tagCount = Array.isArray(payload.tagIds) ? payload.tagIds.length : 0;

    if (!payload.aggregation) {
      if (spanMs > DAQ_RAW_MAX_SPAN_MS) {
        return (
          `Raw (unaggregated) DAQ queries are limited to 7 days — the requested span is ` +
          `${(spanMs / (24 * 60 * 60 * 1000)).toFixed(1)} day(s). Add an aggregation for longer ranges.`
        );
      }
      const estimatedPoints = tagCount * Math.ceil(spanMs / DAQ_RAW_ASSUMED_SAMPLE_INTERVAL_MS);
      if (estimatedPoints > DAQ_MAX_TOTAL_POINTS) {
        return (
          `DAQ query too large: ~${estimatedPoints} data points requested (cap ${DAQ_MAX_TOTAL_POINTS}). ` +
          `Narrow the time range, reduce the number of tags, or request an aggregation.`
        );
      }
      return null;
    }

    if (spanMs > DAQ_AGG_MAX_SPAN_MS) {
      return (
        `Aggregated DAQ queries are limited to 365 days — the requested span is ` +
        `${(spanMs / (24 * 60 * 60 * 1000)).toFixed(0)} day(s).`
      );
    }
    const intervalMs = DAQ_INTERVAL_MS[payload.aggregation.interval];
    const estimatedPoints = tagCount * Math.ceil(spanMs / intervalMs);
    if (estimatedPoints > DAQ_MAX_TOTAL_POINTS) {
      return (
        `DAQ query too large: ~${estimatedPoints} data points requested (cap ${DAQ_MAX_TOTAL_POINTS}). ` +
        `Widen the aggregation interval, narrow the time range, or reduce the number of tags.`
      );
    }
    return null;
  }

  @SubscribeMessage(ScadaSocketEvent.DAQ_QUERY)
  async handleDaqQuery(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: DaqQueryDto,
  ): Promise<void> {
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

      // Per-socket token bucket FIRST (M7): a burst client is rejected before
      // doing any span math or touching the history store.
      if (!this.admitDaqQuery(client.id)) {
        this.emitError(
          client,
          ScadaSocketEvent.DAQ_QUERY,
          SCADA_ERROR_CODES.RATE_LIMITED,
          'DAQ query rate limit exceeded (5/s, burst 10) — slow down',
        );
        return;
      }

      // Span + total-point bounds (M7).
      const boundsError = this.validateDaqQueryBounds(payload);
      if (boundsError) {
        this.emitError(client, ScadaSocketEvent.DAQ_QUERY, SCADA_ERROR_CODES.VALIDATION_ERROR, boundsError);
        return;
      }

      this.logger.debug(
        `[daq-query] ${client.id} — queryId=${payload.queryId} tags=${payload.tagIds?.length ?? 0}`,
      );

      // Real history read (SENSOR-HIGH-053): tenant-fenced against the DAQ
      // store, chunked so long ranges stream instead of one giant frame.
      // Previously this was a stub that emitted an empty result — trends
      // rendered "successfully" blank.
      await this.daqStorage.queryChunked(
        clientData.tenantId,
        payload.tagIds,
        new Date(payload.from),
        new Date(payload.to),
        (chunk) => client.emit(ScadaSocketEvent.DAQ_RESULT, chunk),
        payload.queryId,
        payload.aggregation,
      );
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

      // Hand off to the alarm engine (which persists the ack and re-broadcasts
      // the updated AlarmStatusSummary). The engine cannot be injected here —
      // it already depends on this gateway — so acknowledgement crosses the
      // boundary as an event.
      this.eventEmitter.emit(SCADA_ALARM_ACK_EVENT, {
        alarmInstanceId: payload.alarmInstanceId,
        userId: clientData.userId,
        tenantId: clientData.tenantId,
      });
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

      this.eventEmitter.emit(SCADA_ALARM_ACK_ALL_EVENT, {
        userId: clientData.userId,
        tenantId: clientData.tenantId,
      });
    } catch (error) {
      this.logger.error(`[alarm-ack-all] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.ALARM_ACK_ALL, SCADA_ERROR_CODES.INTERNAL_ERROR, 'Alarm acknowledgement failed');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  HEARTBEAT                                                         */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /*  PIN_VERIFY (SENSOR-CRITICAL-006)                                  */
  /* ---------------------------------------------------------------- */

  /** PIN elevation lifetime after a successful verification. */
  private static readonly PIN_ELEVATION_MS = 5 * 60 * 1000;
  /** Failed attempts (per tenant+package) before the lockout engages. */
  private static readonly PIN_MAX_ATTEMPTS = 5;
  /** First lockout duration; each subsequent lockout doubles it… */
  private static readonly PIN_INITIAL_LOCKOUT_MS = 60 * 1000;
  /** …up to this ceiling. */
  private static readonly PIN_MAX_LOCKOUT_MS = 15 * 60 * 1000;
  /** Staleness bound for the per-tenant pin-protected tag set. */
  private static readonly PIN_SET_TTL_MS = 60 * 1000;

  /** tenantId → cached pin-protected tag keys. */
  private readonly pinProtectedCache = new Map<string, { keys: Set<string>; expiresAt: number }>();

  private async isPinProtectedTag(tenantId: string, tagId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.pinProtectedCache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.keys.has(tagId);
    const keys = await this.scadaPackageService.getPinProtectedTagKeys(tenantId);
    this.pinProtectedCache.set(tenantId, { keys, expiresAt: now + ScadaRuntimeGateway.PIN_SET_TTL_MS });
    return keys.has(tagId);
  }

  /**
   * Verify a control-security PIN against the package's stored (hashed) PIN
   * and elevate this socket for a bounded window (SENSOR-CRITICAL-006 — the
   * client NEVER sees the stored secret).
   *
   * Brute-force defence (M3): lockout state lives SERVER-SIDE, keyed by
   * (tenantId, packageId) — reconnecting does not reset it. 5 consecutive
   * failures engage a 60 s lockout; every further lockout DOUBLES the
   * duration (60 s → 2 m → 4 m → …) up to 15 minutes. Every engagement is
   * audit-logged. The per-socket elevation window stays per-socket.
   */
  @SubscribeMessage(ScadaSocketEvent.PIN_VERIFY)
  async handlePinVerify(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: PinVerifyDto,
  ): Promise<void> {
    try {
      const clientData = this.clients.get(client.id);
      if (!clientData) {
        this.emitError(client, ScadaSocketEvent.PIN_VERIFY, SCADA_ERROR_CODES.AUTH_REQUIRED, 'Client not authenticated');
        return;
      }

      const lockoutKey = `${clientData.tenantId}:${payload.packageId}`;
      const now = Date.now();
      const lockout = this.pinLockouts.get(lockoutKey);
      if (lockout && lockout.lockedUntil > now) {
        client.emit(ScadaSocketEvent.PIN_RESULT, {
          valid: false,
          lockedUntil: lockout.lockedUntil,
        });
        return;
      }

      const valid = await this.scadaPackageService.verifyPackagePin(
        payload.packageId,
        clientData.tenantId,
        payload.pin,
      );

      if (valid) {
        // Success clears the budget for this tenant+package.
        this.pinLockouts.delete(lockoutKey);
        clientData.pinElevatedUntil = now + ScadaRuntimeGateway.PIN_ELEVATION_MS;
        client.emit(ScadaSocketEvent.PIN_RESULT, {
          valid: true,
          expiresAt: clientData.pinElevatedUntil,
        });
        return;
      }

      const state: PinLockoutState = lockout ?? {
        failCount: 0,
        lockoutNumber: 0,
        lockedUntil: 0,
        lastActivityAt: now,
      };
      state.failCount += 1;
      state.lastActivityAt = now;
      if (state.failCount >= ScadaRuntimeGateway.PIN_MAX_ATTEMPTS) {
        state.lockoutNumber += 1;
        const backoffMs = Math.min(
          ScadaRuntimeGateway.PIN_INITIAL_LOCKOUT_MS * 2 ** (state.lockoutNumber - 1),
          ScadaRuntimeGateway.PIN_MAX_LOCKOUT_MS,
        );
        state.lockedUntil = now + backoffMs;
        state.failCount = 0;
        this.pinLockouts.set(lockoutKey, state);
        // Audit event (M3): security-relevant, greppable, names the scope.
        this.logger.warn(
          `[pin-verify] SECURITY AUDIT: PIN lockout engaged ` +
            `tenant=${clientData.tenantId} package=${payload.packageId} ` +
            `userId=${clientData.userId} socket=${client.id} ` +
            `lockout#${state.lockoutNumber} durationMs=${backoffMs}`,
        );
        client.emit(ScadaSocketEvent.PIN_RESULT, { valid: false, lockedUntil: state.lockedUntil });
        return;
      }
      this.pinLockouts.set(lockoutKey, state);
      client.emit(ScadaSocketEvent.PIN_RESULT, { valid: false });
    } catch (error) {
      this.logger.error(`[pin-verify] ${client.id} error: ${(error as Error).message}`);
      this.emitError(client, ScadaSocketEvent.PIN_VERIFY, SCADA_ERROR_CODES.INTERNAL_ERROR, 'PIN verification failed');
    }
  }

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
   * Forward captured script console output to the authoring tenant's HMI
   * console panel ONLY. Scoped to `tenant:${tenantId}` so one tenant's script
   * output can never surface in another tenant's console (RT-011: the raw
   * `server.emit` this replaces fanned every script line to all sockets).
   */
  pushScriptConsole(
    tenantId: string,
    entry: { scriptId: string; level: 'log' | 'warn' | 'error'; message: string; timestamp: number },
  ): void {
    if (!this.server) return;
    try {
      this.server.to(`tenant:${tenantId}`).emit(ScadaSocketEvent.SCRIPT_CONSOLE, entry);
    } catch (error) {
      this.logger.error(`[push-script-console] error: ${(error as Error).message}`);
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
