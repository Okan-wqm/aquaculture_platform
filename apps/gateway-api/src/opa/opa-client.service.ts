/**
 * OPA Client Service
 *
 * HTTP client for communicating with Open Policy Agent server.
 * Handles policy evaluation requests, data synchronization, and health checks.
 * Implements connection pooling, retry logic, and circuit breaker patterns.
 */

import { EventEmitter } from 'events';

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * OPA evaluation input
 */
export interface OpaInput {
  input: Record<string, unknown>;
}

/**
 * OPA evaluation result
 */
export interface OpaResult {
  result: unknown;
  decision_id?: string;
  metrics?: OpaMetrics;
}

/**
 * OPA metrics from evaluation
 */
export interface OpaMetrics {
  timer_rego_query_compile_ns?: number;
  timer_rego_query_eval_ns?: number;
  timer_server_handler_ns?: number;
}

/**
 * OPA policy info
 */
export interface OpaPolicy {
  id: string;
  raw: string;
  ast?: Record<string, unknown>;
}

/**
 * OPA data document
 */
export interface OpaData {
  path: string;
  data: unknown;
}

/**
 * OPA health status
 */
export interface OpaHealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version?: string;
  uptime?: number;
  bundlesLoaded?: boolean;
  pluginsStatus?: Record<string, string>;
  lastCheck: Date;
  responseTime?: number;
}

/**
 * Circuit breaker state
 */
enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/**
 * OPA Client Configuration
 */
export interface OpaClientConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetTimeout: number;
  enableMetrics: boolean;
  enableDecisionLogs: boolean;
}

/**
 * OPA Client Service
 * Manages communication with OPA server
 */
