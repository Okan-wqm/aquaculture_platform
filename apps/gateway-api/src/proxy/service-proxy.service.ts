/**
 * Service Proxy Service
 *
 * Proxies requests to upstream microservices.
 * Handles request/response transformation, retries, and error handling.
 * Supports HTTP, WebSocket, and SSE proxying.
 */

import { createHash } from 'crypto';

import { buildGatewayVerifiedUserAssertion, buildSignedInternalHeaders, resolveTenantIdFromRequest } from '@aquaculture/backend-common/http';
import { Injectable, Logger, BadGatewayException, GatewayTimeoutException, BadRequestException, NotImplementedException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';

import { CircuitBreakerService } from './circuit-breaker.service';
import { LoadBalancerService, ServiceInstanceStats, LoadBalancerContext } from './load-balancer.service';

/**
 * Headers that should never be forwarded to upstream services
 * SECURITY: Prevents header injection attacks
 */
const BLOCKED_FORWARDED_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-original-url',
  'x-rewrite-url',
  'x-original-host',
  'forwarded',
  // Prevent cache poisoning
  'x-http-method-override',
  'x-method-override',
  // Identity and service-proof headers are minted by this gateway only.
  // ORPHAN-MEDIUM-319: client network identity is minted by extractHeaders
  // from the gateway's own trusted view (req.ip / inbound user-agent) —
  // an inbound copy is a forgery attempt.
  'x-client-ip',
  'x-client-user-agent',
  'x-user-payload',
  'x-user-id',
  'x-user-roles',
  'x-act-as-tenant',
  'x-verified-user-assertion',
  'x-service-identity',
  'x-service-timestamp',
  'x-service-signature',
  'x-service-sig-version',
  'x-service-key-id',
  'x-service-audience',
  'x-service-method',
  'x-service-path',
  'x-service-query-hash',
  'x-service-body-hash',
  'x-service-content-type',
  'x-service-assertion-hash',
  'x-service-nonce',
  'x-service-effective-tenant-id',
];

/**
 * Proxy request configuration.
 *
 * SECURITY (HIGH-003): `tenantId` is REQUIRED. Every caller must declare
 * the tenant context (or empty string for explicit non-tenant paths).
 * The value is bound into the HMAC signature attached to the outbound
 * request — no caller can silently inherit a missing/spoofed tenant.
 */
export interface ProxyRequestConfig {
  serviceName: string;
  path: string;
  /** Tenant UUID bound into the HMAC. Empty string for non-tenant paths. */
  tenantId: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  followRedirects?: boolean;
  preserveHost?: boolean;
  stripPrefix?: string;
  addPrefix?: string;
  transformRequest?: (req: ProxyRequest) => ProxyRequest;
  transformResponse?: (res: ProxyResponse) => ProxyResponse;
}

/**
 * Proxy request object
 */
export interface ProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Proxy response object
 */
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  responseTime: number;
}

/**
 * Service configuration for proxying
 */
export interface ServiceProxyConfig {
  name: string;
  baseUrl?: string;
  timeout: number;
  retries: number;
  retryDelay: number;
  retryableStatuses: number[];
  stripPrefix?: string;
  addPrefix?: string;
  headers?: Record<string, string>;
  preserveHost?: boolean;
  followRedirects?: boolean;
}

/**
 * Retry context
 */
interface RetryContext {
  attempt: number;
  maxAttempts: number;
  lastError?: Error;
  lastStatusCode?: number;
}

/**
 * Service Proxy Service
 * Handles all upstream service communication
 *
 * SECURITY:
 * - Validates hostnames against allowlist (registered services only)
 * - Filters dangerous headers (X-Forwarded-*, X-Original-URL, etc.)
 * - Validates paths to prevent traversal attacks
 * - Only proxies to pre-registered internal services
 */
@Injectable()
export class ServiceProxyService {
  private readonly logger = new Logger(ServiceProxyService.name);
  private readonly serviceConfigs = new Map<string, ServiceProxyConfig>();
  private readonly defaultConfig: Omit<ServiceProxyConfig, 'name'>;

