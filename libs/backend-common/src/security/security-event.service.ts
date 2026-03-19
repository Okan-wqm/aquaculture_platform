import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  SecurityEventType,
  createBaseEvent,
  SecurityEventBase,
} from '@platform/event-contracts';
import { IEventBus } from '@platform/event-bus';

/**
 * Options shared by all publish helpers.
 */
export interface SecurityEventOptions {
  tenantId?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

/**
 * SecurityEventService — Injectable NestJS service for publishing
 * security events to NATS `security.events.*` subjects.
 *
 * Falls back gracefully when the event bus is not connected.
 * Every publish method is non-blocking: errors are logged, never thrown.
 */
@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: IEventBus,
  ) {}

  // -------------------------------------------------------------------
  // Typed convenience methods
  // -------------------------------------------------------------------

  async publishLoginFailed(
    opts: SecurityEventOptions & { email?: string; reason: string; failedAttempts?: number },
  ): Promise<void> {
    await this.publish(SecurityEventType.AUTH_LOGIN_FAILED, opts, {
      email: opts.email,
      reason: opts.reason,
      failedAttempts: opts.failedAttempts,
    });
  }

  async publishLoginSuccess(
    opts: SecurityEventOptions & { email?: string },
  ): Promise<void> {
    await this.publish(SecurityEventType.AUTH_LOGIN_SUCCESS, opts, {
      email: opts.email,
    });
  }

  async publishTokenRejected(
    opts: SecurityEventOptions & { reason: string; jti?: string },
  ): Promise<void> {
    await this.publish(SecurityEventType.AUTH_TOKEN_REJECTED, opts, {
      reason: opts.reason,
      jti: opts.jti,
    });
  }

  async publishTokenBlacklisted(
    opts: SecurityEventOptions & { reason: string; jti?: string; scope: 'token' | 'user' },
  ): Promise<void> {
    await this.publish(SecurityEventType.AUTH_TOKEN_BLACKLISTED, opts, {
      reason: opts.reason,
      jti: opts.jti,
      scope: opts.scope,
    });
  }

  async publishPasswordReset(
    opts: SecurityEventOptions & { email?: string },
  ): Promise<void> {
    await this.publish(SecurityEventType.AUTH_PASSWORD_RESET, opts, {
      email: opts.email,
    });
  }

  async publishRateLimitExceeded(
    opts: SecurityEventOptions & { key: string; limit: number; windowMs: number; count: number },
  ): Promise<void> {
    await this.publish(SecurityEventType.RATE_LIMIT_EXCEEDED, opts, {
      key: opts.key,
      limit: opts.limit,
      windowMs: opts.windowMs,
      count: opts.count,
    });
  }

  async publishCspViolation(
    opts: SecurityEventOptions & {
      documentUri?: string;
      violatedDirective?: string;
      effectiveDirective?: string;
      blockedUri?: string;
      disposition?: string;
      sourceFile?: string;
      lineNumber?: number;
      columnNumber?: number;
    },
  ): Promise<void> {
    await this.publish(SecurityEventType.CSP_VIOLATION, opts, {
      documentUri: opts.documentUri,
      violatedDirective: opts.violatedDirective,
      effectiveDirective: opts.effectiveDirective,
      blockedUri: opts.blockedUri,
      disposition: opts.disposition,
      sourceFile: opts.sourceFile,
      lineNumber: opts.lineNumber,
      columnNumber: opts.columnNumber,
    });
  }

  async publishTenantAccessDenied(
    opts: SecurityEventOptions & { requestedTenantId: string; reason: string },
  ): Promise<void> {
    await this.publish(SecurityEventType.TENANT_ACCESS_DENIED, opts, {
      requestedTenantId: opts.requestedTenantId,
      reason: opts.reason,
    });
  }

  async publishServiceIdentityRejected(
    opts: SecurityEventOptions & { serviceName?: string; reason: string },
  ): Promise<void> {
    await this.publish(SecurityEventType.SERVICE_IDENTITY_REJECTED, opts, {
      serviceName: opts.serviceName,
      reason: opts.reason,
    });
  }

  async publishSuspiciousActivity(
    opts: SecurityEventOptions & { description: string; [key: string]: unknown },
  ): Promise<void> {
    const { tenantId, userId, ip, userAgent, correlationId, description, ...rest } = opts;
    await this.publish(
      SecurityEventType.SUSPICIOUS_ACTIVITY,
      { tenantId, userId, ip, userAgent, correlationId },
      { description, ...rest },
    );
  }

  // -------------------------------------------------------------------
  // Core publish logic
  // -------------------------------------------------------------------

  private async publish(
    securityEventType: SecurityEventType,
    opts: SecurityEventOptions,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.eventBus) {
      this.logger.debug(
        `Event bus not available — skipping ${securityEventType}`,
      );
      return;
    }

    if (!this.eventBus.isConnected()) {
      this.logger.debug(
        `Event bus not connected — skipping ${securityEventType}`,
      );
      return;
    }

    try {
      const base = createBaseEvent<SecurityEventBase>(
        'SecurityEvent',
        opts.tenantId ?? 'system',
        {
          userId: opts.userId,
          correlationId: opts.correlationId,
        },
      );

      const event: SecurityEventBase = {
        ...base,
        securityEventType,
        ip: opts.ip,
        userAgent: opts.userAgent,
        details,
        version: 1,
      };

      // Publish directly to the security subject for targeted routing
      await this.eventBus.publishTo(securityEventType, event);

      this.logger.debug(`Published security event: ${securityEventType}`);
    } catch (error) {
      // Never let a publish failure propagate — security events are
      // best-effort and must not break the main request flow.
      this.logger.warn(
        `Failed to publish security event ${securityEventType}: ${(error as Error).message}`,
      );
    }
  }
}
