import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  SecurityEventType,
  SecurityEvent,
  createBaseEvent,
  tenantScopeOf,
} from '@platform/event-contracts';
import type { BaseEvent } from '@platform/event-contracts';
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

  constructor(@Optional() @Inject('EVENT_BUS') private readonly eventBus?: IEventBus) {}

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

  async publishLoginSuccess(opts: SecurityEventOptions & { email?: string }): Promise<void> {
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

  async publishPasswordReset(opts: SecurityEventOptions & { email?: string }): Promise<void> {
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
    opts: SecurityEventOptions & {
      serviceName?: string;
      reason: string;
      // ORPHAN-098: the machine-readable rejection code (missing-headers /
      // bad-hmac / stale-timestamp / caller-not-allowed / audience-not-allowed /
      // key-not-found / key-not-active). Distinct from `reason` (a human
      // sentence) so dashboards + alerts can label/branch on the exact cause
      // instead of the deliberately-generic client-facing message.
      reasonCode?: string;
    },
  ): Promise<void> {
    await this.publish(SecurityEventType.SERVICE_IDENTITY_REJECTED, opts, {
      serviceName: opts.serviceName,
      reason: opts.reason,
      reasonCode: opts.reasonCode,
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
  // Event type name map — maps SecurityEventType to the dedicated
  // eventType discriminator.
  //
  // # Why exhaustiveness matters
  //
  // The `Record<SecurityEventType, string>` type forces every enum
  // member to appear in the map. A new enum value added without a
  // matching entry trips a TS2741 error at compile time — making
  // it impossible to ship a SecurityEventType the eventType-name
  // mapper doesn't handle. The comment is here so future
  // maintainers don't "fix" the error by relaxing the Record type
  // to a Partial.
  // -------------------------------------------------------------------
  private static readonly EVENT_TYPE_NAMES: Record<SecurityEventType, string> = {
    [SecurityEventType.AUTH_LOGIN_FAILED]: 'AuthLoginFailed',
    [SecurityEventType.AUTH_LOGIN_SUCCESS]: 'AuthLoginSuccess',
    [SecurityEventType.AUTH_TOKEN_REJECTED]: 'AuthTokenRejected',
    [SecurityEventType.AUTH_TOKEN_BLACKLISTED]: 'AuthTokenBlacklisted',
    [SecurityEventType.AUTH_PASSWORD_RESET]: 'AuthPasswordReset',
    [SecurityEventType.RATE_LIMIT_EXCEEDED]: 'RateLimitExceeded',
    [SecurityEventType.CSP_VIOLATION]: 'CspViolation',
    [SecurityEventType.TENANT_ACCESS_DENIED]: 'TenantAccessDenied',
    [SecurityEventType.SERVICE_IDENTITY_REJECTED]: 'ServiceIdentityRejected',
    [SecurityEventType.SUSPICIOUS_ACTIVITY]: 'SuspiciousActivity',
    // ORPHAN-MEDIUM-031 cure: the REFRESH_TOKEN_REUSE_DETECTED
    // enum member was added to libs/event-contracts/src/security/
    // security-events.ts in a prior commit but the corresponding
    // EVENT_TYPE_NAMES entry was never added — TS2741 fired on
    // every consumer importing this service. Drive-by fix
    // alongside CIRCUIT-LOW-002 because the sensor-service
    // unit-test compilation was blocked by it.
    [SecurityEventType.REFRESH_TOKEN_REUSE_DETECTED]: 'AuthRefreshTokenReuseDetected',
  };

  // -------------------------------------------------------------------
  // Core publish logic — flat event fields, no nested details bag.
  // -------------------------------------------------------------------

  private async publish(
    securityEventType: SecurityEventType,
    opts: SecurityEventOptions,
    flatFields: Record<string, unknown>,
  ): Promise<void> {
    if (!this.eventBus) {
      this.logger.debug(`Event bus not available — skipping ${securityEventType}`);
      return;
    }

    if (!this.eventBus.isConnected()) {
      this.logger.debug(`Event bus not connected — skipping ${securityEventType}`);
      return;
    }

    try {
      const eventTypeName = SecurityEventService.EVENT_TYPE_NAMES[securityEventType];
      const base = createBaseEvent<BaseEvent>(eventTypeName, tenantScopeOf(opts.tenantId), {
        userId: opts.userId,
        correlationId: opts.correlationId,
      });

      // Flat event: all fields at the top level, no nested details bag
      const event = {
        ...base,
        securityEventType,
        ip: opts.ip,
        userAgent: opts.userAgent,
        ...flatFields,
        version: 1,
      };

      // ORPHAN-MEDIUM-326: the enum values are the SEMANTIC identifiers
      // (`security.events.<...>`) carried in payloads and metrics labels;
      // the WIRE subject must live in the canonical `events.` space —
      // NatsEventBus.normalizeSubject rejects anything else (the previous
      // bare-enum publish died client-side on every call), and
      // observability-service consumes `events.security.events.>`.
      await this.eventBus.publishTo(`events.${securityEventType}`, event);

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
