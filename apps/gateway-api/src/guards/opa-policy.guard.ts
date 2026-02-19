/**
 * OPA Policy Guard
 *
 * Enforces Open Policy Agent (OPA) policies for fine-grained authorization.
 * Supports dynamic policy evaluation with request context.
 * Enterprise-grade with policy caching and fallback behavior.
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

/**
 * Metadata key for OPA policy
 */
export const OPA_POLICY_KEY = 'opaPolicy';

/**
 * OPA policy configuration
 */
export interface OpaPolicyConfig {
  policy: string;
  rule?: string;
  input?: Record<string, unknown>;
}

/**
 * Decorator to specify OPA policy for an endpoint
 */
export const OpaPolicy = (config: OpaPolicyConfig): ReturnType<typeof SetMetadata> =>
  SetMetadata(OPA_POLICY_KEY, config);

/**
 * Metadata key for bypassing OPA
 */
export const BYPASS_OPA_KEY = 'bypassOpa';

/**
 * Decorator to bypass OPA policy check
 */
export const BypassOpa = (): ReturnType<typeof SetMetadata> => SetMetadata(BYPASS_OPA_KEY, true);

/**
 * OPA decision result
 */
export interface OpaDecision {
  allow: boolean;
  reason?: string;
  violations?: string[];
}

/**
 * OPA input for policy evaluation
 */
export interface OpaInput {
  subject: {
    id: string;
    email?: string;
    role?: string;
    tenantId?: string;
    permissions?: string[];
  };
  resource: {
    type: string;
    id?: string;
    tenantId?: string;
    [key: string]: unknown;
  };
  action: string;
  context: {
    timestamp: string;
    ip?: string;
    path?: string;
    method?: string;
    correlationId?: string;
  };
}

/**
 * User payload for OPA requests
 */
interface OpaUserPayload {
  sub?: string;
  email?: string;
  role?: string;
  tenantId?: string;
  permissions?: string[];
}

/**
 * OPA request interface
 */
interface OpaRequest extends Omit<Request, 'connection'> {
  user?: OpaUserPayload;
  tenantId?: string;
  connection?: {
    remoteAddress?: string;
  };
}

/**
 * GraphQL context interface
 */
interface GqlContext {
  req?: OpaRequest;
}

/**
 * OPA response result structure
 */
interface OpaResultResponse {
  result?: boolean | {
    allow?: boolean;
    reason?: string;
    violations?: string[];
  };
}

/**
 * OPA Policy Guard
 * Evaluates OPA policies for authorization decisions
 */
@Injectable()
export class OpaPolicyGuard implements CanActivate {
  private readonly logger = new Logger(OpaPolicyGuard.name);
  private readonly opaUrl: string;
  private readonly enabled: boolean;
  private readonly failOpen: boolean;
  private readonly timeout: number;
  private readonly decisionCache: Map<string, { decision: OpaDecision; expiry: number }>;
  private readonly cacheTtl: number;
  private readonly maxCacheSize: number;
  private readonly cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.opaUrl = this.configService.get<string>(
      'OPA_URL',
      'http://localhost:8181',
    );
    // SECURITY: In production, OPA defaults to enabled for defense-in-depth.
    // Set OPA_ENABLED=false explicitly to disable (with a mandatory warning).
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    const opaEnabledRaw = this.configService.get<string>('OPA_ENABLED');

    if (isProduction && opaEnabledRaw === undefined) {
      // Production without explicit config: default to enabled
      this.enabled = true;
    } else {
      this.enabled = this.configService.get<boolean>('OPA_ENABLED', false);
    }

    this.failOpen = this.configService.get<boolean>('OPA_FAIL_OPEN', false);
    this.timeout = this.configService.get<number>('OPA_TIMEOUT_MS', 5000);
    this.cacheTtl = this.configService.get<number>('OPA_CACHE_TTL_MS', 30000);
    this.maxCacheSize = this.configService.get<number>('OPA_MAX_CACHE_SIZE', 10000);
    this.decisionCache = new Map();

    // SECURITY: Set up automatic cache cleanup
    // This ensures stale permissions are eventually removed
    this.cleanupInterval = setInterval(() => this.cleanupExpiredEntries(), this.cacheTtl);

    // SECURITY: Warn loudly if OPA is disabled in production
    if (isProduction && !this.enabled) {
      this.logger.error(
        'SECURITY WARNING: OPA policy enforcement is DISABLED in production. ' +
        'This means fine-grained authorization is not enforced. ' +
        'Set OPA_ENABLED=true and configure OPA_URL to enable policy enforcement.',
      );
    }

