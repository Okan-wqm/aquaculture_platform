import { Logger } from '@nestjs/common';
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
import { buildWsCorsConfig } from '@aquaculture/backend-common/websocket';
import { WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Decoded JWT payload for ST language clients.
 *
 * `type` and `jti` are required for `enforceAccessTokenType` — refresh
 * and MFA-challenge tokens carry `type !== 'access'` and must be
 * rejected at handshake (H-1 fix).
 */
interface TokenPayload {
  sub: string;
  tenantId?: string;
  userId?: string;
  roles?: string[];
  type?: string;
  jti?: string;
  [key: string]: unknown;
}

interface STRequest {
  type: 'analyze' | 'hover' | 'complete' | 'format' | 'outline' | 'definition' | 'references';
  requestId: string;
  programId?: string;
  code: string;
  position?: { line: number; character: number };
  range?: { startLine: number; endLine: number };
}

interface STResponse {
  type:
    | 'diagnostics'
    | 'hover'
    | 'completions'
    | 'formatted'
    | 'outline'
    | 'definition'
    | 'references'
    | 'error';
  requestId: string;
  data: unknown;
  processingTimeMs?: number;
  error?: { code: string; message: string };
}

type STErrorCode =
  | 'SOURCE_TOO_LARGE'
  | 'PARSE_TIMEOUT'
  | 'WORKER_BUSY'
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'TENANT_MISMATCH'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

interface NatsLanguageReply {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  processingTimeMs?: number;
}

interface ConnectedClient {
  socket: Socket;
  tenantId: string;
  userId: string;
  /** Per-connection message timestamps for rate limiting */
  messageTimes: number[];
}

// ---------------------------------------------------------------------------
// Rate limit constants
// ---------------------------------------------------------------------------

/** Max messages per second per connection */
const RATE_LIMIT_PER_SECOND = 10;
/** Max messages per minute per tenant */
const RATE_LIMIT_PER_MINUTE_TENANT = 100;
/** Max message payload size in bytes (150 KB) */
const MAX_MESSAGE_SIZE = 150 * 1024;
/** Idle timeout in milliseconds (5 minutes) */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Max concurrent connections per tenant */
const MAX_CONNECTIONS_PER_TENANT = 10;

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

@WebSocketGateway({
  cors: buildWsCorsConfig('STLanguageGateway'),
  namespace: '/st-language',
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: MAX_MESSAGE_SIZE,
})
export class STLanguageGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(STLanguageGateway.name);
  private clients = new Map<string, ConnectedClient>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Tenant-level rate limit: tenantId -> message timestamps */
  private tenantMessageTimes = new Map<string, number[]>();

  private readonly isProduction: boolean;

  /**
   * ConfigService is REQUIRED (no `@Optional()`): `getJwtVerifyOptions`
   * calls `getOrThrow<string>('JWT_SECRET')` on it. A gateway
   * instantiated without ConfigService is a configuration error, not
   * a supported deployment mode — fail-fast at construction time.
   */
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    // SEC-MEDIUM-082 (2026-08-23 scan №18): hard revocation re-check backs
    // the idle/idle-timeout lifecycle this gateway already enforces.
    private readonly tokenRevalidator: WsTokenRevalidator,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  afterInit(): void {
    this.logger.log('ST Language WebSocket Gateway initialized (/st-language)');
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
      const userId = payload.userId ?? payload.sub ?? 'unknown';

      // Enforce max connections per tenant
      const tenantConnectionCount = this.getConnectionCountForTenant(tenantId);
      if (tenantConnectionCount >= MAX_CONNECTIONS_PER_TENANT) {
        this.logger.warn(
          `SECURITY: Tenant ${tenantId} exceeded max connections (${MAX_CONNECTIONS_PER_TENANT})`,
        );
        client.emit('error', { message: 'Too many connections for this tenant' });
        client.disconnect();
        return;
      }

      // SEC-MEDIUM-082 (№18): periodic revocation re-check.
      this.tokenRevalidator.register(client.id, {
        tenantId,
        userId,
        jti: typeof payload.jti === 'string' ? payload.jti : '',
        issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
        disconnect: (reason) => {
          this.logger.warn(`ST socket ${client.id} disconnected: ${reason}`);
          client.disconnect(true);
        },
      });

      this.clients.set(client.id, {
        socket: client,
        tenantId,
        userId,
        messageTimes: [],
      });

      // Join tenant-specific room for push events
      void client.join(`tenant:${tenantId}`);

      // Start idle timer
      this.resetIdleTimer(client.id);

      this.logger.log(`Client ${client.id} connected for tenant ${tenantId}`);

      client.emit('connected', {
        message: 'Connected to ST Language Service',
        tenantId,
      });
    } catch (error) {
      this.logger.error(`Connection error: ${(error as Error).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.tokenRevalidator.unregister(client.id);
    this.clients.delete(client.id);
    this.clearIdleTimer(client.id);
    this.logger.log(`Client ${client.id} disconnected`);
  }

  // -----------------------------------------------------------------------
  // Message handler
  // -----------------------------------------------------------------------

  @SubscribeMessage('st:request')
  async handleStRequest(client: Socket, payload: STRequest): Promise<STResponse> {
    const clientData = this.clients.get(client.id);
    if (!clientData) {
      return this.errorResponse('unknown', 'UNAUTHORIZED', 'Client not authenticated');
    }

    // Reset idle timer on activity
    this.resetIdleTimer(client.id);

    // Validate request shape
    if (!payload || !payload.type || !payload.requestId) {
      return this.errorResponse(
        payload?.requestId ?? 'unknown',
        'INVALID_REQUEST',
        'Missing required fields: type, requestId',
      );
    }

    // Check message size (approximate: JSON-serialized payload)
    const payloadSize = payload.code ? Buffer.byteLength(payload.code, 'utf8') : 0;
    if (payloadSize > MAX_MESSAGE_SIZE) {
      return this.errorResponse(
        payload.requestId,
        'SOURCE_TOO_LARGE',
        `Message size ${payloadSize} exceeds limit of ${MAX_MESSAGE_SIZE} bytes`,
      );
    }

    // Rate limiting: per-connection (10 msg/s)
    if (!this.checkConnectionRateLimit(clientData)) {
      return this.errorResponse(
        payload.requestId,
        'RATE_LIMITED',
        `Rate limit exceeded: max ${RATE_LIMIT_PER_SECOND} messages per second`,
      );
    }

    // Rate limiting: per-tenant (100 msg/min)
    if (!this.checkTenantRateLimit(clientData.tenantId)) {
      return this.errorResponse(
        payload.requestId,
        'RATE_LIMITED',
        `Tenant rate limit exceeded: max ${RATE_LIMIT_PER_MINUTE_TENANT} messages per minute`,
      );
    }

    const validTypes = [
      'analyze',
      'hover',
      'complete',
      'format',
      'outline',
      'definition',
      'references',
    ];
    if (!validTypes.includes(payload.type)) {
      return this.errorResponse(
        payload.requestId,
        'INVALID_REQUEST',
        `Invalid request type: ${payload.type}`,
      );
    }

    // Delegate to the bridge service via event emission.
    // The STLanguageBridgeService listens for 'st:nats-request' on this server
    // and handles NATS communication + response.
    const startTime = Date.now();

    try {
      const natsReply = (await this.delegateToNats(
        clientData.tenantId,
        payload,
      )) as NatsLanguageReply;

      // Check if the NATS handler returned an error
      if (natsReply.success === false && natsReply.error) {
        return this.errorResponse(payload.requestId, 'INTERNAL_ERROR', natsReply.error.message);
      }

      return {
        type: this.mapRequestTypeToResponseType(payload.type),
        requestId: payload.requestId,
        data: natsReply.data,
        processingTimeMs: natsReply.processingTimeMs ?? Date.now() - startTime,
      };
    } catch (error) {
      const internalMessage = (error as Error).message ?? 'Internal error';
      this.logger.error(`ST request failed for tenant ${clientData.tenantId}: ${internalMessage}`);
      // Do not leak internal error details to client
      return this.errorResponse(
        payload.requestId,
        'INTERNAL_ERROR',
        'Language service request failed',
      );
    }
  }

  // -----------------------------------------------------------------------
  // Public methods (used by STLanguageBridgeService for server-push)
  // -----------------------------------------------------------------------

  /**
   * Push a server event to all clients of a specific tenant.
   * Used by STLanguageBridgeService when NATS events arrive.
   */
  pushToTenant(tenantId: string, event: string, data: unknown): void {
    this.server.to(`tenant:${tenantId}`).emit(event, data);
  }

  /**
   * Get the internal server instance (used by bridge service).
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Delegate handler — set by STLanguageBridgeService during init.
   * This avoids a circular dependency between gateway and bridge.
   */
  private natsDelegate: ((tenantId: string, request: STRequest) => Promise<unknown>) | null = null;

  setNatsDelegate(fn: (tenantId: string, request: STRequest) => Promise<unknown>): void {
    this.natsDelegate = fn;
  }

  private async delegateToNats(tenantId: string, request: STRequest): Promise<unknown> {
    if (!this.natsDelegate) {
      throw new Error('NATS bridge not initialized');
    }
    return this.natsDelegate(tenantId, request);
  }

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  private checkConnectionRateLimit(clientData: ConnectedClient): boolean {
    const now = Date.now();
    const oneSecondAgo = now - 1000;

    // Prune old entries
    clientData.messageTimes = clientData.messageTimes.filter((t) => t > oneSecondAgo);

    if (clientData.messageTimes.length >= RATE_LIMIT_PER_SECOND) {
      return false;
    }

    clientData.messageTimes.push(now);
    return true;
  }

  private checkTenantRateLimit(tenantId: string): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    let times = this.tenantMessageTimes.get(tenantId);
    if (!times) {
      times = [];
      this.tenantMessageTimes.set(tenantId, times);
    }

    // Prune old entries
    const pruned = times.filter((t) => t > oneMinuteAgo);
    this.tenantMessageTimes.set(tenantId, pruned);

    if (pruned.length >= RATE_LIMIT_PER_MINUTE_TENANT) {
      return false;
    }

    pruned.push(now);
    return true;
  }

  // -----------------------------------------------------------------------
  // Idle timeout
  // -----------------------------------------------------------------------

  private resetIdleTimer(clientId: string): void {
    this.clearIdleTimer(clientId);

    const timer = setTimeout(() => {
      const clientData = this.clients.get(clientId);
      if (clientData) {
        this.logger.log(`Client ${clientId} idle timeout — disconnecting`);
        clientData.socket.emit('error', { message: 'Idle timeout' });
        clientData.socket.disconnect();
      }
    }, IDLE_TIMEOUT_MS);

    this.idleTimers.set(clientId, timer);
  }

  private clearIdleTimer(clientId: string): void {
    const timer = this.idleTimers.get(clientId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(clientId);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getConnectionCountForTenant(tenantId: string): number {
    let count = 0;
    for (const c of this.clients.values()) {
      if (c.tenantId === tenantId) count++;
    }
    return count;
  }

  private mapRequestTypeToResponseType(type: STRequest['type']): STResponse['type'] {
    const map: Record<STRequest['type'], STResponse['type']> = {
      analyze: 'diagnostics',
      hover: 'hover',
      complete: 'completions',
      format: 'formatted',
      outline: 'outline',
      definition: 'definition',
      references: 'references',
    };
    return map[type] ?? 'error';
  }

  private errorResponse(requestId: string, code: STErrorCode, message: string): STResponse {
    return {
      type: 'error',
      requestId,
      data: null,
      error: { code, message },
    };
  }

  private extractToken(client: Socket): string | null {
    // 1. socket.io auth object (most secure)
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') {
      return auth.token;
    }

    // 2. Authorization header
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // 3. Query parameter (dev only)
    const queryToken = client.handshake.query.token;
    if (typeof queryToken === 'string') {
      if (this.isProduction) {
        this.logger.warn(
          `SECURITY: Client ${client.id} rejected — query parameter tokens not allowed in production`,
        );
        return null;
      }
      return queryToken;
    }

    return null;
  }

  /**
   * Validate a JWT token via the shared platform verification helpers.
   *
   * Uses `verifyAsync` (async, non-blocking) + `getJwtVerifyOptions`
   * which enforces RS256 + issuer + audience at the jsonwebtoken
   * library level, and `enforceAccessTokenType` which rejects refresh
   * and MFA-challenge tokens at handshake (H-1).
   *
   * The previous implementation used sync `verify()` with only
   * `algorithms: ['HS256']` — no iss, no aud, no type check. All four
   * gaps are closed by this refactor.
   */
  private async validateToken(token: string): Promise<TokenPayload | null> {
    try {
      const result = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      if (typeof result !== 'object' || result === null) return null;
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
