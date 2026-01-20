import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { SystemSettingService } from './system-setting.service';

export interface InvitationEmailData {
  email: string;
  firstName: string;
  lastName: string;
  tenantName: string;
  invitationToken: string;
  role: string;
  expiresAt: Date;
  invitedByEmail?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  attempts?: number;
}

export interface EmailSendOptions {
  /** If true, throws an error when email cannot be sent (default: false) */
  required?: boolean;
  /** Maximum number of retry attempts (default: 1, max: 5) */
  maxRetries?: number;
  /** Base delay in ms between retries - uses exponential backoff (default: 1000) */
  retryDelayMs?: number;
}

/**
 * Email Sender Service
 * Sends emails using SMTP configuration from system settings
 */
@Injectable()
export class EmailSenderService {
  private readonly logger = new Logger(EmailSenderService.name);
  private transporter: nodemailer.Transporter | null = null;
  private lastConfigHash: string = '';

  constructor(private readonly settingsService: SystemSettingService) {}

  /**
   * Initialize or reinitialize transporter with current SMTP settings
   */
  private async initializeTransporter(): Promise<boolean> {
    try {
      const config = await this.settingsService.getEmailConfig();

      // Create a hash of config to detect changes
      const configHash = JSON.stringify({
        host: config.smtpHost,
        port: config.smtpPort,
        user: config.smtpUsername,
      });

      // Skip if already initialized with same config
      if (this.transporter && this.lastConfigHash === configHash) {
        return true;
      }

      if (!config.smtpHost) {
        this.logger.warn('SMTP host not configured, email service will not work');
        this.transporter = null;
        return false;
      }

      this.transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure || config.smtpPort === 465,
        auth: config.smtpUsername && config.smtpPassword
          ? { user: config.smtpUsername, pass: config.smtpPassword }
          : undefined,
      });

