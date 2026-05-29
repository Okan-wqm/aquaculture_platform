/**
 * AI Service REST Routes (v2)
 *
 * Proxies REST requests to the AI service for chat and conversation endpoints.
 * Supports SSE streaming for real-time chat responses.
 *
 * SECURITY: Implements header allowlist, path validation, circuit breaker,
 * and request timeout to prevent open-relay abuse.
 */

import { Module, Controller, All, Req, Res, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, ClientProxy, Transport } from '@nestjs/microservices';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom, timeout as rxTimeout } from 'rxjs';
import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
import { Request, Response } from 'express';
import * as http from 'http';

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Header allowlist — only these headers are forwarded to the AI service.
 * Prevents leaking internal infrastructure headers (cookie, host, etc.)
 */
const ALLOWED_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'x-correlation-id',
  'x-tenant-id',
]);

/**
 * Patterns that indicate path traversal or command injection attempts.
 */
const DANGEROUS_PATH_PATTERNS = /(\.\.|\/\/|[;|&`$])/;

/**
 * Request timeout in milliseconds.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const AI_CONSENT_TIMEOUT_MS = 3_000;

@Controller('api/v2/ai')
export class AiRoutesController {
  private readonly logger = new Logger(AiRoutesController.name);
  private readonly aiServiceUrl: string;

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private readonly failureThreshold = 3;
  private readonly openDurationMs = 30_000;
  private lastFailureTime = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {
    this.aiServiceUrl = this.configService.get<string>('AI_SERVICE_URL', 'http://localhost:3008');
  }

  // Express v5 path-to-regexp v8: bare '*' wildcard is no longer valid.
  // Use named wildcard parameter '{*path}' which captures the full sub-path.
  @All('{*path}')
  async proxy(@Req() req: Request, @Res() res: Response): Promise<void> {
    // --- Path validation ---
    const requestPath = req.originalUrl;
    if (DANGEROUS_PATH_PATTERNS.test(requestPath)) {
      this.logger.warn(`Blocked suspicious AI proxy path: ${requestPath}`);
      res.status(400).json({ error: 'Invalid request path' });
      return;
    }

    // --- Circuit breaker check ---
    if (this.circuitState === CircuitState.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.openDurationMs) {
        res.status(503).json({ error: 'AI service temporarily unavailable (circuit open)' });
        return;
      }
      // Transition to half-open: allow one probe request
      this.circuitState = CircuitState.HALF_OPEN;
      this.logger.log('Circuit breaker transitioning to HALF_OPEN');
    }

    const consentAllowed = await this.assertAiConsent(req, res);
    if (!consentAllowed) {
      return;
    }

    const targetUrl = `${this.aiServiceUrl}${requestPath}`;
    this.logger.debug(`Proxying AI request to: ${targetUrl}`);

    const url = new URL(targetUrl);

    // --- Build allowlisted headers ---
    const forwardedHeaders: Record<string, string> = {
      host: url.host,
    };
    for (const headerName of ALLOWED_HEADERS) {
      const value = req.headers[headerName];
      if (typeof value === 'string') {
        forwardedHeaders[headerName] = value;
      }
    }

    // --- 30s timeout via AbortController ---
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

    const proxyReq = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: req.method,
        headers: forwardedHeaders,
        signal: abortController.signal,
      },
      (proxyRes) => {
        clearTimeout(timeout);
        this.onSuccess();
        res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      clearTimeout(timeout);
      this.onFailure();

      this.logger.error(`AI proxy error: ${err.message}`);

      if (res.headersSent) {
        return;
      }

      if (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        res.status(504).json({ error: 'AI service request timed out' });
      } else if (
        (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
        (err as NodeJS.ErrnoException).code === 'ENOTFOUND' ||
        (err as NodeJS.ErrnoException).code === 'ECONNRESET'
      ) {
        res.status(502).json({ error: 'AI service connection failed' });
      } else {
        res.status(502).json({ error: 'AI service unavailable' });
      }
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  }

  /**
   * Record a successful request — reset circuit breaker.
   */
  private onSuccess(): void {
    if (this.circuitState === CircuitState.HALF_OPEN) {
      this.logger.log('Circuit breaker closing after successful probe');
    }
    this.failureCount = 0;
    this.circuitState = CircuitState.CLOSED;
  }

  /**
   * Record a failure — potentially trip circuit breaker.
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.circuitState === CircuitState.HALF_OPEN) {
      // Probe failed, reopen
      this.circuitState = CircuitState.OPEN;
      this.logger.warn('Circuit breaker re-opened after failed probe');
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.circuitState = CircuitState.OPEN;
      this.logger.warn(`Circuit breaker opened after ${this.failureCount} consecutive failures`);
    }
  }

  private async assertAiConsent(req: Request, res: Response): Promise<boolean> {
    const tenantId = req.headers['x-tenant-id'];
    const authorization = req.headers.authorization;
    if (typeof tenantId !== 'string' || typeof authorization !== 'string') {
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }

    const token = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }

    let payload: Record<string, unknown>;
    try {
      payload = await this.jwtService.verifyAsync<Record<string, unknown>>(token);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return false;
    }

    const userId = payload['sub'];
    if (typeof userId !== 'string' || userId.length === 0) {
      res.status(401).json({ error: 'Invalid token' });
      return false;
    }

    try {
      const allowed = await firstValueFrom(
        this.natsClient
          .send<boolean>('request.messaging.aiConsentAllowed', {
            tenantId,
            userId,
            purpose: 'gateway-ai-proxy',
          })
          .pipe(rxTimeout(AI_CONSENT_TIMEOUT_MS)),
      );
      if (!allowed) {
        res.status(403).json({ error: 'AI consent required' });
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(`AI consent check failed closed: ${(error as Error).message}`);
      res.status(503).json({ error: 'AI consent check unavailable' });
      return false;
    }
  }

  // Exposed for testing
  /** @internal */ getCircuitState(): CircuitState {
    return this.circuitState;
  }
  /** @internal */ resetCircuit(): void {
    this.circuitState = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }
}

/**
 * AI Routes Module
 */
@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('gateway-api'),
      },
    ]),
  ],
  controllers: [AiRoutesController],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AiRoutesModule {}
