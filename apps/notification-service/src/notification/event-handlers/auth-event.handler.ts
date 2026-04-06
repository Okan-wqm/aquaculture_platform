import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type {
  PasswordResetRequestedEvent,
  UserInvitedEvent,
} from '@platform/event-contracts';
import { maskEmail } from '@aquaculture/backend-common';
import { EmailService } from '../services/email.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Auth Event Handler
 * Listens to PasswordResetRequested and UserInvited events
 * and dispatches the appropriate email notifications.
 */
@Injectable()
export class AuthEventHandler
  implements IEventHandler<PasswordResetRequestedEvent | UserInvitedEvent>, OnModuleInit
{
  private readonly logger = new Logger(AuthEventHandler.name);

  constructor(
    private readonly emailService: EmailService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribe('PasswordResetRequested', this);
    await this.eventBus.subscribe('UserInvited', this);
    this.logger.log('Subscribed to PasswordResetRequested and UserInvited events');
  }

  getEventType(): string {
    return 'AuthEvent';
  }

  async handle(event: PasswordResetRequestedEvent | UserInvitedEvent): Promise<void> {
    // SECURITY: Validate tenantId format to ensure data isolation
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `Auth event has invalid or missing tenantId. ` +
        'Skipping to prevent cross-tenant notification leakage.',
      );
      return;
    }

    const eventType = event.eventType;
    this.logger.log(
      `Processing ${eventType} for tenant ${event.tenantId.substring(0, 8)}...`,
    );

    try {
      switch (eventType) {
        case 'PasswordResetRequested':
          await this.handlePasswordResetRequested(event as PasswordResetRequestedEvent);
          break;
        case 'UserInvited':
          await this.handleUserInvited(event as UserInvitedEvent);
          break;
        default:
          this.logger.warn(`Unknown auth event type: ${eventType}`);
      }
    } catch (error) {
      this.logger.error(
        `Error processing ${eventType} event: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /**
   * Handle PasswordResetRequested — send password reset email
   */
  private async handlePasswordResetRequested(event: PasswordResetRequestedEvent): Promise<void> {
    // SECURITY: SEC-C01 — reject stale v1 events that carry raw tokens
    if ((event as Record<string, unknown>)['resetToken']) {
      this.logger.warn('SECURITY: Rejected v1 PasswordResetRequested event carrying raw resetToken. User must re-request.');
      return;
    }

    if (!event.email || !event.actionUrl) {
      this.logger.error('PasswordResetRequested event missing email or actionUrl. Skipping.');
      return;
    }

    const resetUrl = event.actionUrl;
    const displayName = event.firstName || 'there';

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

    await this.emailService.sendEmail(event.email, subject, html);
    // SECURITY: Mask email in logs to prevent PII exposure (H-14)
    this.logger.log(`Password reset email sent to ${maskEmail(event.email)}`);
  }

  /**
   * Handle UserInvited — send welcome/invitation email
   */
  private async handleUserInvited(event: UserInvitedEvent): Promise<void> {
    if (!event.email) {
      this.logger.error('UserInvited event missing email. Skipping.');
      return;
    }

    await this.emailService.sendWelcomeEmail({
      firstName: event.firstName,
      lastName: event.lastName,
      email: event.email,
      tenantName: event.tenantName,
      role: event.role,
      actionUrl: event.actionUrl || `${process.env['FRONTEND_URL'] || 'http://localhost:3000'}/setup-account`,
    });

    // SECURITY: Mask email in logs to prevent PII exposure (H-14)
    this.logger.log(`Welcome email sent to ${maskEmail(event.email)} for tenant ${event.tenantName}`);
  }
}
