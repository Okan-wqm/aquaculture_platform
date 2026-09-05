import { createHash } from 'node:crypto';

import { signedFetch } from '@aquaculture/backend-common/http';
import { maskEmail } from '@aquaculture/backend-common/utils';
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IEventBus, IEventHandler, HandlerOutcome, outcomeForError } from '@platform/event-bus';
import { eventTenantScope, requireTenantScope } from '@platform/event-contracts';
import type {
  EventTenantScope,
  PasswordResetRequestedEvent,
  UserAccountLockedEvent,
  UserInvitedEvent,
} from '@platform/event-contracts';

import { EmailService } from '../services/email.service';

/**
 * Minimal user PII resolved from auth-service at delivery time.
 * SECURITY: This data is fetched via authenticated internal API call,
 * never carried on the event bus.
 */
interface ResolvedUserPII {
  email: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Minimal tenant info resolved from auth-service at delivery time.
 */
interface ResolvedTenantInfo {
  name: string;
}

/**
 * Resolved action URL from auth-service at delivery time.
 */
interface ResolvedActionInfo {
  actionUrl: string;
}

/**
 * The tenant binding of an internal call for a scope: the tenant id, or the
 * explicit non-tenant opt-out (`''`) that signedFetch documents for proven
 * non-tenant paths. auth-service reads the empty binding as the platform
 * scope and resolves NULL-tenant principals only (SEC-HIGH-057).
 */
function signedTenantBinding(scope: EventTenantScope): string {
  return scope.kind === 'tenant' ? scope.tenantId : '';
}

/**
 * Auth Event Handler
 *
 * Listens to PasswordResetRequested and UserInvited events
 * and dispatches the appropriate email notifications.
 *
 * SECURITY (CRITICAL-001/002): Events no longer carry PII or secret URLs.
 * This handler resolves user details, tenant info, and action URLs at
 * delivery time via authenticated internal API calls to auth-service.
 *
 * Tenancy (SEC-HIGH-057): the event's scope is parsed through the contract
 * (eventTenantScope), never a hand-rolled UUID guard. A platform-scoped
 * event — a super admin's password reset or lockout — is delivered through
 * the platform-scope internal identity (signedFetch `tenantId: ''`), which
 * auth-service resolves against NULL-tenant principals only. UserInvited is
 * structurally tenant-bound (requireTenantScope). A malformed scope throws,
 * so the bus redelivers/dead-letters it instead of the handler silently
 * acknowledging a dropped e-mail.
 */
@Injectable()
export class AuthEventHandler
  implements
    IEventHandler<PasswordResetRequestedEvent | UserInvitedEvent | UserAccountLockedEvent>,
    OnModuleInit
{
  private readonly logger = new Logger(AuthEventHandler.name);
  private readonly authServiceUrl: string;
  constructor(
    private readonly emailService: EmailService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    private readonly configService: ConfigService,
  ) {
    this.authServiceUrl = this.configService.get<string>(
      'AUTH_SERVICE_INTERNAL_URL',
      'http://auth-service:3000',
    );
  }

  async onModuleInit(): Promise<void> {
    // WHAT — `subscribeWildcard` builds `events.*.{eventType}`, capturing
    // every tenant's auth-lifecycle events.
    // WHY explicit wildcard — auth notifications fan out cross-tenant from
    // a single notification-service instance. The explicit helper pins the
    // publisher↔subscriber subject contract (3 segments).
    await this.eventBus.subscribeWildcard('PasswordResetRequested', this);
    await this.eventBus.subscribeWildcard('UserInvited', this);
    // ORPHAN-MEDIUM-320: owner-facing lockout notification.
    await this.eventBus.subscribeWildcard('UserAccountLocked', this);
    this.logger.log(
      'Subscribed to PasswordResetRequested, UserInvited and UserAccountLocked events (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'AuthEvent';
  }

  async handle(
    event: PasswordResetRequestedEvent | UserInvitedEvent | UserAccountLockedEvent,
  ): Promise<HandlerOutcome> {
    // SEC-HIGH-057: parse, do not guard. A tenant UUID and the platform
    // segment are both legitimate; anything else is a contract violation
    // that must surface to the bus, not be acknowledged as "skipped".
    const scope = eventTenantScope(event);

    const eventType = event.eventType;
    this.logger.log(
      scope.kind === 'tenant'
        ? `Processing ${eventType} for tenant ${scope.tenantId.substring(0, 8)}...`
        : `Processing ${eventType} for a platform-scoped principal`,
    );

    try {
      switch (eventType) {
        case 'PasswordResetRequested':
          return await this.handlePasswordResetRequested(
            event as PasswordResetRequestedEvent,
            scope,
          );
        case 'UserInvited':
          return await this.handleUserInvited(event as UserInvitedEvent);
        case 'UserAccountLocked':
          return await this.handleUserAccountLocked(event as UserAccountLockedEvent, scope);
        default:
          this.logger.warn(`Unknown auth event type: ${eventType}`);
          return HandlerOutcome.terminate(`Unknown auth event type: ${eventType}`);
      }
    } catch (error) {
      this.logger.error(
        `Error processing ${eventType} event: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // PLAT-HIGH-902: a contract violation (e.g. an invalid tenancy scope on
      // UserInvited) or a validation rejection is dead-lettered; anything else
      // is retried within the delivery budget. Never acknowledged as sent.
      return outcomeForError(`${eventType} delivery`, error);
    }
  }

  // ── Internal API helpers ──

  /**
   * Resolve user PII from auth-service at delivery time.
   * SECURITY: PII is fetched via authenticated internal API, never from the event bus.
   */
  private async resolveUserPII(
    userId: string,
    scope: EventTenantScope,
  ): Promise<ResolvedUserPII | null> {
    try {
      // SECURITY (SEC-CRITICAL-001 closure): use signedFetch which produces
      // v2 HMAC headers binding tenantId AND method+path+body. Manual
      // generateServiceIdentityHeaders + fetch is the v1 pattern that left
      // the canonical input cross-endpoint-replayable.
      const response = await signedFetch(
        `${this.authServiceUrl}/api/v1/internal/users/${userId}/pii`,
        {
          method: 'GET',
          serviceName: 'notification-service',
          tenantId: signedTenantBinding(scope),
          audience: 'auth-service',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (!response.ok) {
        this.logger.error(
          `Failed to resolve user PII for userId=${userId}: HTTP ${response.status}`,
        );
        return null;
      }
      return (await response.json()) as ResolvedUserPII;
    } catch (error) {
      this.logger.error(
        `Failed to resolve user PII for userId=${userId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Resolve tenant info from auth-service at delivery time.
   */
  private async resolveTenantInfo(tenantId: string): Promise<ResolvedTenantInfo | null> {
    try {
      // SECURITY (SEC-CRITICAL-001 closure): see resolveUserPII for rationale.
      const response = await signedFetch(
        `${this.authServiceUrl}/api/v1/internal/tenants/${tenantId}/info`,
        {
          method: 'GET',
          serviceName: 'notification-service',
          tenantId,
          audience: 'auth-service',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (!response.ok) {
        this.logger.error(
          `Failed to resolve tenant info for tenantId=${tenantId}: HTTP ${response.status}`,
        );
        return null;
      }
      return (await response.json()) as ResolvedTenantInfo;
    } catch (error) {
      this.logger.error(
        `Failed to resolve tenant info for tenantId=${tenantId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Resolve action URL from auth-service at delivery time.
   * SECURITY: The actual reset/invitation URL (with embedded token) is built by
   * auth-service and returned via an authenticated internal API call. The raw
   * token never touches the event bus.
   */
  private async resolveActionUrl(
    actionTokenId: string,
    scope: EventTenantScope,
  ): Promise<ResolvedActionInfo | null> {
    try {
      // SECURITY (SEC-CRITICAL-001 closure): see resolveUserPII for rationale.
      const response = await signedFetch(
        `${this.authServiceUrl}/api/v1/internal/action-tokens/${actionTokenId}/url`,
        {
          method: 'GET',
          serviceName: 'notification-service',
          tenantId: signedTenantBinding(scope),
          audience: 'auth-service',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      if (!response.ok) {
        this.logger.error(
          `Failed to resolve action URL for tokenIdHash=${this.hashTokenId(actionTokenId)}: HTTP ${response.status}`,
        );
        return null;
      }
      return (await response.json()) as ResolvedActionInfo;
    } catch (error) {
      this.logger.error(
        `Failed to resolve action URL for tokenIdHash=${this.hashTokenId(actionTokenId)}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private hashTokenId(actionTokenId: string): string {
    return createHash('sha256').update(actionTokenId).digest('hex').slice(0, 16);
  }

  // ── Event handlers ──

  /**
   * Handle PasswordResetRequested — resolve PII at delivery time, then send email
   */
  /**
   * ORPHAN-MEDIUM-320: the account-locked owner notification.
   *
   * The login wire response is deliberately the generic anti-enumeration
   * message, so this email is the ONLY signal the legitimate owner receives
   * that their account was locked (and when it unlocks, and what to do if
   * the failed attempts were not theirs). No PII rides the event — the
   * address is resolved at delivery time via the authenticated internal
   * PII endpoint, identical to the password-reset flow.
   */
  private async handleUserAccountLocked(
    event: UserAccountLockedEvent,
    scope: EventTenantScope,
  ): Promise<HandlerOutcome> {
    if (!event.userId || !event.lockedUntil) {
      this.logger.error('UserAccountLocked event missing userId or lockedUntil. Skipping.');
      return HandlerOutcome.terminate('UserAccountLocked: missing userId or lockedUntil');
    }

    const userPII = await this.resolveUserPII(event.userId, scope);
    if (!userPII) {
      this.logger.error(
        `Cannot send account-locked email — failed to resolve user PII for userId=${event.userId}`,
      );
      return HandlerOutcome.retry('UserAccountLocked: user PII could not be resolved');
    }

    const displayName = userPII.firstName || 'there';
    const unlockAt = new Date(event.lockedUntil);
    const unlockDisplay = Number.isNaN(unlockAt.getTime()) ? 'shortly' : unlockAt.toUTCString();

    const subject = 'Your account was temporarily locked - Aquaculture Platform';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
            .header { background-color: #cc3300; color: white; padding: 32px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 32px; }
            .warning { background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 12px 16px; margin: 20px 0; font-size: 14px; }
            .footer { padding: 24px 32px; font-size: 12px; color: #666; border-top: 1px solid #eee; text-align: center; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Account Temporarily Locked</h1>
            </div>
            <div class="content">
              <p>Hello ${displayName},</p>
              <p>Your account was locked after ${event.failedAttempts} failed sign-in attempts.</p>
              <p>It will unlock automatically at <strong>${unlockDisplay}</strong>. You can also regain access immediately by resetting your password — a successful password reset clears the lock.</p>
              <div class="warning">
                <strong>Wasn't you?</strong> If you did not attempt to sign in, someone may be
                trying to guess your password. We recommend resetting your password now and
                contacting your administrator.
              </div>
            </div>
            <div class="footer">
              <p>This is an automated security notification from the Aquaculture Platform.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    await this.emailService.sendEmail(userPII.email, subject, html);
    this.logger.log(
      `Account-locked notification dispatched for userId=${event.userId} (unlocks ${unlockDisplay})`,
    );
    return HandlerOutcome.ack();
  }

  private async handlePasswordResetRequested(
    event: PasswordResetRequestedEvent,
    scope: EventTenantScope,
  ): Promise<HandlerOutcome> {
    // SECURITY: Reject stale v1 events that carry raw tokens or PII
    if ('resetToken' in event) {
      this.logger.warn(
        'SECURITY: Rejected v1 PasswordResetRequested event carrying raw resetToken. User must re-request.',
      );
      return HandlerOutcome.terminate('PasswordResetRequested: v1 shape carrying a raw token');
    }
    if ('email' in event) {
      this.logger.warn(
        'SECURITY: Rejected legacy PasswordResetRequested event carrying raw PII (email). User must re-request.',
      );
      return HandlerOutcome.terminate('PasswordResetRequested: legacy shape carrying PII');
    }

    if (!event.userId || !event.actionTokenId) {
      this.logger.error('PasswordResetRequested event missing userId or actionTokenId. Skipping.');
      return HandlerOutcome.terminate('PasswordResetRequested: missing userId or actionTokenId');
    }

    // Resolve PII and action URL at delivery time
    const [userPII, actionInfo] = await Promise.all([
      this.resolveUserPII(event.userId, scope),
      this.resolveActionUrl(event.actionTokenId, scope),
    ]);

    if (!userPII || !actionInfo) {
      this.logger.error(
        `Cannot send password reset email — failed to resolve user PII or action URL for userId=${event.userId}`,
      );
      return HandlerOutcome.retry(
        'PasswordResetRequested: user PII or action URL could not be resolved',
      );
    }

    const resetUrl = actionInfo.actionUrl;
    const displayName = userPII.firstName || 'there';

    const subject = 'Password Reset Request - Aquaculture Platform';
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
            .header { background-color: #0066cc; color: white; padding: 32px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 32px; }
            .button-container { text-align: center; margin: 32px 0; }
            .button { display: inline-block; background-color: #0066cc; color: white; padding: 16px 48px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; }
            .warning { background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 12px 16px; margin: 20px 0; font-size: 14px; }
            .footer { padding: 24px 32px; font-size: 12px; color: #666; border-top: 1px solid #eee; text-align: center; }
            .link-fallback { font-size: 12px; color: #666; word-break: break-all; margin-top: 16px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset</h1>
            </div>
            <div class="content">
              <p>Hello ${displayName},</p>
              <p>We received a request to reset your password. Click the button below to set a new password:</p>
              <div class="button-container">
                <a href="${resetUrl}" class="button">Reset Password</a>
              </div>
              <div class="warning">
                <strong>Important:</strong> This link will expire in 1 hour.
                If you did not request a password reset, please ignore this email.
              </div>
              <p class="link-fallback">
                If the button doesn't work, copy and paste this link into your browser:<br>
                ${resetUrl}
              </p>
            </div>
            <div class="footer">
              <p>This is an automated message from Aquaculture Platform.</p>
              <p>If you didn't request this, please ignore this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    await this.emailService.sendEmail(userPII.email, subject, html);
    // SECURITY: Mask email in logs to prevent PII exposure (H-14)
    this.logger.log(`Password reset email sent to ${maskEmail(userPII.email)}`);
    return HandlerOutcome.ack();
  }

  /**
   * Handle UserInvited — resolve PII/tenant at delivery time, then send welcome email
   */
  private async handleUserInvited(event: UserInvitedEvent): Promise<HandlerOutcome> {
    // An invitation always targets a tenant; a platform-scoped UserInvited is
    // a contract violation and throws (SEC-HIGH-057).
    const scope = requireTenantScope(event);

    // SECURITY: Reject legacy events carrying raw PII
    if ('email' in event) {
      this.logger.warn(
        'SECURITY: Rejected legacy UserInvited event carrying raw PII (email). Re-invite required.',
      );
      return HandlerOutcome.terminate('UserInvited: legacy shape carrying PII');
    }

    if (!event.userId || !event.actionTokenId) {
      this.logger.error('UserInvited event missing userId or actionTokenId. Skipping.');
      return HandlerOutcome.terminate('UserInvited: missing userId or actionTokenId');
    }

    // Resolve PII, tenant info, and action URL at delivery time
    const [userPII, tenantInfo, actionInfo] = await Promise.all([
      this.resolveUserPII(event.userId, scope),
      this.resolveTenantInfo(scope.tenantId),
      this.resolveActionUrl(event.actionTokenId, scope),
    ]);

    if (!userPII || !tenantInfo || !actionInfo?.actionUrl) {
      this.logger.error(
        `Cannot send welcome email — failed to resolve user PII, tenant info, or action URL for userId=${event.userId}`,
      );
      return HandlerOutcome.retry(
        'UserInvited: user PII, tenant info or action URL could not be resolved',
      );
    }

    await this.emailService.sendWelcomeEmail({
      firstName: userPII.firstName,
      lastName: userPII.lastName,
      email: userPII.email,
      tenantName: tenantInfo.name,
      role: event.role,
      actionUrl: actionInfo.actionUrl,
    });

    // SECURITY: Mask email in logs to prevent PII exposure (H-14)
    this.logger.log(
      `Welcome email sent to ${maskEmail(userPII.email)} for tenant ${tenantInfo.name}`,
    );
    return HandlerOutcome.ack();
  }
}
