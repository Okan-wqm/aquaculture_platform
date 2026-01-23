/**
 * Service Proxy Service
 *
 * Proxies requests to upstream microservices.
 * Handles request/response transformation, retries, and error handling.
 * Supports HTTP, WebSocket, and SSE proxying.
 */

import { Injectable, Logger, BadGatewayException, GatewayTimeoutException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';

import { CircuitBreakerService } from './circuit-breaker.service';
import { LoadBalancerService, ServiceInstanceStats, LoadBalancerContext } from './load-balancer.service';

/**
 * Proxy request configuration
 */
export interface ProxyRequestConfig {
  serviceName: string;
  path: string;
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
 */
@Injectable()
export class ServiceProxyService {
  private readonly logger = new Logger(ServiceProxyService.name);
  private readonly serviceConfigs = new Map<string, ServiceProxyConfig>();
  private readonly defaultConfig: Omit<ServiceProxyConfig, 'name'>;

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly loadBalancer: LoadBalancerService,
  ) {
    this.defaultConfig = {
      timeout: this.configService.get<number>('PROXY_TIMEOUT', 30000),
      retries: this.configService.get<number>('PROXY_RETRIES', 3),
      retryDelay: this.configService.get<number>('PROXY_RETRY_DELAY', 100),
      retryableStatuses: [502, 503, 504],
      preserveHost: false,
      followRedirects: true,
    };

    this.loadServiceConfigs();
  }

  /**
   * Proxy an HTTP request
   */
  async proxy(config: ProxyRequestConfig): Promise<ProxyResponse> {
    const serviceConfig = this.getServiceConfig(config.serviceName);
    const context = this.buildLoadBalancerContext(config);

    return this.circuitBreaker.execute(
      config.serviceName,
      async () => {
        const instance = this.loadBalancer.getNextInstance(config.serviceName, context);

        if (!instance) {
          throw new BadGatewayException(`No available instances for service: ${config.serviceName}`);
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
            originalError: error.message,
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
      method: req.method,
      headers: this.extractHeaders(req),
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
    req: Request,
    _socket: unknown,
    _head: Buffer,
    serviceName: string,
  ): void {
    const instance = this.loadBalancer.getNextInstance(serviceName);

    if (!instance) {
      this.logger.error(`No available instances for WebSocket: ${serviceName}`);
      return;
    }

    const targetUrl = `ws://${instance.host}:${instance.port}${req.path}`;

    this.logger.debug(`Proxying WebSocket to ${targetUrl}`);

    // WebSocket proxy implementation would go here
    // This requires a WebSocket library like 'ws' or 'http-proxy'
    this.logger.warn('WebSocket proxying not yet implemented');
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

      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: this.extractHeaders(req),
        signal: controller.signal,
      });

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

    while (retryContext.attempt <= retryContext.maxAttempts) {
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
      const fetchOptions: RequestInit = {
        method: proxyRequest.method,
        headers: proxyRequest.headers,
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

      throw new BadGatewayException({
        message: 'Upstream service error',
        error: (error as Error).message,
      });
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

  private extractHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    return headers;
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

    if (error instanceof BadGatewayException) {
      res.status(502).json({
        statusCode: 502,
        message: error.message,
        error: 'Bad Gateway',
      });
    } else if (error instanceof GatewayTimeoutException) {
      res.status(504).json({
        statusCode: 504,
        message: error.message,
        error: 'Gateway Timeout',
      });
    } else {
      res.status(500).json({
        statusCode: 500,
        message: 'Internal Server Error',
        error: error.message,
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