      this.lastConfigHash = configHash;
      this.logger.log(`Email transporter initialized with SMTP host: ${config.smtpHost}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize email transporter: ${(error as Error).message}`);
      this.transporter = null;
      return false;
    }
  }

  /**
   * Send a generic email with optional retry mechanism
   *
   * @param to - Recipient email address
   * @param subject - Email subject
   * @param html - HTML content
   * @param text - Optional plain text content (auto-generated from HTML if not provided)
   * @param options - Optional configuration for required flag and retry settings
   */
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    text?: string,
    options?: EmailSendOptions,
  ): Promise<EmailResult> {
    const {
      required = false,
      maxRetries = 1,
      retryDelayMs = 1000
    } = options || {};

    // Validate retry count
    const effectiveMaxRetries = Math.min(Math.max(1, maxRetries), 5);

    const initialized = await this.initializeTransporter();

    if (!initialized || !this.transporter) {
      const errorMsg = 'SMTP not configured. Please configure email settings.';
      this.logger.warn(`Email not sent (SMTP not configured): ${subject} to ${to}`);

      if (required) {
        throw new Error(errorMsg);
      }

      return {
        success: false,
        error: errorMsg,
        attempts: 0,
      };
    }

    let lastError: Error | null = null;
    let attempts = 0;

    // Retry loop with exponential backoff
    for (let attempt = 1; attempt <= effectiveMaxRetries; attempt++) {
      attempts = attempt;

      try {
        const config = await this.settingsService.getEmailConfig();
        const fromAddress = config.fromAddress || 'noreply@aquaculture.io';
        const fromName = config.fromName || 'Aquaculture Platform';

        const result = await this.transporter.sendMail({
          from: `"${fromName}" <${fromAddress}>`,
          to,
          subject,
          html,
          text: text || this.stripHtml(html),
        });

        this.logger.log(`Email sent to ${to}: ${result.messageId} (attempt ${attempt}/${effectiveMaxRetries})`);
        return {
          success: true,
          messageId: result.messageId,
          attempts,
        };
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `Email attempt ${attempt}/${effectiveMaxRetries} failed for ${to}: ${lastError.message}`,
        );

        // Don't wait after the last attempt
        if (attempt < effectiveMaxRetries) {
          // Exponential backoff: 1s, 2s, 4s, 8s...
          const delay = retryDelayMs * Math.pow(2, attempt - 1);
          this.logger.debug(`Waiting ${delay}ms before retry...`);
          await this.sleep(delay);
        }
      }
    }

    // All attempts failed
    const errorMessage = lastError?.message || 'Unknown error';
    this.logger.error(
      `Failed to send email to ${to} after ${effectiveMaxRetries} attempts: ${errorMessage}`,
    );

    if (required) {
      throw new Error(`Failed to send email after ${effectiveMaxRetries} attempts: ${errorMessage}`);
    }

    return {
      success: false,
      error: errorMessage,
      attempts,
    };
  }

  /**
   * Helper to sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send tenant admin invitation email
   *
   * @param data - Invitation email data
   * @param options - Optional email send options (required flag, retry settings)
   */
  async sendInvitationEmail(
    data: InvitationEmailData,
    options?: EmailSendOptions,
  ): Promise<EmailResult> {
    const baseUrl = process.env['FRONTEND_URL'] || 'http://localhost:8080';
    const inviteUrl = `${baseUrl}/accept-invitation?token=${data.invitationToken}`;

    const subject = `You're invited to join ${data.tenantName} on Aquaculture Platform`;

    const html = this.generateInvitationEmailTemplate({
      ...data,
      inviteUrl,
    });

    // Default to 3 retries for invitation emails as they are important
    const emailOptions: EmailSendOptions = {
      maxRetries: 3,
      ...options,
    };

    return this.sendEmail(data.email, subject, html, undefined, emailOptions);
  }

  /**
   * Generate invitation email HTML template
   */
  private generateInvitationEmailTemplate(data: InvitationEmailData & { inviteUrl: string }): string {
    const expiresInDays = Math.ceil(
      (data.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
            .header { background-color: #2563eb; color: white; padding: 32px 24px; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
            .header p { margin: 8px 0 0 0; opacity: 0.9; }
            .content { padding: 32px 24px; }
            .greeting { font-size: 18px; margin-bottom: 16px; }
            .info-box { background-color: #f8fafc; border-radius: 8px; padding: 20px; margin: 24px 0; }
            .info-row { display: flex; margin-bottom: 12px; }
            .info-label { font-weight: 600; color: #64748b; width: 120px; }
            .info-value { color: #1e293b; }
            .button { display: inline-block; background-color: #2563eb; color: white !important; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0; }
            .button:hover { background-color: #1d4ed8; }
            .note { background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 24px 0; font-size: 14px; }
            .footer { padding: 24px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; text-align: center; }
            .footer a { color: #2563eb; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to Aquaculture Platform</h1>
              <p>You've been invited to join ${data.tenantName}</p>
            </div>
            <div class="content">
              <p class="greeting">Hello ${data.firstName} ${data.lastName},</p>

              <p>You have been invited to join <strong>${data.tenantName}</strong> as a <strong>${this.formatRole(data.role)}</strong>.</p>

              <div class="info-box">
                <div class="info-row">
                  <span class="info-label">Organization:</span>
                  <span class="info-value">${data.tenantName}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Your Role:</span>
                  <span class="info-value">${this.formatRole(data.role)}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Your Email:</span>
                  <span class="info-value">${data.email}</span>
                </div>
              </div>

              <p>Click the button below to set up your password and activate your account:</p>

              <div style="text-align: center;">
                <a href="${data.inviteUrl}" class="button">Accept Invitation</a>
              </div>

              <div class="note">
                <strong>Note:</strong> This invitation will expire in ${expiresInDays} days.
                If you did not expect this invitation, you can safely ignore this email.
              </div>

              <p style="font-size: 14px; color: #64748b;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="${data.inviteUrl}" style="word-break: break-all;">${data.inviteUrl}</a>
              </p>
            </div>
            <div class="footer">
              <p>This email was sent by Aquaculture Platform.</p>
              <p>If you have any questions, please contact support.</p>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  /**
   * Format role for display
   */
  private formatRole(role: string): string {
    const roleMap: Record<string, string> = {
      SUPER_ADMIN: 'Super Administrator',
      TENANT_ADMIN: 'Tenant Administrator',
      MODULE_MANAGER: 'Module Manager',
      MODULE_USER: 'User',
    };
    return roleMap[role] || role.replace(/_/g, ' ');
  }

  /**
   * Strip HTML tags for plain text version
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Test SMTP configuration
   */
  async testConnection(): Promise<EmailResult> {
    const initialized = await this.initializeTransporter();

    if (!initialized || !this.transporter) {
      return {
        success: false,
        error: 'SMTP not configured',
      };
    }

    try {
      await this.transporter.verify();
      this.logger.log('SMTP connection verified successfully');
      return { success: true };
    } catch (error) {
      this.logger.error(`SMTP connection test failed: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }
}
