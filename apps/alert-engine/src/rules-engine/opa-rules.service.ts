/**
 * OPA (Open Policy Agent) Rules Service
 *
 * Implements integration with Open Policy Agent for policy-as-code rule evaluation.
 * Supports Rego policies, policy bundles, and decision logging.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as http from 'http';
import * as https from 'https';

/**
 * OPA server configuration
 */
export interface OpaConfig {
  serverUrl: string;
  authToken?: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  enableDecisionLog: boolean;
}

/**
 * Policy definition
 */
export interface Policy {
  id: string;
  name: string;
  description?: string;
  path: string; // OPA policy path (e.g., "alerting/rules")
  regoCode?: string; // Inline Rego code
  version: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Policy input for evaluation
 */
export interface PolicyInput {
  [key: string]: unknown;
}

/**
 * Policy evaluation result
 */
export interface PolicyResult {
  policyId: string;
  policyPath: string;
  decision: unknown;
  allowed: boolean;
  reasons?: string[];
  metrics?: {
    evaluationTimeNs: number;
    compileTimeNs?: number;
  };
  decisionId?: string;
  timestamp: Date;
}

/**
 * Decision log entry
 */
export interface DecisionLogEntry {
  decisionId: string;
  policyPath: string;
  input: PolicyInput;
  result: PolicyResult;
  timestamp: Date;
  labels?: Record<string, string>;
}

/**
 * Policy bundle metadata
 */
export interface PolicyBundle {
  id: string;
  name: string;
  policies: Policy[];
  revision: string;
  createdAt: Date;
}

/**
 * OPA health status
 */
export interface OpaHealthStatus {
  isHealthy: boolean;
  serverUrl: string;
  lastCheck: Date;
  version?: string;
  plugins?: Record<string, unknown>;
  error?: string;
}

@Injectable()
export class OpaRulesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpaRulesService.name);

  private config: OpaConfig;
  private readonly policies = new Map<string, Policy>();
  private readonly decisionLog: DecisionLogEntry[] = [];
  private readonly maxDecisionLogSize = 10000;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastHealthStatus: OpaHealthStatus | null = null;

  // Metrics
  private metrics = {
    totalEvaluations: 0,
    successfulEvaluations: 0,
    failedEvaluations: 0,
    averageEvaluationTimeMs: 0,
    lastEvaluationTime: null as Date | null,
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.config = this.loadConfig();
  }

  async onModuleInit(): Promise<void> {
    // Check OPA server health
    await this.checkHealth();

    // Start periodic health checks
    this.healthCheckInterval = setInterval(
      () => this.checkHealth(),
      30000, // Check every 30 seconds
    );

    this.logger.log(`OpaRulesService initialized with server: ${this.config.serverUrl}`);
  }

  onModuleDestroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Load configuration from environment
   */
  private loadConfig(): OpaConfig {
    return {
      serverUrl: this.configService.get<string>('OPA_SERVER_URL', 'http://localhost:8181'),
      authToken: this.configService.get<string>('OPA_AUTH_TOKEN'),
      timeout: this.configService.get<number>('OPA_TIMEOUT', 5000),
      retryAttempts: this.configService.get<number>('OPA_RETRY_ATTEMPTS', 3),
      retryDelay: this.configService.get<number>('OPA_RETRY_DELAY', 1000),
      enableDecisionLog: this.configService.get<boolean>('OPA_ENABLE_DECISION_LOG', true),
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<OpaConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.log('OPA configuration updated');
  }

  /**
   * Register a policy
   */
  registerPolicy(policy: Policy): void {
    this.validatePolicy(policy);
    this.policies.set(policy.id, policy);
    this.logger.debug(`Registered policy: ${policy.name} (${policy.id})`);
  }

  /**
   * Unregister a policy
   */
  unregisterPolicy(policyId: string): boolean {
    const deleted = this.policies.delete(policyId);
    if (deleted) {
      this.logger.debug(`Unregistered policy: ${policyId}`);
    }
    return deleted;
  }

  /**
   * Get a policy by ID
   */
  getPolicy(policyId: string): Policy | undefined {
    return this.policies.get(policyId);
  }

  /**
   * Get all registered policies
   */
  getAllPolicies(): Policy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Evaluate a policy
   */
  async evaluate(
    policyIdOrPath: string,
    input: PolicyInput,
    options?: { unknowns?: string[]; metrics?: boolean },
  ): Promise<PolicyResult> {
    const startTime = Date.now();
    let policyPath = policyIdOrPath;

    // Check if this is a policy ID
    const policy = this.policies.get(policyIdOrPath);
    if (policy) {
      if (!policy.enabled) {
        throw new Error(`Policy ${policyIdOrPath} is disabled`);
      }
      policyPath = policy.path;
    }

    try {
      const result = await this.evaluateWithRetry(policyPath, input, options);

      // Update metrics
      this.updateMetrics(true, Date.now() - startTime);

      // Log decision
      if (this.config.enableDecisionLog) {
        this.logDecision(policyPath, input, result);
      }

      this.eventEmitter.emit('opa.policy.evaluated', {
        policyPath,
        result: result.allowed,
        evaluationTimeMs: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.updateMetrics(false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Evaluate with retry logic
   */
  private async evaluateWithRetry(
    policyPath: string,
    input: PolicyInput,
    options?: { unknowns?: string[]; metrics?: boolean },
  ): Promise<PolicyResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        return await this.executeEvaluation(policyPath, input, options);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `OPA evaluation attempt ${attempt + 1} failed: ${lastError.message}`,
        );

        if (attempt < this.config.retryAttempts) {
          await this.delay(this.config.retryDelay * Math.pow(2, attempt));
        }
      }
    }

    throw lastError || new Error('OPA evaluation failed');
  }

  /**
   * Execute the actual evaluation request
   */
  private async executeEvaluation(
    policyPath: string,
    input: PolicyInput,
    options?: { unknowns?: string[]; metrics?: boolean },
  ): Promise<PolicyResult> {
    const url = `${this.config.serverUrl}/v1/data/${policyPath}`;
    const requestBody = JSON.stringify({
      input,
      unknowns: options?.unknowns,
      metrics: options?.metrics,
    });

    const response = await this.httpRequest('POST', url, requestBody);
    const data = JSON.parse(response);

    // Extract result
    const decision = data.result;
    const allowed = this.determineAllowed(decision);
    const reasons = this.extractReasons(decision);

    return {
      policyId: this.findPolicyIdByPath(policyPath) || policyPath,
      policyPath,
      decision,
      allowed,
      reasons,
      metrics: data.metrics
        ? {
            evaluationTimeNs: data.metrics.timer_rego_query_eval_ns || 0,
            compileTimeNs: data.metrics.timer_rego_query_compile_ns,
          }
        : undefined,
      decisionId: data.decision_id,
      timestamp: new Date(),
    };
  }

  /**
   * Determine if decision indicates allowed
   */
  private determineAllowed(decision: unknown): boolean {
    if (typeof decision === 'boolean') {
      return decision;
    }
    if (typeof decision === 'object' && decision !== null) {
      const d = decision as Record<string, unknown>;
      if ('allow' in d) return Boolean(d.allow);
      if ('allowed' in d) return Boolean(d.allowed);
      if ('permit' in d) return Boolean(d.permit);
      if ('deny' in d) return !d.deny;
    }
    return Boolean(decision);
  }

  /**
   * Extract reasons from decision
   */
  private extractReasons(decision: unknown): string[] | undefined {
    if (typeof decision === 'object' && decision !== null) {
      const d = decision as Record<string, unknown>;
      if ('reasons' in d && Array.isArray(d.reasons)) {
        return d.reasons.map(String);
      }
      if ('violations' in d && Array.isArray(d.violations)) {
        return d.violations.map(String);
      }
      if ('errors' in d && Array.isArray(d.errors)) {
        return d.errors.map(String);
      }
    }
    return undefined;
  }

  /**
   * Find policy ID by path
   */
  private findPolicyIdByPath(path: string): string | undefined {
    for (const [id, policy] of this.policies) {
      if (policy.path === path) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Upload a policy to OPA
   */
  async uploadPolicy(policy: Policy): Promise<void> {
    if (!policy.regoCode) {
      throw new Error('Policy must have regoCode for upload');
    }

    const url = `${this.config.serverUrl}/v1/policies/${policy.path}`;

    await this.httpRequest('PUT', url, policy.regoCode, {
      'Content-Type': 'text/plain',
    });

    this.registerPolicy(policy);
    this.logger.log(`Uploaded policy to OPA: ${policy.path}`);
  }

  /**
   * Delete a policy from OPA
   */
  async deletePolicy(policyPath: string): Promise<void> {
    const url = `${this.config.serverUrl}/v1/policies/${policyPath}`;
    await this.httpRequest('DELETE', url, '');

    // Remove from local registry
    for (const [id, policy] of this.policies) {
      if (policy.path === policyPath) {
        this.policies.delete(id);
        break;
      }
    }

    this.logger.log(`Deleted policy from OPA: ${policyPath}`);
  }

  /**
   * Get a policy from OPA
   */
  async getOpaPolicy(policyPath: string): Promise<{ raw: string; ast?: unknown }> {
    const url = `${this.config.serverUrl}/v1/policies/${policyPath}`;
    const response = await this.httpRequest('GET', url, '');
    return JSON.parse(response);
  }

  /**
   * List all policies in OPA
   */
  async listOpaPolicies(): Promise<Array<{ id: string; raw: string; ast?: unknown }>> {
    const url = `${this.config.serverUrl}/v1/policies`;
    const response = await this.httpRequest('GET', url, '');
    const data = JSON.parse(response);
    return data.result || [];
  }

  /**
   * Check OPA server health
   */
  async checkHealth(): Promise<OpaHealthStatus> {
    try {
      const url = `${this.config.serverUrl}/health`;
      const response = await this.httpRequest('GET', url, '', {}, 5000);

      // Try to get version info
      let version: string | undefined;
      try {
        const infoUrl = `${this.config.serverUrl}/`;
        const infoResponse = await this.httpRequest('GET', infoUrl, '', {}, 2000);
        const info = JSON.parse(infoResponse);
        version = info.version;
      } catch {
        // Ignore version fetch errors
      }

      this.lastHealthStatus = {
        isHealthy: true,
        serverUrl: this.config.serverUrl,
        lastCheck: new Date(),
        version,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.lastHealthStatus = {
        isHealthy: false,
        serverUrl: this.config.serverUrl,
        lastCheck: new Date(),
        error: errorMessage,
      };

      this.eventEmitter.emit('opa.health.unhealthy', {
        serverUrl: this.config.serverUrl,
        error: errorMessage,
      });
    }

    return this.lastHealthStatus;
  }

  /**
   * Get last health status
   */
  getHealthStatus(): OpaHealthStatus | null {
    return this.lastHealthStatus;
  }

  /**
   * Log a decision
   */
  private logDecision(
    policyPath: string,
    input: PolicyInput,
    result: PolicyResult,
  ): void {
    const entry: DecisionLogEntry = {
      decisionId: result.decisionId || this.generateDecisionId(),
      policyPath,
      input,
      result,
      timestamp: new Date(),
    };

    this.decisionLog.push(entry);

    // Trim log if too large
    if (this.decisionLog.length > this.maxDecisionLogSize) {
      this.decisionLog.splice(0, this.decisionLog.length - this.maxDecisionLogSize);
    }

    this.eventEmitter.emit('opa.decision.logged', entry);
  }

  /**
   * Generate a decision ID
   */
  private generateDecisionId(): string {
    return `dec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get decision log entries
   */
  getDecisionLog(options?: {
    policyPath?: string;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): DecisionLogEntry[] {
    let entries = [...this.decisionLog];

    if (options?.policyPath) {
      entries = entries.filter(e => e.policyPath === options.policyPath);
    }

    if (options?.startTime) {
      entries = entries.filter(e => e.timestamp >= options.startTime!);
    }

    if (options?.endTime) {
      entries = entries.filter(e => e.timestamp <= options.endTime!);
    }

    if (options?.limit && options.limit > 0) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Clear decision log
   */
  clearDecisionLog(): void {
    this.decisionLog.length = 0;
    this.logger.debug('Decision log cleared');
  }

  /**
   * Get metrics
   */
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * Update metrics
   */
  private updateMetrics(success: boolean, evaluationTimeMs: number): void {
    this.metrics.totalEvaluations++;
    this.metrics.lastEvaluationTime = new Date();

    if (success) {
      this.metrics.successfulEvaluations++;
    } else {
      this.metrics.failedEvaluations++;
    }

    // Update average evaluation time
    this.metrics.averageEvaluationTimeMs =
      (this.metrics.averageEvaluationTimeMs * (this.metrics.totalEvaluations - 1) +
        evaluationTimeMs) /
      this.metrics.totalEvaluations;
  }

  /**
   * Validate a policy definition
   */
  private validatePolicy(policy: Policy): void {
    if (!policy.id) {
      throw new Error('Policy must have an id');
    }
    if (!policy.name) {
      throw new Error('Policy must have a name');
    }
    if (!policy.path) {
      throw new Error('Policy must have a path');
    }
  }

  /**
   * HTTP request helper
   */
  private httpRequest(
    method: string,
    url: string,
    body: string,
    headers?: Record<string, string>,
    timeout?: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;

      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };

      if (this.config.authToken) {
        requestHeaders['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: requestHeaders,
        timeout: timeout || this.config.timeout,
      };

      const req = lib.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body && method !== 'GET') {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Batch evaluate multiple inputs
   */
  async batchEvaluate(
    policyPath: string,
    inputs: PolicyInput[],
  ): Promise<PolicyResult[]> {
    const results: PolicyResult[] = [];

    // Process in parallel with concurrency limit
    const concurrencyLimit = 10;
    const chunks: PolicyInput[][] = [];

    for (let i = 0; i < inputs.length; i += concurrencyLimit) {
      chunks.push(inputs.slice(i, i + concurrencyLimit));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(input => this.evaluate(policyPath, input)),
      );
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Create a policy from JSON
   */
  createPolicyFromJson(json: string | object): Policy {
    const data = typeof json === 'string' ? JSON.parse(json) : json;

    const policy: Policy = {
      id: data.id,
      name: data.name,
      description: data.description,
      path: data.path,
      regoCode: data.regoCode,
      version: data.version || '1.0.0',
      enabled: data.enabled ?? true,
      metadata: data.metadata,
      createdAt: new Date(data.createdAt || Date.now()),
      updatedAt: new Date(data.updatedAt || Date.now()),
    };

    this.validatePolicy(policy);
    return policy;
  }

  /**
   * Export a policy to JSON
   */
  exportPolicyToJson(policyId: string): string {
    const policy = this.policies.get(policyId);
    if (!policy) {
      throw new Error(`Policy not found: ${policyId}`);
    }
    return JSON.stringify(policy, null, 2);
  }

  /**
   * Create a policy bundle
   */
  createBundle(id: string, name: string, policyIds: string[]): PolicyBundle {
    const policies = policyIds
      .map(id => this.policies.get(id))
      .filter((p): p is Policy => p !== undefined);

    return {
      id,
      name,
      policies,
      revision: Date.now().toString(),
      createdAt: new Date(),
    };
  }

  /**
   * Push data to OPA
   */
  async pushData(path: string, data: unknown): Promise<void> {
    const url = `${this.config.serverUrl}/v1/data/${path}`;
    await this.httpRequest('PUT', url, JSON.stringify(data));
    this.logger.debug(`Pushed data to OPA: ${path}`);
  }

  /**
   * Get data from OPA
   */
  async getData(path: string): Promise<unknown> {
    const url = `${this.config.serverUrl}/v1/data/${path}`;
    const response = await this.httpRequest('GET', url, '');
    const data = JSON.parse(response);
    return data.result;
  }

  /**
   * Delete data from OPA
   */
  async deleteData(path: string): Promise<void> {
    const url = `${this.config.serverUrl}/v1/data/${path}`;
    await this.httpRequest('DELETE', url, '');
    this.logger.debug(`Deleted data from OPA: ${path}`);
  }

  /**
   * Compile a partial query
   */
  async compileQuery(
    query: string,
    input?: PolicyInput,
    unknowns?: string[],
  ): Promise<{ queries: unknown[]; support: unknown[] }> {
    const url = `${this.config.serverUrl}/v1/compile`;
    const response = await this.httpRequest(
      'POST',
      url,
      JSON.stringify({ query, input, unknowns }),
    );
    const data = JSON.parse(response);
    return data.result;
  }
}
