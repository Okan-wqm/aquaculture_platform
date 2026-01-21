/**
 * Policy Enforcer Service
 *
 * High-level policy enforcement service that uses OPA for authorization decisions.
 * Provides domain-specific policy evaluation methods for the aquaculture platform.
 * Handles policy loading, caching, and decision auditing.
 */

import { Injectable, Logger, ForbiddenException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OpaClientService, OpaResult, OpaHealthStatus } from './opa-client.service';

/**
 * Authorization context for policy evaluation
 */
export interface AuthorizationContext {
  subject: SubjectContext;
  resource: ResourceContext;
  action: ActionContext;
  environment?: EnvironmentContext;
}

/**
 * Subject (user/service) context
 */
export interface SubjectContext {
  id: string;
  type: 'user' | 'service' | 'system';
  tenantId: string;
  roles?: string[];
  permissions?: string[];
  attributes?: Record<string, unknown>;
}

/**
 * Resource context
 */
export interface ResourceContext {
  type: string;
  id?: string;
  tenantId?: string;
  ownerId?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Action context
 */
export interface ActionContext {
  name: string;
  method?: string;
  path?: string;
}

/**
 * Environment context
 */
export interface EnvironmentContext {
  timestamp?: Date;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  location?: {
    country?: string;
    region?: string;
  };
}

/**
 * Authorization decision
 */
export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
  obligations?: PolicyObligation[];
  decisionId?: string;
  evaluationTime?: number;
}

/**
 * Policy obligation (post-decision actions)
 */
export interface PolicyObligation {
  type: 'log' | 'notify' | 'restrict' | 'audit' | 'custom';
  action: string;
  parameters?: Record<string, unknown>;
}

/**
 * Policy paths for different authorization scenarios
 */
const POLICY_PATHS = {
  resourceAccess: 'aquaculture/authz/resource_access',
  moduleAccess: 'aquaculture/authz/module_access',
  tenantAccess: 'aquaculture/authz/tenant_access',
  dataResidency: 'aquaculture/authz/data_residency',
  roleHierarchy: 'aquaculture/authz/role_hierarchy',
  featureFlag: 'aquaculture/authz/feature_flag',
  apiRateLimit: 'aquaculture/authz/api_rate_limit',
  sensitiveData: 'aquaculture/authz/sensitive_data',
};

/**
 * Built-in policies for fallback when OPA is unavailable
 */
const FALLBACK_POLICIES: Record<string, (context: AuthorizationContext) => boolean> = {
  // System admin can do anything
  systemAdmin: (ctx) => ctx.subject.roles?.includes('system_admin') ?? false,

  // Users can only access their own tenant
  tenantIsolation: (ctx) =>
    !ctx.resource.tenantId || ctx.subject.tenantId === ctx.resource.tenantId,

  // Resource owner has full access
  ownerAccess: (ctx) =>
    !!ctx.resource.ownerId && ctx.subject.id === ctx.resource.ownerId,
};

/**
 * Policy Enforcer Service
 * Domain-specific authorization enforcement
 */
@Injectable()
export class PolicyEnforcerService implements OnModuleInit {
  private readonly logger = new Logger(PolicyEnforcerService.name);
  private readonly enableAuditLog: boolean;
  private readonly failOpen: boolean;
  private isOpaAvailable = false;

  constructor(
    private readonly opaClient: OpaClientService,
    private readonly configService: ConfigService,
  ) {
    this.enableAuditLog = this.configService.get<boolean>('POLICY_AUDIT_LOG', true);
    this.failOpen = this.configService.get<boolean>('POLICY_FAIL_OPEN', false);
  }

  async onModuleInit(): Promise<void> {
    // Check OPA availability
    const health = await this.opaClient.checkHealth();
    this.isOpaAvailable = health.status === 'healthy';

    // Subscribe to health changes
    this.opaClient.on('healthChange', (status: OpaHealthStatus) => {
      this.isOpaAvailable = status.status === 'healthy';
      this.logger.log('OPA availability changed', { available: this.isOpaAvailable });
    });

    this.logger.log('Policy Enforcer initialized', { opaAvailable: this.isOpaAvailable });
  }