  // Private IP ranges for SSRF protection
  private readonly privateIpPatterns = [
    /^127\./,                    // Loopback
    /^10\./,                     // Private Class A
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
    /^192\.168\./,               // Private Class C
    /^169\.254\./,               // Link-local
    /^0\./,                      // Current network
    /^::1$/,                     // IPv6 loopback
    /^fc00:/i,                   // IPv6 unique local
    /^fe80:/i,                   // IPv6 link-local
    /^localhost$/i,
    /^.*\.local$/i,
    /^.*\.internal$/i,
  ];

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(CircuitBreakerService) private readonly circuitBreaker: CircuitBreakerService,
    @Inject(LoadBalancerService) private readonly loadBalancer: LoadBalancerService,
  ) {
    this.defaultConfig = {
      timeout: this.configService.get<number>('PROXY_TIMEOUT', 30000),
      retries: this.configService.get<number>('PROXY_RETRIES', 3),
      retryDelay: this.configService.get<number>('PROXY_RETRY_DELAY', 100),
      retryableStatuses: [502, 503, 504],
      preserveHost: false,
      followRedirects: false, // SECURITY: Disable redirect following by default to prevent SSRF
    };

    this.loadServiceConfigs();
  }

  /**
   * SECURITY: Validate that a service name is registered
   * Prevents arbitrary service proxying
   */
  private isRegisteredService(serviceName: string): boolean {
    return this.serviceConfigs.has(serviceName);
  }

  /**
   * SECURITY: Validate path to prevent traversal attacks
   */
  private validatePath(path: string): void {
    // Block path traversal
    if (path.includes('..') || path.includes('%2e%2e') || path.includes('%252e')) {
      throw new BadRequestException('Invalid path: traversal not allowed');
    }

    // Block null bytes
    if (path.includes('\0') || path.includes('%00')) {
      throw new BadRequestException('Invalid path: null bytes not allowed');
    }

    // Block potentially dangerous protocols
    if (/^[a-z]+:/i.test(path) && !path.startsWith('/')) {
      throw new BadRequestException('Invalid path: absolute URLs not allowed');
    }
  }

  /**
   * SECURITY: Check if host is internal/private
   * This is a secondary check - primary protection is service allowlist
   */
  private isPrivateHost(host: string): boolean {
    // Remove port if present
    const hostOnly = host.split(':')[0] ?? host;

    for (const pattern of this.privateIpPatterns) {
      if (pattern.test(hostOnly)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Proxy an HTTP request
   * SECURITY: Validates service is registered and path is safe
   */
  async proxy(config: ProxyRequestConfig): Promise<ProxyResponse> {
    // SECURITY: Only allow proxying to registered services
    if (!this.isRegisteredService(config.serviceName)) {
      this.logger.warn(`SECURITY: Attempted proxy to unregistered service: ${config.serviceName}`);
      throw new BadRequestException(`Unknown service: ${config.serviceName}`);
    }

    // SECURITY: Validate path
    this.validatePath(config.path);

    const serviceConfig = this.getServiceConfig(config.serviceName);
    const context = this.buildLoadBalancerContext(config);

    return this.circuitBreaker.execute(
      config.serviceName,
      async () => {
        const instance = this.loadBalancer.getNextInstance(config.serviceName, context);

        if (!instance) {
          throw new BadGatewayException(`No available instances for service: ${config.serviceName}`);
        }

        // SECURITY: Secondary check - verify instance is not pointing to private/internal IPs
        // This protects against misconfigured load balancer returning rogue instances
        if (this.isPrivateHost(instance.host)) {
          this.logger.debug(`Proxying to internal service ${instance.host} (registered service: ${config.serviceName})`);
        }

        return this.executeProxyRequest(config, serviceConfig, instance);
      },
      {
        fallback: (error) => {
          this.logger.error(`Proxy failed for ${config.serviceName}`, {
            error: error.message,
            path: config.path,
          });
          throw new BadGatewayException({
            message: `Service unavailable: ${config.serviceName}`,
            // SECURITY: Don't expose internal error details to client
          });
        },
      },
    );
  }

  /**
   * Proxy an Express request directly
   */
  async proxyRequest(
    req: Request,
    res: Response,
    serviceName: string,
    options?: Partial<ProxyRequestConfig>,
  ): Promise<void> {
    const config: ProxyRequestConfig = {
      serviceName,
      path: req.path,
      // SECURITY (HIGH-003): bind the resolved tenant UUID into the proxy
      // contract so executeProxyRequest's HMAC signs the same tenant the
      // forwarded headers carry — tampering with x-tenant-id mid-flight
      // fails downstream verification.
      // SSoT: prefer the gateway-resolved effective tenant (validated act-as for
      // SUPER_ADMIN) so the wire x-tenant-id matches the signed assertion's
      // effectiveTenantId — otherwise the subgraph cross-check rejects act-as.
      tenantId:
        (req as Request & { effectiveTenantId?: string }).effectiveTenantId ??
        resolveTenantIdFromRequest(req),
      method: req.method,
      headers: this.attachVerifiedAssertion(this.extractHeaders(req), req),
      body: req.body,
      query: req.query as Record<string, string>,
      ...options,
    };

    try {
      const response = await this.proxy(config);

      // Set response headers
      for (const [key, value] of Object.entries(response.headers)) {
        if (!this.isHopByHopHeader(key)) {
          res.setHeader(key, value);
        }
      }

      // Set status and send body
      res.status(response.status);

      if (response.body !== null && response.body !== undefined) {
        if (typeof response.body === 'object') {
          res.json(response.body);
        } else {
          res.send(response.body);
        }
      } else {
        res.end();
      }
    } catch (error) {
      this.handleProxyError(res, error as Error);
    }
  }

  /**
   * Proxy WebSocket connection
   */
  proxyWebSocket(
    _req: Request,
    _socket: unknown,
    _head: Buffer,
    serviceName: string,
  ): void {
    // WebSocket proxying requires a dedicated library like 'ws' or 'http-proxy'.
    // Callers must not silently assume success.
    throw new NotImplementedException(
      `WebSocket proxying to ${serviceName} is not yet implemented`,
    );
  }

  /**
   * Proxy Server-Sent Events
   */
  async proxySSE(
    req: Request,
    res: Response,
    serviceName: string,
  ): Promise<void> {
    const instance = this.loadBalancer.getNextInstance(serviceName);

    if (!instance) {
      throw new BadGatewayException(`No available instances for SSE: ${serviceName}`);
    }

    const targetUrl = this.buildTargetUrl(instance, req.path, req.query as Record<string, string>);

    try {
      const controller = new AbortController();
      const timeout = this.getServiceConfig(serviceName).timeout;
      const sseIdleTimeout = timeout * 2; // SSE idle timeout is 2x the regular timeout

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Handle client disconnect
      req.on('close', () => {
        controller.abort();
      });

      // SECURITY (HIGH-003): sign the SSE proxy request with HMAC + tenant
      // binding so the downstream subgraph guard rejects any forged
      // x-tenant-id header tampered with in flight.
      const forwardedSseHeaders = this.attachVerifiedAssertion(this.extractHeaders(req), req);
      const sseHeaders: Record<string, string> = {
        ...forwardedSseHeaders,
        ...buildSignedInternalHeaders({
          serviceName: 'gateway-api',
          // SSoT: same effective-tenant precedence as the assertion (see above).
          tenantId:
            (req as Request & { effectiveTenantId?: string }).effectiveTenantId ??
            resolveTenantIdFromRequest(req),
          method: req.method,
          path: req.path,
          query: new URL(targetUrl).search,
          contentType: '',
          assertionHash: this.assertionHash(forwardedSseHeaders),
          audience: serviceName,
          body: '',
        }),
      };

      // CIRCUIT-MEDIUM-002 cure: route the connection-establishment
      // fetch through the breaker. Sibling `proxy()` (line 222) does
      // the same; SSE was the missing case. Only the initial fetch
      // is wrapped — once the response stream is open, breaker
      // semantics don't apply (you can't trip a breaker mid-stream;
      // the SSE idle timeout below handles long-lived-connection
      // health). The breaker protects against repeated 5xx /
      // connect-timeout failures from a chronically-down upstream
      // exhausting the gateway's connection pool.
      const response = await this.circuitBreaker.execute(
        serviceName,
        () =>
          fetch(targetUrl, {
            method: 'GET',
            headers: sseHeaders,
            signal: controller.signal,
          }),
      );

      if (!response.ok) {
        throw new BadGatewayException(`SSE upstream error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new BadGatewayException('No response body for SSE');
      }

      // Stream the response with idle timeout handling
      const decoder = new TextDecoder();
      let done = false;
      let lastActivityTime = Date.now();

      // SSE idle timeout checker - terminates connection if no data received
      const idleTimeoutChecker = setInterval(() => {
        const idleTime = Date.now() - lastActivityTime;
        if (idleTime > sseIdleTimeout) {
          this.logger.warn(`SSE connection idle for ${idleTime}ms, terminating`, {
            service: serviceName,
            timeout: sseIdleTimeout,
          });
          clearInterval(idleTimeoutChecker);
          controller.abort();
        }
      }, Math.min(sseIdleTimeout / 2, 30000)); // Check at half the timeout interval, max 30s

      try {
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (!done && result.value) {
            lastActivityTime = Date.now(); // Reset idle timer on data received
            const chunk = decoder.decode(result.value, { stream: true });
            res.write(chunk);
          }
        }
      } finally {
        clearInterval(idleTimeoutChecker);
      }

      res.end();
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.logger.error('SSE proxy error', {
          error: (error as Error).message,
          service: serviceName,
        });
        throw error;
      }
    }
  }

  /**
   * Register a service configuration
   */
  registerService(config: ServiceProxyConfig): void {
    this.serviceConfigs.set(config.name, config);
    this.logger.log(`Service proxy registered: ${config.name}`);
  }

  /**
   * Get registered services
   */
  getRegisteredServices(): string[] {
    return Array.from(this.serviceConfigs.keys());
  }

  // ============ Private Methods ============

  private async executeProxyRequest(
    config: ProxyRequestConfig,
    serviceConfig: ServiceProxyConfig,
    instance: ServiceInstanceStats,
  ): Promise<ProxyResponse> {
    const retryContext: RetryContext = {
      attempt: 0,
      maxAttempts: config.retries ?? serviceConfig.retries,
    };

    while (retryContext.attempt < retryContext.maxAttempts) {
      try {
        const response = await this.makeRequest(config, serviceConfig, instance);

        // Check if we should retry based on status
        if (
          serviceConfig.retryableStatuses.includes(response.status) &&
          retryContext.attempt < retryContext.maxAttempts
        ) {
          retryContext.attempt++;
          retryContext.lastStatusCode = response.status;
          await this.delay(this.calculateRetryDelay(retryContext, serviceConfig.retryDelay));
          continue;
        }

        // Record success with load balancer
        this.loadBalancer.recordRequestEnd(
          config.serviceName,
          instance.id,
          response.status < 500,
          response.responseTime,
        );

        return response;
      } catch (error) {
        retryContext.attempt++;
        retryContext.lastError = error as Error;

        if (retryContext.attempt > retryContext.maxAttempts) {
          // Record failure with load balancer
          this.loadBalancer.recordRequestEnd(config.serviceName, instance.id, false, 0);
          throw error;
        }

        await this.delay(this.calculateRetryDelay(retryContext, serviceConfig.retryDelay));
      }
    }

    throw new GatewayTimeoutException('Max retries exceeded');
  }

  private async makeRequest(
    config: ProxyRequestConfig,
    serviceConfig: ServiceProxyConfig,
    instance: ServiceInstanceStats,
  ): Promise<ProxyResponse> {
    const startTime = Date.now();

    // Build target URL
    let path = config.path;

    // Strip prefix if configured
    if (config.stripPrefix || serviceConfig.stripPrefix) {
      const prefix = config.stripPrefix || serviceConfig.stripPrefix;
      if (prefix && path.startsWith(prefix)) {
        path = path.substring(prefix.length) || '/';
      }
    }

    // Add prefix if configured
    if (config.addPrefix || serviceConfig.addPrefix) {
      path = (config.addPrefix || serviceConfig.addPrefix) + path;
    }

    const targetUrl = this.buildTargetUrl(instance, path, config.query);

    // Build headers
    const rawHeaders: Record<string, string> = {
      ...serviceConfig.headers,
      ...config.headers,
    };

    // Preserve or override host header
    if (!serviceConfig.preserveHost) {
      rawHeaders['host'] = `${instance.host}:${instance.port}`;
    }

    // Remove hop-by-hop headers by filtering
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).filter(([key]) => !this.isHopByHopHeader(key)),
    );

    // Build request object
    let proxyRequest: ProxyRequest = {
      url: targetUrl,
      method: config.method || 'GET',
      headers,
      body: config.body,
    };

    // Apply request transformation if provided
    if (config.transformRequest) {
      proxyRequest = config.transformRequest(proxyRequest);
    }

    // Record request start
    this.loadBalancer.recordRequestStart(config.serviceName, instance.id);

    // Make the request
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout || serviceConfig.timeout);

    try {
      // SECURITY (HIGH-003): overlay HMAC + tenant-bound identity headers
      // on top of caller-supplied headers. signedFetch-style merge: the
      // X-Service-* + X-Tenant-ID values come from buildSignedInternalHeaders
      // and override any pre-existing keys so the wire matches the signature.
      const upstreamUrl = new URL(proxyRequest.url);
      const requestContentType = this.headerValue(proxyRequest.headers, 'content-type') ?? '';
      const bodyForSigning =
        proxyRequest.body === undefined || proxyRequest.body === null
          ? ''
          : typeof proxyRequest.body === 'string'
            ? proxyRequest.body
            : JSON.stringify(proxyRequest.body);
      const signedHeaders = buildSignedInternalHeaders({
        serviceName: 'gateway-api',
        tenantId: config.tenantId,
        method: proxyRequest.method,
        path: upstreamUrl.pathname,
        query: upstreamUrl.search,
        contentType: requestContentType,
        assertionHash: this.assertionHash(proxyRequest.headers),
        audience: config.serviceName,
        body: bodyForSigning,
      });
      const fetchOptions: RequestInit = {
        method: proxyRequest.method,
        headers: { ...proxyRequest.headers, ...signedHeaders },
        signal: controller.signal,
        redirect: serviceConfig.followRedirects ? 'follow' : 'manual',
      };

      // Add body for methods that support it
      if (proxyRequest.body && ['POST', 'PUT', 'PATCH'].includes(proxyRequest.method)) {
        fetchOptions.body =
          typeof proxyRequest.body === 'string'
            ? proxyRequest.body
            : JSON.stringify(proxyRequest.body);
      }

      const response = await fetch(proxyRequest.url, fetchOptions);
      clearTimeout(timeout);

      const responseTime = Date.now() - startTime;

      // Parse response body
      let body: unknown;
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        body = await response.json();
      } else if (contentType.includes('text/')) {
        body = await response.text();
      } else {
        body = await response.arrayBuffer();
      }

      // Build response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let proxyResponse: ProxyResponse = {
        status: response.status,
        headers: responseHeaders,
        body,
        responseTime,
      };

      // Apply response transformation if provided
      if (config.transformResponse) {
        proxyResponse = config.transformResponse(proxyResponse);
      }

      return proxyResponse;
    } catch (error) {
      clearTimeout(timeout);

      if ((error as Error).name === 'AbortError') {
        throw new GatewayTimeoutException(`Request timeout after ${config.timeout || serviceConfig.timeout}ms`);
      }

      // SECURITY: Do not expose upstream error messages to client
      throw new BadGatewayException('Upstream service error');
    }
  }

  private buildTargetUrl(
    instance: ServiceInstanceStats,
    path: string,
    query?: Record<string, string>,
  ): string {
    let url = `http://${instance.host}:${instance.port}${path}`;

    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }

    return url;
  }

  /**
   * Extract and sanitize headers from incoming request
   * SECURITY: Filters dangerous headers to prevent injection attacks
   */
  private extractHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();

      // SECURITY: Skip blocked headers that could be used for attacks
      if (BLOCKED_FORWARDED_HEADERS.includes(lowerKey)) {
        continue;
      }

      // SECURITY: Skip hop-by-hop headers
      if (this.isHopByHopHeader(key)) {
        continue;
      }

      // SECURITY: Validate header values don't contain CRLF (header injection)
      if (typeof value === 'string') {
        if (value.includes('\r') || value.includes('\n')) {
          this.logger.warn(`SECURITY: Blocked header with CRLF: ${key}`);
          continue;
        }
        headers[key] = value;
      } else if (Array.isArray(value)) {
        const safeValues = value.filter(v => !v.includes('\r') && !v.includes('\n'));
        if (safeValues.length > 0) {
          headers[key] = safeValues.join(', ');
        }
      }
    }

    // ORPHAN-MEDIUM-319: mint the end-client network identity the gateway
    // resolved itself (req.ip honours TRUST_PROXY=1 behind nginx; the inbound
    // user-agent is the browser's). Inbound copies were dropped by the
    // BLOCKED_FORWARDED_HEADERS filter above, so these assignments cannot be
    // attacker-controlled. Subgraphs trust them only behind a verified
    // gateway service identity (resolveClientNetworkContext).
    if (req.ip) {
      headers['x-client-ip'] = req.ip;
    }
    const inboundUserAgent = req.headers['user-agent'];
    if (typeof inboundUserAgent === 'string' && inboundUserAgent.length > 0) {
      headers['x-client-user-agent'] = inboundUserAgent;
    }

    return headers;
  }


  private attachVerifiedAssertion(headers: Record<string, string>, req: Request): Record<string, string> {
    const user = (req as Request & {
      user?: {
        sub?: string;
        tenantId?: string;
        roles?: string[];
        email?: string;
        mfaVerified?: boolean;
        // SEC-HIGH-051 / SEC-HIGH-052: the object-level authorization claims the
        // REST-proxy path must also fold into the verified assertion.
        assignedSiteIds?: string[];
        mobileFeatures?: string[];
      };
    }).user;
    // SSoT: the gateway-resolved effective tenant (validated act-as for
    // SUPER_ADMIN; JWT tenantId for regular users), set by EffectiveTenantMiddleware.
    const effectiveTenantId = (req as Request & { effectiveTenantId?: string }).effectiveTenantId;

    if (!user?.sub) {
      return headers;
    }

    return {
      ...headers,
      'x-verified-user-assertion': buildGatewayVerifiedUserAssertion({
        subject: user.sub,
        tenantId: user.tenantId,
        effectiveTenantId: effectiveTenantId ?? user.tenantId,
        roles: user.roles ?? [],
        email: user.email,
        mfaVerified: user.mfaVerified,
        // SEC-HIGH-051 / SEC-HIGH-052: thread the site + mobile-feature claims
        // into the HMAC-bound assertion on the REST-proxy path too, identical to
        // the federation/authenticated-data-source build site. Without this the
        // claims are dropped here and a legitimately-assigned user is wrongly
        // denied on any farm/hr mutation routed through the REST proxy.
        assignedSiteIds: user.assignedSiteIds,
        mobileFeatures: user.mobileFeatures,
        // ORPHAN-MEDIUM-319: bind the client network identity into the
        // HMAC-protected assertion on the REST-proxy path, identical to the
        // federation/authenticated-data-source build site.
        clientIp: req.ip ?? null,
        clientUserAgent:
          typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      }),
    };
  }

  private assertionHash(headers: Record<string, string>): string | undefined {
    const assertion = this.headerValue(headers, 'x-verified-user-assertion');
    return assertion ? createHash('sha256').update(assertion).digest('hex') : undefined;
  }

  private headerValue(headers: Record<string, string>, name: string): string | undefined {
    const lower = name.toLowerCase();
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lower);
    return key ? headers[key] : undefined;
  }

  private isHopByHopHeader(header: string): boolean {
    const hopByHopHeaders = [
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ];
    return hopByHopHeaders.includes(header.toLowerCase());
  }

  private handleProxyError(res: Response, error: Error): void {
    this.logger.error('Proxy error', { error: error.message });

    // SECURITY: Do not expose internal error details to the client.
    // Error messages and stack traces can reveal upstream service structure
    // (hostnames, ports, paths) useful for reconnaissance.
    if (error instanceof BadGatewayException) {
      res.status(502).json({
        statusCode: 502,
        message: 'Bad Gateway',
      });
    } else if (error instanceof GatewayTimeoutException) {
      res.status(504).json({
        statusCode: 504,
        message: 'Gateway Timeout',
      });
    } else {
      res.status(500).json({
        statusCode: 500,
        message: 'Internal Server Error',
      });
    }
  }

  private getServiceConfig(serviceName: string): ServiceProxyConfig {
    const config = this.serviceConfigs.get(serviceName);
    if (config) {
      return config;
    }

    // Return default config with service name
    return {
      name: serviceName,
      ...this.defaultConfig,
    };
  }

  private buildLoadBalancerContext(config: ProxyRequestConfig): LoadBalancerContext {
    return {
      headers: config.headers,
    };
  }

  private calculateRetryDelay(context: RetryContext, baseDelay: number): number {
    // Exponential backoff with jitter
    const exponentialDelay = baseDelay * Math.pow(2, context.attempt - 1);
    const jitter = Math.random() * 100;
    return exponentialDelay + jitter;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private loadServiceConfigs(): void {
    // Load from environment/config
    const authService: ServiceProxyConfig = {
      name: 'auth-service',
      timeout: 10000,
      retries: 3,
      retryDelay: 100,
      retryableStatuses: [502, 503, 504],
      stripPrefix: '/api/auth',
      addPrefix: '/api/v1',
    };

    const farmService: ServiceProxyConfig = {
      name: 'farm-service',
      timeout: 30000,
      retries: 2,
      retryDelay: 200,
      retryableStatuses: [502, 503, 504],
      stripPrefix: '/api/farms',
    };

    const sensorService: ServiceProxyConfig = {
      name: 'sensor-service',
      timeout: 15000,
      retries: 3,
      retryDelay: 100,
      retryableStatuses: [502, 503, 504],
      stripPrefix: '/api/sensors',
    };

    const alertService: ServiceProxyConfig = {
      name: 'alert-engine',
      timeout: 20000,
      retries: 2,
      retryDelay: 150,
      retryableStatuses: [502, 503, 504],
      stripPrefix: '/api/alerts',
    };

    const billingService: ServiceProxyConfig = {
      name: 'billing-service',
      timeout: 30000,
      retries: 3,
      retryDelay: 200,
      retryableStatuses: [502, 503, 504],
      stripPrefix: '/api/billing',
    };

    const adminApiService: ServiceProxyConfig = {
      name: 'admin-api-service',
      timeout: 30000,
      retries: 2,
      retryDelay: 200,
      retryableStatuses: [502, 503, 504],
      stripPrefix: '/api',
    };

    this.registerService(authService);
    this.registerService(farmService);
    this.registerService(sensorService);
    this.registerService(alertService);
    this.registerService(billingService);
    this.registerService(adminApiService);
  }
}

/**
 * Request transformer helper
 */
export function createRequestTransformer(
  transformations: Array<(req: ProxyRequest) => ProxyRequest>,
): (req: ProxyRequest) => ProxyRequest {
  return (req: ProxyRequest) => {
    let result = req;
    for (const transform of transformations) {
      result = transform(result);
    }
    return result;
  };
}

/**
 * Response transformer helper
 */
export function createResponseTransformer(
  transformations: Array<(res: ProxyResponse) => ProxyResponse>,
): (res: ProxyResponse) => ProxyResponse {
  return (res: ProxyResponse) => {
    let result = res;
    for (const transform of transformations) {
      result = transform(result);
    }
    return result;
  };
}

/**
 * Add header transformation
 */
export function addHeader(name: string, value: string): (req: ProxyRequest) => ProxyRequest {
  return (req: ProxyRequest) => ({
    ...req,
    headers: { ...req.headers, [name]: value },
  });
}

/**
 * Remove header transformation
 */
export function removeHeader(name: string): (req: ProxyRequest) => ProxyRequest {
  return (req: ProxyRequest) => {
    const { [name]: _, ...headers } = req.headers;
    return { ...req, headers };
  };
}