@Injectable()
export class OpaClientService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpaClientService.name);
  private readonly config: OpaClientConfig;

  // Circuit breaker state
  private circuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private successCount = 0;

  // Health check interval
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  private currentHealth: OpaHealthStatus = {
    status: 'unhealthy',
    lastCheck: new Date(),
  };

  // Decision cache for performance
  private readonly decisionCache = new Map<
    string,
    { result: OpaResult; expiry: number }
  >();
  private readonly cacheTtl: number;

  constructor(private readonly configService: ConfigService) {
    super();

    this.config = {
      baseUrl: this.configService.get<string>('OPA_URL', 'http://localhost:8181'),
      timeout: this.configService.get<number>('OPA_TIMEOUT', 5000),
      retryAttempts: this.configService.get<number>('OPA_RETRY_ATTEMPTS', 3),
      retryDelay: this.configService.get<number>('OPA_RETRY_DELAY', 100),
      circuitBreakerThreshold: this.configService.get<number>('OPA_CIRCUIT_THRESHOLD', 5),
      circuitBreakerResetTimeout: this.configService.get<number>('OPA_CIRCUIT_RESET', 30000),
      enableMetrics: this.configService.get<boolean>('OPA_ENABLE_METRICS', true),
      enableDecisionLogs: this.configService.get<boolean>('OPA_ENABLE_DECISION_LOGS', false),
    };

    this.cacheTtl = this.configService.get<number>('OPA_CACHE_TTL', 60000);
  }

  async onModuleInit(): Promise<void> {
    // Initial health check
    await this.checkHealth();

    // Start periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth().catch((err: unknown) => {
        this.logger.warn('Health check failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }, 30000);

    this.logger.log('OPA Client initialized', { baseUrl: this.config.baseUrl });
  }

  onModuleDestroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }

  /**
   * Evaluate a policy
   */
  async evaluatePolicy(
    policyPath: string,
    input: Record<string, unknown>,
    options?: { useCache?: boolean; cacheKey?: string },
  ): Promise<OpaResult> {
    // Check circuit breaker
    if (!this.canExecute()) {
      throw new Error('OPA circuit breaker is open');
    }

    // Check cache
    const cacheKey = options?.cacheKey || this.buildCacheKey(policyPath, input);
    if (options?.useCache !== false) {
      const cached = this.decisionCache.get(cacheKey);
      if (cached && cached.expiry > Date.now()) {
        return cached.result;
      }
    }

    const url = `${this.config.baseUrl}/v1/data/${policyPath}`;
    const body: OpaInput = { input };

    try {
      const result = await this.executeWithRetry<OpaResult>(async () => {
        const response = await this.httpPost<OpaResult>(url, body);
        return response;
      });

      // Cache the result
      this.decisionCache.set(cacheKey, {
        result,
        expiry: Date.now() + this.cacheTtl,
      });

      // Record success
      this.recordSuccess();

      // Emit decision event
      if (this.config.enableDecisionLogs) {
        this.emit('decision', { policyPath, input, result });
      }

      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Batch evaluate multiple policies
   */
  async evaluatePolicies(
    evaluations: Array<{ policyPath: string; input: Record<string, unknown> }>,
  ): Promise<OpaResult[]> {
    const results = await Promise.all(
      evaluations.map((e) => this.evaluatePolicy(e.policyPath, e.input)),
    );
    return results;
  }

  /**
   * Get policy document
   */
  async getPolicy(policyId: string): Promise<OpaPolicy | null> {
    const url = `${this.config.baseUrl}/v1/policies/${policyId}`;

    try {
      const response = await this.httpGet<{ result: OpaPolicy }>(url);
      return response.result;
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create or update policy
   */
  async upsertPolicy(policyId: string, policyContent: string): Promise<void> {
    const url = `${this.config.baseUrl}/v1/policies/${policyId}`;

    await this.httpPut(url, policyContent, {
      'Content-Type': 'text/plain',
    });

    this.logger.log('Policy upserted', { policyId });
  }

  /**
   * Delete policy
   */
  async deletePolicy(policyId: string): Promise<void> {
    const url = `${this.config.baseUrl}/v1/policies/${policyId}`;

    await this.httpDelete(url);

    this.logger.log('Policy deleted', { policyId });
  }

  /**
   * Get data document
   */
  async getData(dataPath: string): Promise<unknown> {
    const url = `${this.config.baseUrl}/v1/data/${dataPath}`;

    const response = await this.httpGet<{ result: unknown }>(url);
    return response.result;
  }

  /**
   * Create or update data document
   */
  async upsertData(dataPath: string, data: unknown): Promise<void> {
    const url = `${this.config.baseUrl}/v1/data/${dataPath}`;

    await this.httpPut(url, JSON.stringify(data), {
      'Content-Type': 'application/json',
    });

    this.logger.debug('Data upserted', { dataPath });
  }

  /**
   * Delete data document
   */
  async deleteData(dataPath: string): Promise<void> {
    const url = `${this.config.baseUrl}/v1/data/${dataPath}`;

    await this.httpDelete(url);

    this.logger.debug('Data deleted', { dataPath });
  }

  /**
   * Check OPA server health
   */
  async checkHealth(): Promise<OpaHealthStatus> {
    const startTime = Date.now();

    try {
      const response = await this.httpGet<{
        result?: unknown;
        plugins?: Record<string, { state: string }>;
      }>(`${this.config.baseUrl}/health?bundles=true&plugins=true`);

      const responseTime = Date.now() - startTime;

      // Get version info
      let version: string | undefined;
      try {
        const versionResponse = await this.httpGet<{ version: string }>(
          `${this.config.baseUrl}/v1/status`,
        );
        version = versionResponse.version;
      } catch {
        // Version endpoint might not be available
      }

      const pluginsStatus: Record<string, string> = {};
      if (response.plugins) {
        for (const [name, info] of Object.entries(response.plugins)) {
          pluginsStatus[name] = info.state;
        }
      }

      this.currentHealth = {
        status: 'healthy',
        version,
        bundlesLoaded: true,
        pluginsStatus,
        lastCheck: new Date(),
        responseTime,
      };

      this.emit('healthChange', this.currentHealth);
      return this.currentHealth;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.currentHealth = {
        status: 'unhealthy',
        lastCheck: new Date(),
        responseTime,
      };

      this.emit('healthChange', this.currentHealth);
      this.logger.warn('OPA health check failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return this.currentHealth;
    }
  }

  /**
   * Get current health status
   */
  getHealthStatus(): OpaHealthStatus {
    return this.currentHealth;
  }

  /**
   * Clear decision cache
   */
  clearCache(): void {
    this.decisionCache.clear();
    this.logger.debug('Decision cache cleared');
  }

  /**
   * Invalidate cache entries for a policy path
   */
  invalidateCache(policyPathPrefix: string): void {
    for (const key of this.decisionCache.keys()) {
      if (key.startsWith(policyPathPrefix)) {
        this.decisionCache.delete(key);
      }
    }
    this.logger.debug('Cache invalidated', { prefix: policyPathPrefix });
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  /**
   * Check if request can be executed (circuit breaker)
   */
  private canExecute(): boolean {
    switch (this.circuitState) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if reset timeout has passed
        if (Date.now() - this.lastFailureTime >= this.config.circuitBreakerResetTimeout) {
          this.circuitState = CircuitState.HALF_OPEN;
          this.successCount = 0;
          this.logger.log('Circuit breaker half-open');
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        return true;

      default:
        return true;
    }
  }

  /**
   * Record successful request
   */
  private recordSuccess(): void {
    if (this.circuitState === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= 3) {
        this.circuitState = CircuitState.CLOSED;
        this.failureCount = 0;
        this.logger.log('Circuit breaker closed');
        this.emit('circuitStateChange', this.circuitState);
      }
    }
  }

  /**
   * Record failed request
   */
  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (
      this.circuitState === CircuitState.HALF_OPEN ||
      this.failureCount >= this.config.circuitBreakerThreshold
    ) {
      this.circuitState = CircuitState.OPEN;
      this.logger.warn('Circuit breaker opened', { failureCount: this.failureCount });
      this.emit('circuitStateChange', this.circuitState);
    }
  }

  /**
   * Execute with retry logic
   */
  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on 4xx errors
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500) {
          throw error;
        }

        if (attempt < this.config.retryAttempts - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Build cache key for decision
   */
  private buildCacheKey(policyPath: string, input: Record<string, unknown>): string {
    const inputHash = this.hashObject(input);
    return `${policyPath}:${inputHash}`;
  }

  /**
   * Simple hash function for objects
   */
  private hashObject(obj: Record<string, unknown>): string {
    const str = JSON.stringify(obj, Object.keys(obj).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * HTTP GET request
   */
  private async httpGet<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        (error as Error & { status: number }).status = response.status;
        throw error;
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * HTTP POST request
   */
  private async httpPost<T>(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        (error as Error & { status: number }).status = response.status;
        throw error;
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * HTTP PUT request
   */
  private async httpPut(
    url: string,
    body: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        (error as Error & { status: number }).status = response.status;
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * HTTP DELETE request
   */
  private async httpDelete(url: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        signal: controller.signal,
      });

      if (!response.ok && response.status !== 404) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        (error as Error & { status: number }).status = response.status;
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