  /**
   * Check if action is authorized
   */
  async isAuthorized(context: AuthorizationContext): Promise<AuthorizationDecision> {
    const startTime = Date.now();

    try {
      // Try OPA evaluation first
      if (this.isOpaAvailable) {
        return await this.evaluateWithOpa(context, startTime);
      }

      // Fallback to built-in policies
      return this.evaluateWithFallback(context, startTime);
    } catch (error) {
      this.logger.error('Authorization evaluation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        context: this.sanitizeContext(context),
      });

      // Fail open or closed based on configuration
      if (this.failOpen) {
        return {
          allowed: true,
          reason: 'Policy evaluation failed, defaulting to allow',
          evaluationTime: Date.now() - startTime,
        };
      }

      return {
        allowed: false,
        reason: 'Policy evaluation failed',
        evaluationTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Enforce authorization (throws if not allowed)
   */
  async enforce(context: AuthorizationContext): Promise<void> {
    const decision = await this.isAuthorized(context);

    if (!decision.allowed) {
      // Audit the denial
      if (this.enableAuditLog) {
        this.auditDecision(context, decision);
      }

      throw new ForbiddenException({
        message: 'Access denied',
        reason: decision.reason || 'Insufficient permissions',
        resource: context.resource.type,
        action: context.action.name,
      });
    }

    // Execute obligations
    if (decision.obligations && decision.obligations.length > 0) {
      this.executeObligations(decision.obligations, context);
    }
  }

  /**
   * Check resource access
   */
  async canAccessResource(
    subject: SubjectContext,
    resourceType: string,
    resourceId: string,
    action: string,
  ): Promise<boolean> {
    const decision = await this.isAuthorized({
      subject,
      resource: { type: resourceType, id: resourceId, tenantId: subject.tenantId },
      action: { name: action },
    });

    return decision.allowed;
  }

  /**
   * Check module access
   */
  async canAccessModule(subject: SubjectContext, moduleName: string): Promise<boolean> {
    if (!this.isOpaAvailable) {
      // Fallback: all authenticated users can access modules
      return !!subject.id;
    }

    const result = await this.opaClient.evaluatePolicy(POLICY_PATHS.moduleAccess, {
      subject: this.buildSubjectInput(subject),
      module: moduleName,
    });

    return this.extractAllowDecision(result);
  }

  /**
   * Check if user can perform cross-tenant access
   */
  async canAccessTenant(subject: SubjectContext, targetTenantId: string): Promise<boolean> {
    // Same tenant is always allowed
    if (subject.tenantId === targetTenantId) {
      return true;
    }

    // System admins can access any tenant
    if (subject.roles?.includes('system_admin')) {
      return true;
    }

    if (!this.isOpaAvailable) {
      return false;
    }

    const result = await this.opaClient.evaluatePolicy(POLICY_PATHS.tenantAccess, {
      subject: this.buildSubjectInput(subject),
      targetTenantId,
    });

    return this.extractAllowDecision(result);
  }

  /**
   * Check data residency compliance
   */
  async checkDataResidency(
    subject: SubjectContext,
    dataLocation: string,
    allowedRegions: string[],
  ): Promise<boolean> {
    if (!this.isOpaAvailable) {
      // Fallback: check if location is in allowed regions
      return allowedRegions.includes(dataLocation);
    }

    const result = await this.opaClient.evaluatePolicy(POLICY_PATHS.dataResidency, {
      subject: this.buildSubjectInput(subject),
      dataLocation,
      allowedRegions,
    });

    return this.extractAllowDecision(result);
  }

  /**
   * Check if feature is enabled for user
   */
  async isFeatureEnabled(subject: SubjectContext, featureName: string): Promise<boolean> {
    if (!this.isOpaAvailable) {
      // Fallback: check subject attributes
      const features = subject.attributes?.['features'] as Record<string, boolean> | undefined;
      return features?.[featureName] ?? false;
    }

    const result = await this.opaClient.evaluatePolicy(POLICY_PATHS.featureFlag, {
      subject: this.buildSubjectInput(subject),
      feature: featureName,
    });

    return this.extractAllowDecision(result);
  }

  /**
   * Get effective permissions for subject
   */
  async getEffectivePermissions(subject: SubjectContext): Promise<string[]> {
    if (!this.isOpaAvailable) {
      return subject.permissions || [];
    }

    const result = await this.opaClient.evaluatePolicy(POLICY_PATHS.roleHierarchy, {
      subject: this.buildSubjectInput(subject),
    });

    const permissions = (result.result as { permissions?: string[] })?.permissions;
    return permissions || subject.permissions || [];
  }

  /**
   * Check API rate limit policy
   */
  async checkRateLimit(
    subject: SubjectContext,
    endpoint: string,
    currentCount: number,
  ): Promise<{ allowed: boolean; limit: number; remaining: number }> {
    if (!this.isOpaAvailable) {
      // Default rate limits
      const limit = subject.attributes?.['rateLimit'] as number || 1000;
      return {
        allowed: currentCount < limit,
        limit,
        remaining: Math.max(0, limit - currentCount),
      };
    }

    const result = await this.opaClient.evaluatePolicy(POLICY_PATHS.apiRateLimit, {
      subject: this.buildSubjectInput(subject),
      endpoint,
      currentCount,
    });

    const rateLimit = result.result as {
      allowed?: boolean;
      limit?: number;
      remaining?: number;
    };

    return {
      allowed: rateLimit.allowed ?? true,
      limit: rateLimit.limit ?? 1000,
      remaining: rateLimit.remaining ?? 1000,
    };
  }

  /**
   * Check access to sensitive data
   */
  async canAccessSensitiveData(
    subject: SubjectContext,
    dataClassification: 'public' | 'internal' | 'confidential' | 'restricted',
  ): Promise<boolean> {
    if (!this.isOpaAvailable) {
      // Fallback: role-based access
      const roleClassificationMap: Record<string, string[]> = {
        restricted: ['system_admin', 'security_admin'],
        confidential: ['system_admin', 'security_admin', 'tenant_admin'],
        internal: ['system_admin', 'security_admin', 'tenant_admin', 'manager'],
        public: [], // Anyone can access
      };

      const requiredRoles = roleClassificationMap[dataClassification];
      if (!requiredRoles || requiredRoles.length === 0) {
        return true;
      }

      return subject.roles?.some((role) => requiredRoles.includes(role)) ?? false;
    }

    const result = await this.opaClient.evaluatePolicy(POLICY_PATHS.sensitiveData, {
      subject: this.buildSubjectInput(subject),
      classification: dataClassification,
    });

    return this.extractAllowDecision(result);
  }

  /**
   * Evaluate using OPA
   */
  private async evaluateWithOpa(
    context: AuthorizationContext,
    startTime: number,
  ): Promise<AuthorizationDecision> {
    const input = this.buildOpaInput(context);

    const result = await this.opaClient.evaluatePolicy(
      POLICY_PATHS.resourceAccess,
      input,
    );

    const decision = this.parseOpaResult(result);
    decision.evaluationTime = Date.now() - startTime;

    // Audit the decision
    if (this.enableAuditLog) {
      this.auditDecision(context, decision);
    }

    return decision;
  }

  /**
   * Evaluate using fallback policies
   */
  private evaluateWithFallback(
    context: AuthorizationContext,
    startTime: number,
  ): AuthorizationDecision {
    // Check fallback policies in order
    for (const [policyName, policyFn] of Object.entries(FALLBACK_POLICIES)) {
      if (policyFn(context)) {
        return {
          allowed: true,
          reason: `Allowed by fallback policy: ${policyName}`,
          evaluationTime: Date.now() - startTime,
        };
      }
    }

    return {
      allowed: false,
      reason: 'No fallback policy matched',
      evaluationTime: Date.now() - startTime,
    };
  }

  /**
   * Build OPA input from context
   */
  private buildOpaInput(context: AuthorizationContext): Record<string, unknown> {
    return {
      subject: this.buildSubjectInput(context.subject),
      resource: {
        type: context.resource.type,
        id: context.resource.id,
        tenant_id: context.resource.tenantId,
        owner_id: context.resource.ownerId,
        attributes: context.resource.attributes,
      },
      action: {
        name: context.action.name,
        method: context.action.method,
        path: context.action.path,
      },
      environment: context.environment
        ? {
            timestamp: context.environment.timestamp?.toISOString(),
            ip_address: context.environment.ipAddress,
            user_agent: context.environment.userAgent,
            device_fingerprint: context.environment.deviceFingerprint,
            location: context.environment.location,
          }
        : undefined,
    };
  }

  /**
   * Build subject input for OPA
   */
  private buildSubjectInput(subject: SubjectContext): Record<string, unknown> {
    return {
      id: subject.id,
      type: subject.type,
      tenant_id: subject.tenantId,
      roles: subject.roles || [],
      permissions: subject.permissions || [],
      attributes: subject.attributes || {},
    };
  }

  /**
   * Parse OPA result into authorization decision
   */
  private parseOpaResult(result: OpaResult): AuthorizationDecision {
    const decision = result.result as {
      allow?: boolean;
      allowed?: boolean;
      reason?: string;
      obligations?: PolicyObligation[];
    };

    return {
      allowed: decision?.allow ?? decision?.allowed ?? false,
      reason: decision?.reason,
      obligations: decision?.obligations,
      decisionId: result.decision_id,
    };
  }

  /**
   * Extract allow decision from OPA result
   */
  private extractAllowDecision(result: OpaResult): boolean {
    const decision = result.result;

    if (typeof decision === 'boolean') {
      return decision;
    }

    if (typeof decision === 'object' && decision !== null) {
      const obj = decision as Record<string, unknown>;
      return (obj['allow'] ?? obj['allowed'] ?? false) as boolean;
    }

    return false;
  }

  /**
   * Execute policy obligations
   */
  private executeObligations(
    obligations: PolicyObligation[],
    context: AuthorizationContext,
  ): void {
    for (const obligation of obligations) {
      try {
        switch (obligation.type) {
          case 'log':
            this.logger.log('Policy obligation: log', {
              action: obligation.action,
              context: this.sanitizeContext(context),
            });
            break;

          case 'audit':
            this.auditObligation(obligation, context);
            break;

          case 'notify':
            // Would integrate with notification service
            this.logger.debug('Policy obligation: notify', {
              action: obligation.action,
              parameters: obligation.parameters,
            });
            break;

          case 'restrict':
            // Apply additional restrictions
            this.logger.debug('Policy obligation: restrict', {
              action: obligation.action,
              parameters: obligation.parameters,
            });
            break;

          default:
            this.logger.warn('Unknown obligation type', { obligation });
        }
      } catch (error) {
        this.logger.error('Failed to execute obligation', {
          obligation,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Audit authorization decision
   */
  private auditDecision(
    context: AuthorizationContext,
    decision: AuthorizationDecision,
  ): void {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      subjectId: context.subject.id,
      subjectType: context.subject.type,
      tenantId: context.subject.tenantId,
      resourceType: context.resource.type,
      resourceId: context.resource.id,
      action: context.action.name,
      allowed: decision.allowed,
      reason: decision.reason,
      decisionId: decision.decisionId,
      evaluationTime: decision.evaluationTime,
    };

    // In production, this would send to audit service
    this.logger.debug('Authorization decision', auditEntry);
  }

  /**
   * Audit obligation execution
   */
  private auditObligation(
    obligation: PolicyObligation,
    context: AuthorizationContext,
  ): void {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      type: 'policy_obligation',
      obligationType: obligation.type,
      obligationAction: obligation.action,
      subjectId: context.subject.id,
      tenantId: context.subject.tenantId,
      parameters: obligation.parameters,
    };

    this.logger.debug('Obligation audit', auditEntry);
  }

  /**
   * Sanitize context for logging (remove sensitive data)
   */
  private sanitizeContext(context: AuthorizationContext): Record<string, unknown> {
    return {
      subject: {
        id: context.subject.id,
        type: context.subject.type,
        tenantId: context.subject.tenantId,
        roles: context.subject.roles,
      },
      resource: {
        type: context.resource.type,
        id: context.resource.id,
      },
      action: context.action.name,
    };
  }
}
