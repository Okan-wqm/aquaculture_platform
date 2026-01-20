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
interface OpaRequest extends Request {
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

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.opaUrl = this.configService.get<string>(
      'OPA_URL',
      'http://localhost:8181',
    );
    this.enabled = this.configService.get<boolean>('OPA_ENABLED', false);
    this.failOpen = this.configService.get<boolean>('OPA_FAIL_OPEN', false);
    this.timeout = this.configService.get<number>('OPA_TIMEOUT_MS', 5000);
    this.cacheTtl = this.configService.get<number>('OPA_CACHE_TTL_MS', 30000);
    this.decisionCache = new Map();

    this.logger.log(
      `OpaPolicyGuard initialized: enabled=${this.enabled}, url=${this.opaUrl}`,
    );
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

    if (!policyConfig) {
      // No policy configured, allow by default
      return true;
    }

    const request = this.getRequest(context);
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
      if (this.failOpen) {
        this.logger.warn('OPA failed, allowing request (fail-open mode)');
        return true;
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
    const forwardedFor = request.headers?.['x-forwarded-for'];
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
        ip:
          request.ip ??
          (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0] : undefined) ??
          request.connection?.remoteAddress,
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

      // Cache the decision
      this.decisionCache.set(cacheKey, {
        decision,
        expiry: Date.now() + this.cacheTtl,
      });

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

    return keyParts.join(':');
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
}