    this.logger.log(
      `OpaPolicyGuard initialized: enabled=${this.enabled}, url=${this.opaUrl}`,
    );
  }

  /**
   * Cleanup resources on module destroy
   */
  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * SECURITY: Cleanup expired cache entries
   * Prevents memory growth and ensures stale permissions expire
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, value] of this.decisionCache) {
      if (value.expiry < now) {
        this.decisionCache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug(`OPA cache cleanup: removed ${removed} expired entries`);
    }
  }

  /**
   * SECURITY: Enforce cache size limit
   * Removes oldest entries when cache exceeds max size
   */
  private enforceCacheSizeLimit(): void {
    if (this.decisionCache.size <= this.maxCacheSize) {
      return;
    }

    // Convert to array and sort by expiry (oldest first)
    const entries = Array.from(this.decisionCache.entries())
      .sort((a, b) => a[1].expiry - b[1].expiry);

    // Remove oldest entries until we're under the limit
    const toRemove = entries.slice(0, entries.length - this.maxCacheSize + 100);
    for (const [key] of toRemove) {
      this.decisionCache.delete(key);
    }

    this.logger.debug(`OPA cache size limit enforced: removed ${toRemove.length} entries`);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if OPA is enabled
    if (!this.enabled) {
      return true;
    }

    // Check if endpoint bypasses OPA
    const bypass = this.reflector.getAllAndOverride<boolean>(BYPASS_OPA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (bypass) {
      return true;
    }

    // Get policy configuration
    const policyConfig = this.reflector.getAllAndOverride<OpaPolicyConfig>(
      OPA_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = this.getRequest(context);

    if (!policyConfig) {
      // No policy configured
      // SECURITY: In production, fail-closed for security
      const isProduction = process.env['NODE_ENV'] === 'production';
      if (isProduction) {
        this.logger.error(
          `No OPA policy configured for ${request.path}. ` +
          'Production requires explicit policy configuration. Access denied.',
        );
        throw new ForbiddenException({
          message: 'Access denied: No policy configured',
          reason: 'Endpoints must have explicit OPA policy configuration in production',
        });
      }
      // Development: Allow by default for backwards compatibility
      this.logger.debug(`No OPA policy configured for ${request.path}, allowing in development mode`);
      return true;
    }
    const input = this.buildOpaInput(request, policyConfig, context);

    try {
      const decision = await this.evaluatePolicy(policyConfig, input);

      if (!decision.allow) {
        this.logger.warn('OPA policy denied access', {
          policy: policyConfig.policy,
          userId: input.subject.id,
          resource: input.resource,
          reason: decision.reason,
          violations: decision.violations,
        });

        throw new ForbiddenException({
          message: 'Access denied by policy',
          reason: decision.reason,
          violations: decision.violations,
        });
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      this.logger.error('OPA policy evaluation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        policy: policyConfig.policy,
      });

      // Fail open or closed based on configuration
      // SECURITY: Fail-open is disabled in production for security
      const isProduction = process.env['NODE_ENV'] === 'production';
      if (this.failOpen && !isProduction) {
        this.logger.warn('OPA failed, allowing request (fail-open mode - dev only)');
        return true;
      }

      if (this.failOpen && isProduction) {
        this.logger.error(
          'OPA_FAIL_OPEN is enabled but ignored in production. ' +
          'Policy evaluation failed, denying access.',
        );
      }

      throw new ForbiddenException('Policy evaluation failed');
    }
  }

  /**
   * Get request from execution context
   */
  private getRequest(context: ExecutionContext): OpaRequest {
    const gqlContext = GqlExecutionContext.create(context);
    const ctx = gqlContext.getContext<GqlContext>();
    const gqlRequest = ctx?.req;

    if (gqlRequest) {
      return gqlRequest;
    }

    return context.switchToHttp().getRequest<OpaRequest>();
  }

  /**
   * Build OPA input from request and policy config
   */
  private buildOpaInput(
    request: OpaRequest,
    config: OpaPolicyConfig,
    context: ExecutionContext,
  ): OpaInput {
    const user = request.user ?? {};
    const handler = context.getHandler();
    const className = context.getClass().name;
    const tenantIdHeader = request.headers?.['x-tenant-id'];
    const correlationId = request.headers?.['x-correlation-id'];

    return {
      subject: {
        id: user.sub ?? 'anonymous',
        email: user.email,
        role: user.role,
        tenantId: user.tenantId ?? request.tenantId,
        permissions: user.permissions ?? [],
      },
      resource: {
        type: className,
        id: request.params?.id,
        tenantId: request.tenantId ?? (typeof tenantIdHeader === 'string' ? tenantIdHeader : undefined),
        ...config.input,
      },
      action: handler.name,
      context: {
        timestamp: new Date().toISOString(),
        // SECURITY: Use req.ip which respects trust proxy setting;
        // do not fall back to x-forwarded-for which is client-spoofable
        ip: request.ip ?? request.connection?.remoteAddress,
        path: request.url,
        method: request.method,
        correlationId: typeof correlationId === 'string' ? correlationId : undefined,
      },
    };
  }

  /**
   * Evaluate OPA policy
   */
  async evaluatePolicy(
    config: OpaPolicyConfig,
    input: OpaInput,
  ): Promise<OpaDecision> {
    // Check cache
    const cacheKey = this.buildCacheKey(config, input);
    const cached = this.decisionCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return cached.decision;
    }

    const policyPath = config.rule
      ? `${config.policy}/${config.rule}`
      : config.policy;

    const url = `${this.opaUrl}/v1/data/${policyPath}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`OPA returned ${response.status}`);
      }

      const result = (await response.json()) as OpaResultResponse;
      const decision = this.parseOpaResult(result);

      // Cache the decision with size limit enforcement
      this.decisionCache.set(cacheKey, {
        decision,
        expiry: Date.now() + this.cacheTtl,
      });
      this.enforceCacheSizeLimit();

      return decision;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Parse OPA result into decision
   */
  private parseOpaResult(result: OpaResultResponse): OpaDecision {
    if (!result.result) {
      return { allow: false, reason: 'No policy result' };
    }

    // Handle boolean result
    if (typeof result.result === 'boolean') {
      return { allow: result.result };
    }

    // Handle object result with allow field
    if (typeof result.result === 'object') {
      return {
        allow: result.result.allow === true,
        reason: result.result.reason,
        violations: result.result.violations,
      };
    }

    return { allow: false, reason: 'Invalid policy result format' };
  }

  /**
   * Build cache key for decision
   */
  /**
   * Build cache key for decision
   * SECURITY: Uses pipe delimiter with length-prefixed parts to prevent
   * key collision when resource IDs or policy names contain the delimiter.
   */
  private buildCacheKey(config: OpaPolicyConfig, input: OpaInput): string {
    const keyParts = [
      config.policy,
      config.rule || 'default',
      input.subject.id,
      input.subject.tenantId || 'no-tenant',
      input.resource.type,
      input.resource.id || 'no-id',
      input.action,
    ];

    // Length-prefix each part to prevent ambiguity
    return keyParts.map(p => `${p.length}:${p}`).join('|');
  }

  /**
   * Clear decision cache
   */
  clearCache(): void {
    this.decisionCache.clear();
    this.logger.log('OPA decision cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; oldestEntry: number | null } {
    let oldest: number | null = null;
    for (const [, value] of this.decisionCache) {
      if (oldest === null || value.expiry < oldest) {
        oldest = value.expiry;
      }
    }

    return {
      size: this.decisionCache.size,
      oldestEntry: oldest ? oldest - Date.now() : null,
    };
  }

  /**
   * SECURITY: Invalidate cache for a specific user
   * Call this when user permissions change
   */
  invalidateUserCache(userId: string): number {
    let invalidated = 0;
    const prefix = `:${userId}:`;

    for (const key of this.decisionCache.keys()) {
      if (key.includes(prefix)) {
        this.decisionCache.delete(key);
        invalidated++;
      }
    }

    this.logger.log(`OPA cache invalidated for user ${userId}: ${invalidated} entries`);
    return invalidated;
  }

  /**
   * SECURITY: Invalidate cache for a specific tenant
   * Call this when tenant policies or permissions change
   */
  invalidateTenantCache(tenantId: string): number {
    let invalidated = 0;
    const prefix = `:${tenantId}:`;

    for (const key of this.decisionCache.keys()) {
      if (key.includes(prefix)) {
        this.decisionCache.delete(key);
        invalidated++;
      }
    }

    this.logger.log(`OPA cache invalidated for tenant ${tenantId}: ${invalidated} entries`);
    return invalidated;
  }

  /**
   * SECURITY: Invalidate cache for a specific policy
   * Call this when a policy is updated in OPA
   */
  invalidatePolicyCache(policyName: string): number {
    let invalidated = 0;

    for (const key of this.decisionCache.keys()) {
      if (key.startsWith(policyName + ':')) {
        this.decisionCache.delete(key);
        invalidated++;
      }
    }

    this.logger.log(`OPA cache invalidated for policy ${policyName}: ${invalidated} entries`);
    return invalidated;
  }
}
