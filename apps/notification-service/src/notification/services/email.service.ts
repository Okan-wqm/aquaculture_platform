import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { HttpFailureClass } from '@aquaculture/backend-common/http';
import { maskEmail } from '@aquaculture/backend-common/utils';

/**
 * HTML escape function to prevent XSS in email templates.
 * Single-pass replacement using a character-class regex and a lookup map,
 * replacing the previous 5-sequential-replace approach which ran 5 full
 * string scans per call.
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(str: string | undefined | null): string {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]!);
}

/**
 * Alert email data
 */
export interface AlertEmailData {
  ruleName: string;
  severity: string;
  message: string;
  farmName?: string;
  pondName?: string;
  sensorId?: string;
  timestamp?: Date;
}

/**
 * Welcome email data for new users
 */
export interface WelcomeEmailData {
  firstName?: string;
  lastName?: string;
  email: string;
  tenantName: string;
  role: string;
  actionUrl: string;
  expiresInDays?: number;
}

/**
 * Regulatory report email data (for Mattilsynet urgent reports)
 */
export interface RegulatoryReportEmailData {
  reportType: 'welfare' | 'disease' | 'escape';
  siteName: string;
  siteCode: string;
  lokalitetsnummer: string;
  organisasjonsnummer: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone?: string;
  detectedAt: Date;
  reportedBy: string;
  siteManagerEmail?: string;
  // Type-specific data
  welfareData?: {
    eventType: string;
    severity: string;
    mortalityRate?: number;
    mortalityPeriod?: string;
    affectedBatches?: string[];
    description: string;
    immediateActions: string[];
  };
  diseaseData?: {
    diseaseCategory: 'A' | 'C' | 'F';
    diseaseName: string;
    confirmation: 'suspected' | 'confirmed';
    affectedCount: number;
    affectedPercentage: number;
    clinicalSigns: string[];
    veterinarianNotified: boolean;
    veterinarianName?: string;
  };
  escapeData?: {
    estimatedCount: number;
    species: string;
    avgWeightG: number;
    totalBiomassKg: number;
    cause: string;
    affectedUnits: string[];
    recoveryOngoing: boolean;
  };
}

/** Mattilsynet urgent reports email address */
export const MATTILSYNET_URGENT_EMAIL = 'varsling.akva@mattilsynet.no';

/**
 * Fiskeridirektoratet (Directorate of Fisheries) email address.
 * Norwegian akvakulturloven requires fish-escape ("romming") incidents to be
 * reported to BOTH Mattilsynet AND Fiskeridirektoratet, so escape varsling
 * emails carry this recipient in addition to MATTILSYNET_URGENT_EMAIL. Mirrors
 * the frontend SSoT REGULATORY_CONTACTS.FISKERIDIREKTORATET_EMAIL.
 */
export const FISKERIDIREKTORATET_EMAIL = 'postmottak@fiskeridir.no';

/**
 * Email Service
 * Handles email notifications using nodemailer
 */
/**
 * A failed e-mail delivery, classified for the bus (PLAT-HIGH-902).
 * `failureClass` is the duck-typed marker outcomeForError reads.
 */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly failureClass: HttpFailureClass,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }

  /** nodemailer surfaces the SMTP reply code as `responseCode`; 5xx is final. */
  static fromTransport(error: unknown): EmailDeliveryError {
    if (error instanceof EmailDeliveryError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const responseCode =
      typeof error === 'object' && error !== null
        ? (error as { responseCode?: unknown }).responseCode
        : undefined;
    const permanent = typeof responseCode === 'number' && responseCode >= 500;
    return new EmailDeliveryError(message, permanent ? 'permanent' : 'transient', error);
  }
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly fromAddress: string;
  private readonly isEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.fromAddress = this.configService.get('SMTP_FROM', 'noreply@aquaculture-platform.com');
    this.isEnabled = this.configService.get('SMTP_ENABLED', 'true') === 'true';

    if (this.isEnabled) {
      this.initializeTransporter();
    } else {
      this.logger.warn('Email service is disabled');
    }
  }

  private initializeTransporter(): void {
    const host = this.configService.get('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get('SMTP_USER');
    const pass = this.configService.get('SMTP_PASSWORD');

    if (!host) {
      this.logger.warn('SMTP_HOST not configured, email service will not work');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      requireTLS: port !== 465,
      tls: {
        rejectUnauthorized: true,
      },
    });

    this.logger.log(`Email service initialized with SMTP host: ${host}`);
  }

  /**
   * Send a generic email.
   *
   * Throws EmailDeliveryError with the failure already classified
   * (PLAT-HIGH-902): no transporter is a deployment fact that redelivery
   * cannot change (permanent); an SMTP 5xx is the server's final answer for
   * this message (permanent); everything else — connection, timeout, 4xx
   * greylisting — is transient and worth the bus's retry budget.
   */
  async sendEmail(to: string, subject: string, html: string, text?: string): Promise<string> {
    if (!this.transporter) {
      // SECURITY: Mask email in logs to prevent PII exposure (H-14)
      this.logger.warn(`Email not sent (disabled): ${subject} to ${maskEmail(to)}`);
      throw new EmailDeliveryError('SMTP transporter is not configured', 'permanent');
    }

    try {
      const result = await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        html,
        text: text || this.stripHtml(html),
      });

      // SECURITY: Mask email in logs to prevent PII exposure (H-14)
      this.logger.log(`Email sent to ${maskEmail(to)}: ${result.messageId}`);
      return result.messageId;
    } catch (error) {
      // SECURITY: Mask email in logs to prevent PII exposure (H-14)
      this.logger.error(`Failed to send email to ${maskEmail(to)}: ${(error as Error).message}`);
      throw EmailDeliveryError.fromTransport(error);
    }
  }

  /**
   * Send an alert notification email
   */
  async sendAlertEmail(to: string, alertData: AlertEmailData): Promise<string> {
    // Sanitize recipient email to prevent header injection
    const sanitizedTo = this.sanitizeEmailAddress(to);
    // Strip CRLF from subject to prevent SMTP header injection
    const subject = `[${alertData.severity.toUpperCase()}] ${alertData.ruleName}`.replace(
      /[\r\n]/g,
      '',
    );
    const html = this.generateAlertEmailTemplate(alertData);

    return await this.sendEmail(sanitizedTo, subject, html);
  }

  /**
   * Send a welcome email to a newly invited user
   */
  async sendWelcomeEmail(data: WelcomeEmailData): Promise<string> {
    const subject = `Welcome to ${data.tenantName} - Set Up Your Account`;
    const html = this.generateWelcomeEmailTemplate(data);

    return await this.sendEmail(data.email, subject, html);
  }

  /**
   * Generate welcome email HTML template
   */
  private generateWelcomeEmailTemplate(data: WelcomeEmailData): string {
    const displayName = data.firstName
      ? `${data.firstName}${data.lastName ? ' ' + data.lastName : ''}`
      : 'there';
    const expiresIn = data.expiresInDays || 7;

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
            .header { background-color: #0066cc; color: white; padding: 32px; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; }
            .header p { margin: 8px 0 0 0; opacity: 0.9; }
            .content { padding: 32px; }
            .greeting { font-size: 18px; margin-bottom: 16px; }
            .info-box { background-color: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
            .info-row { display: flex; margin-bottom: 8px; }
            .info-label { font-weight: 600; color: #666; min-width: 120px; }
            .info-value { color: #333; }
            .button-container { text-align: center; margin: 32px 0; }
            .button { display: inline-block; background-color: #0066cc; color: white; padding: 16px 48px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; }
            .button:hover { background-color: #0052a3; }
            .warning { background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 12px 16px; margin: 20px 0; font-size: 14px; }
            .footer { padding: 24px 32px; font-size: 12px; color: #666; border-top: 1px solid #eee; text-align: center; }
            .link-fallback { font-size: 12px; color: #666; word-break: break-all; margin-top: 16px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to Aquaculture Platform</h1>
              <p>Your account has been created</p>
            </div>
            <div class="content">
              <p class="greeting">Hello ${escapeHtml(displayName)},</p>
              <p>
                You've been invited to join <strong>${escapeHtml(data.tenantName)}</strong> on Aquaculture Platform.
                Your account has been created and is ready for you to set up.
              </p>

              <div class="info-box">
                <div class="info-row">
                  <span class="info-label">Organization:</span>
                  <span class="info-value">${escapeHtml(data.tenantName)}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Email:</span>
                  <span class="info-value">${escapeHtml(data.email)}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Role:</span>
                  <span class="info-value">${escapeHtml(data.role.replace(/_/g, ' '))}</span>
                </div>
              </div>

              <div class="button-container">
                <a href="${encodeURI(data.actionUrl)}" class="button">Set Up Your Password</a>
              </div>

              <div class="warning">
                <strong>Important:</strong> This link will expire in ${expiresIn} days.
                Please set up your password before the link expires.
              </div>

              <p class="link-fallback">
                If the button doesn't work, copy and paste this link into your browser:<br>
                ${escapeHtml(data.actionUrl)}
              </p>
            </div>
            <div class="footer">
              <p>This is an automated message from Aquaculture Platform.</p>
              <p>If you didn't expect this email, please ignore it or contact your administrator.</p>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  /**
   * Generate alert email HTML template
   */
  private generateAlertEmailTemplate(data: AlertEmailData): string {
    const severityColors: Record<string, string> = {
      critical: '#dc3545',
      warning: '#ffc107',
      info: '#17a2b8',
    };

    const bgColor = severityColors[data.severity] || '#6c757d';

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
            .header { background-color: ${bgColor}; color: white; padding: 24px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 24px; }
            .field { margin-bottom: 16px; }
            .field-label { font-weight: 600; color: #666; font-size: 12px; text-transform: uppercase; margin-bottom: 4px; }
            .field-value { font-size: 16px; color: #333; }
            .message-box { background-color: #f8f9fa; border-left: 4px solid ${bgColor}; padding: 16px; margin: 16px 0; }
            .footer { padding: 16px 24px; font-size: 12px; color: #666; border-top: 1px solid #eee; }
            .button { display: inline-block; background-color: ${bgColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin-top: 16px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Alert Triggered</h1>
            </div>
            <div class="content">
              <div class="field">
                <div class="field-label">Alert Rule</div>
                <div class="field-value">${escapeHtml(data.ruleName)}</div>
              </div>
              <div class="field">
                <div class="field-label">Severity</div>
                <div class="field-value" style="color: ${bgColor}; font-weight: 600; text-transform: uppercase;">
                  ${escapeHtml(data.severity)}
                </div>
              </div>
              <div class="message-box">
                <div class="field-label">Message</div>
                <div class="field-value">${escapeHtml(data.message)}</div>
              </div>
              ${
                data.farmName
                  ? `
              <div class="field">
                <div class="field-label">Farm</div>
                <div class="field-value">${escapeHtml(data.farmName)}</div>
              </div>
              `
                  : ''
              }
              ${
                data.pondName
                  ? `
              <div class="field">
                <div class="field-label">Pond</div>
                <div class="field-value">${escapeHtml(data.pondName)}</div>
              </div>
              `
                  : ''
              }
              ${
                data.sensorId
                  ? `
              <div class="field">
                <div class="field-label">Sensor ID</div>
                <div class="field-value">${escapeHtml(data.sensorId)}</div>
              </div>
              `
                  : ''
              }
              <div class="field">
                <div class="field-label">Time</div>
                <div class="field-value">${escapeHtml((data.timestamp || new Date()).toLocaleString())}</div>
              </div>
            </div>
            <div class="footer">
              <p>This is an automated alert from Aquaculture Platform.</p>
              <p>Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;
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

  // ==========================================================================
  // Regulatory Report Emails (Mattilsynet Urgent Reports)
  // ==========================================================================

  /**
   * Sanitize email address to prevent header injection (CRLF injection)
   * Removes newlines, carriage returns, and validates basic email format
   */
  private sanitizeEmailAddress(email: string): string {
    // Remove any CRLF characters that could be used for header injection
    const sanitized = email.replace(/[\r\n\t]/g, '').trim();

    // Enforce RFC 5321 maximum email address length (254 characters)
    if (sanitized.length > 254) {
      this.logger.warn(
        `Email address exceeds maximum length (254 chars): ${sanitized.substring(0, 20)}...`,
      );
      throw new Error('Email address exceeds maximum allowed length');
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(sanitized)) {
      this.logger.warn(`Invalid email format detected: ${sanitized.substring(0, 20)}...`);
      throw new Error(`Invalid email format: ${sanitized}`);
    }

    return sanitized;
  }

  /**
   * Send a regulatory report email to Mattilsynet
   * Used for welfare events, disease outbreaks, and escape reports
   */
  async sendRegulatoryReportEmail(
    data: RegulatoryReportEmailData,
  ): Promise<{ messageId: string; sentTo: string[] }> {
    const reportTitles = {
      welfare: 'Welfare Event Report / Velferdshendelsemelding',
      disease: 'Disease Outbreak Report / Sykdomsutbruddmelding',
      escape: 'Escape Report / Rommingsmelding',
    };

    const subject = `[URGENT] ${reportTitles[data.reportType]} - ${data.siteName} - ${this.formatDate(data.detectedAt)}`;
    const html = this.generateRegulatoryReportTemplate(data);

    const recipients = [MATTILSYNET_URGENT_EMAIL];
    // Fish escapes are reported to BOTH Mattilsynet AND Fiskeridirektoratet
    // under akvakulturloven; non-escape varsling (welfare/disease) goes to
    // Mattilsynet only.
    if (data.reportType === 'escape') {
      recipients.push(FISKERIDIREKTORATET_EMAIL);
    }
    if (data.siteManagerEmail) {
      recipients.push(data.siteManagerEmail);
    }

    // SECURITY FIX: Sanitize all recipient email addresses to prevent header injection
    // This prevents CRLF injection attacks that could manipulate email headers (BCC injection, etc.)
    const sanitizedRecipients = recipients.map((email) => this.sanitizeEmailAddress(email));

    const messageId = await this.sendEmail(sanitizedRecipients.join(', '), subject, html);

    this.logger.log(`Regulatory report email sent: ${data.reportType} for ${data.siteName}`);

    return { messageId, sentTo: sanitizedRecipients };
  }

  /**
   * Send a welfare event report email
   */
  async sendWelfareEventEmail(
    data: Omit<RegulatoryReportEmailData, 'reportType'>,
  ): Promise<{ messageId: string; sentTo: string[] }> {
    return this.sendRegulatoryReportEmail({ ...data, reportType: 'welfare' });
  }

  /**
   * Send a disease outbreak report email
   */
  async sendDiseaseOutbreakEmail(
    data: Omit<RegulatoryReportEmailData, 'reportType'>,
  ): Promise<{ messageId: string; sentTo: string[] }> {
    return this.sendRegulatoryReportEmail({ ...data, reportType: 'disease' });
  }

  /**
   * Send an escape report email
   */
  async sendEscapeReportEmail(
    data: Omit<RegulatoryReportEmailData, 'reportType'>,
  ): Promise<{ messageId: string; sentTo: string[] }> {
    return this.sendRegulatoryReportEmail({ ...data, reportType: 'escape' });
  }

  /**
   * Generate regulatory report email HTML template
   */
  private generateRegulatoryReportTemplate(data: RegulatoryReportEmailData): string {
    const reportColors = {
      welfare: '#dc3545', // Red
      disease: '#ff6600', // Orange
      escape: '#9c27b0', // Purple
    };

    const reportIcons = {
      welfare: '&#x1F41F;',
      disease: '&#x1F9A0;',
      escape: '&#x1F6A8;',
    };

    const reportTitles = {
      welfare: 'WELFARE EVENT / VELFERDSMELDING',
      disease: 'DISEASE OUTBREAK / SYKDOMSUTBRUDD',
      escape: 'ESCAPE INCIDENT / ROMMINGSHENDELSE',
    };

    const bgColor = reportColors[data.reportType];
    const icon = reportIcons[data.reportType];
    const title = reportTitles[data.reportType];

    let specificContent = '';

    if (data.reportType === 'welfare' && data.welfareData) {
      specificContent = this.generateWelfareSection(data.welfareData);
    } else if (data.reportType === 'disease' && data.diseaseData) {
      specificContent = this.generateDiseaseSection(data.diseaseData);
    } else if (data.reportType === 'escape' && data.escapeData) {
      specificContent = this.generateEscapeSection(data.escapeData);
    }

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5; }
            .container { max-width: 700px; margin: 0 auto; background-color: #ffffff; border: 1px solid #ddd; }
            .header { background-color: ${bgColor}; color: white; padding: 24px; text-align: center; }
            .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
            .urgent-badge { background-color: rgba(255,255,255,0.2); display: inline-block; padding: 4px 12px; border-radius: 4px; margin-bottom: 8px; font-size: 12px; font-weight: 600; }
            .content { padding: 24px; }
            .section { margin-bottom: 24px; border-bottom: 1px solid #eee; padding-bottom: 16px; }
            .section:last-child { border-bottom: none; }
            .section-title { font-size: 14px; font-weight: 700; color: ${bgColor}; text-transform: uppercase; margin-bottom: 12px; }
            .field { margin-bottom: 12px; display: flex; }
            .field-label { font-weight: 600; color: #666; font-size: 13px; min-width: 180px; }
            .field-value { font-size: 14px; color: #333; flex: 1; }
            .highlight-box { background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 12px; margin: 16px 0; }
            .list-items { margin: 0; padding-left: 20px; }
            .list-items li { margin-bottom: 4px; }
            .footer { padding: 16px 24px; font-size: 11px; color: #666; border-top: 1px solid #eee; background-color: #f8f9fa; }
            .footer-note { color: #999; font-style: italic; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="urgent-badge">URGENT / HASTER</div>
              <h1>${icon} ${title}</h1>
            </div>
            <div class="content">
              <!-- Facility Information -->
              <div class="section">
                <div class="section-title">Facility Information / Anleggsinformasjon</div>
                <div class="field">
                  <span class="field-label">Site Name / Anleggsnavn:</span>
                  <span class="field-value"><strong>${escapeHtml(data.siteName)}</strong></span>
                </div>
                <div class="field">
                  <span class="field-label">Site Code / Anleggskode:</span>
                  <span class="field-value">${escapeHtml(data.siteCode)}</span>
                </div>
                <div class="field">
                  <span class="field-label">Lokalitetsnummer:</span>
                  <span class="field-value">${escapeHtml(data.lokalitetsnummer)}</span>
                </div>
                <div class="field">
                  <span class="field-label">Org.nummer:</span>
                  <span class="field-value">${escapeHtml(data.organisasjonsnummer)}</span>
                </div>
              </div>

              <!-- Event Details -->
              ${specificContent}

              <!-- Contact Information -->
              <div class="section">
                <div class="section-title">Contact Information / Kontaktinformasjon</div>
                <div class="field">
                  <span class="field-label">Contact Person / Kontaktperson:</span>
                  <span class="field-value">${escapeHtml(data.contactPerson)}</span>
                </div>
                <div class="field">
                  <span class="field-label">Email:</span>
                  <span class="field-value">${escapeHtml(data.contactEmail)}</span>
                </div>
                ${
                  data.contactPhone
                    ? `
                <div class="field">
                  <span class="field-label">Phone / Telefon:</span>
                  <span class="field-value">${escapeHtml(data.contactPhone)}</span>
                </div>
                `
                    : ''
                }
              </div>

              <!-- Report Metadata -->
              <div class="section">
                <div class="section-title">Report Details / Rapportdetaljer</div>
                <div class="field">
                  <span class="field-label">Detected At / Oppdaget:</span>
                  <span class="field-value">${escapeHtml(this.formatDateTime(data.detectedAt))}</span>
                </div>
                <div class="field">
                  <span class="field-label">Reported By / Rapportert av:</span>
                  <span class="field-value">${escapeHtml(data.reportedBy)}</span>
                </div>
                <div class="field">
                  <span class="field-label">Report Time / Rapporttidspunkt:</span>
                  <span class="field-value">${escapeHtml(this.formatDateTime(new Date()))}</span>
                </div>
              </div>
            </div>
            <div class="footer">
              <p><strong>This is an urgent regulatory notification sent to Mattilsynet.</strong></p>
              <p>Dette er en akutt regulatorisk varsling sendt til Mattilsynet.</p>
              <p class="footer-note">
                Generated by Aquaculture Platform | varsling.akva@mattilsynet.no
              </p>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  /**
   * Generate welfare event section HTML
   */
  private generateWelfareSection(
    data: NonNullable<RegulatoryReportEmailData['welfareData']>,
  ): string {
    return `
      <div class="section">
        <div class="section-title">Welfare Event Details / Velferdshendelsedetaljer</div>
        <div class="field">
          <span class="field-label">Event Type / Hendelsestype:</span>
          <span class="field-value">${escapeHtml(data.eventType)}</span>
        </div>
        <div class="field">
          <span class="field-label">Severity / Alvorlighetsgrad:</span>
          <span class="field-value" style="color: ${data.severity === 'critical' ? '#dc3545' : '#ff6600'}; font-weight: 600;">
            ${escapeHtml(data.severity.toUpperCase())}
          </span>
        </div>
        ${
          data.mortalityRate !== undefined
            ? `
        <div class="highlight-box">
          <div class="field">
            <span class="field-label">Mortality Rate / Dodelighet:</span>
            <span class="field-value"><strong>${escapeHtml(String(data.mortalityRate))}%</strong> (${escapeHtml(data.mortalityPeriod || 'N/A')})</span>
          </div>
        </div>
        `
            : ''
        }
        <div class="field">
          <span class="field-label">Description / Beskrivelse:</span>
          <span class="field-value">${escapeHtml(data.description)}</span>
        </div>
        ${
          data.affectedBatches && data.affectedBatches.length > 0
            ? `
        <div class="field">
          <span class="field-label">Affected Batches / Berorte partier:</span>
          <span class="field-value">${data.affectedBatches.map((b) => escapeHtml(b)).join(', ')}</span>
        </div>
        `
            : ''
        }
        <div class="field">
          <span class="field-label">Immediate Actions / Strakstiltak:</span>
          <span class="field-value">
            <ul class="list-items">
              ${data.immediateActions.map((action) => `<li>${escapeHtml(action)}</li>`).join('')}
            </ul>
          </span>
        </div>
      </div>
    `;
  }

  /**
   * Generate disease outbreak section HTML
   */
  private generateDiseaseSection(
    data: NonNullable<RegulatoryReportEmailData['diseaseData']>,
  ): string {
    const categoryDescriptions: Record<string, string> = {
      A: 'Liste A - Exotic Disease / Eksotisk sykdom',
      C: 'Liste C - Non-Exotic Notifiable / Meldepliktig ikke-eksotisk',
      F: 'Liste F - Other Notifiable / Annen meldepliktig',
    };

    return `
      <div class="section">
        <div class="section-title">Disease Outbreak Details / Sykdomsutbrudddetaljer</div>
        <div class="highlight-box" style="background-color: #ffebee; border-color: #f44336;">
          <div class="field">
            <span class="field-label">Disease / Sykdom:</span>
            <span class="field-value"><strong>${escapeHtml(data.diseaseName)}</strong></span>
          </div>
          <div class="field">
            <span class="field-label">Category / Kategori:</span>
            <span class="field-value">${escapeHtml(categoryDescriptions[data.diseaseCategory] || data.diseaseCategory)}</span>
          </div>
          <div class="field">
            <span class="field-label">Status:</span>
            <span class="field-value" style="color: ${data.confirmation === 'confirmed' ? '#dc3545' : '#ff6600'}; font-weight: 600;">
              ${data.confirmation === 'confirmed' ? 'LAB CONFIRMED / LABORATORIEBKREFTET' : 'SUSPECTED / MISTENKT'}
            </span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Affected Population / Berorte individer:</span>
          <span class="field-value">${escapeHtml(data.affectedCount.toLocaleString())} fish (${escapeHtml(String(data.affectedPercentage))}%)</span>
        </div>
        <div class="field">
          <span class="field-label">Clinical Signs / Kliniske tegn:</span>
          <span class="field-value">
            <ul class="list-items">
              ${data.clinicalSigns.map((sign) => `<li>${escapeHtml(sign)}</li>`).join('')}
            </ul>
          </span>
        </div>
        <div class="field">
          <span class="field-label">Veterinarian Notified / Veterinar varslet:</span>
          <span class="field-value">
            ${data.veterinarianNotified ? `Yes / Ja${data.veterinarianName ? ` - ${escapeHtml(data.veterinarianName)}` : ''}` : 'No / Nei'}
          </span>
        </div>
      </div>
    `;
  }

  /**
   * Generate escape incident section HTML
   */
  private generateEscapeSection(
    data: NonNullable<RegulatoryReportEmailData['escapeData']>,
  ): string {
    return `
      <div class="section">
        <div class="section-title">Escape Incident Details / Rommingshendelsedetaljer</div>
        <div class="highlight-box" style="background-color: #f3e5f5; border-color: #9c27b0;">
          <div class="field">
            <span class="field-label">Estimated Escaped / Anslatt romming:</span>
            <span class="field-value"><strong>${escapeHtml(data.estimatedCount.toLocaleString())} fish</strong></span>
          </div>
          <div class="field">
            <span class="field-label">Total Biomass / Total biomasse:</span>
            <span class="field-value"><strong>${escapeHtml(data.totalBiomassKg.toLocaleString())} kg</strong></span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Species / Art:</span>
          <span class="field-value">${escapeHtml(data.species)}</span>
        </div>
        <div class="field">
          <span class="field-label">Average Weight / Gjennomsnittsvekt:</span>
          <span class="field-value">${escapeHtml(String(data.avgWeightG))} g</span>
        </div>
        <div class="field">
          <span class="field-label">Cause / Arsak:</span>
          <span class="field-value">${escapeHtml(data.cause)}</span>
        </div>
        <div class="field">
          <span class="field-label">Affected Units / Berorte enheter:</span>
          <span class="field-value">${data.affectedUnits.map((u) => escapeHtml(u)).join(', ')}</span>
        </div>
        <div class="field">
          <span class="field-label">Recovery Ongoing / Bergingsoperasjon pagaar:</span>
          <span class="field-value">${data.recoveryOngoing ? 'Yes / Ja' : 'No / Nei'}</span>
        </div>
      </div>
    `;
  }

  /**
   * Format date for display
   */
  private formatDate(date: Date): string {
    // toISOString() always returns "YYYY-MM-DDTHH:mm:ss.sssZ"; split('T')[0] is
    // always defined for a valid Date, so no nullish fallback is needed.
    return date.toISOString().split('T')[0]!;
  }

  /**
   * Format date and time for display
   */
  private formatDateTime(date: Date): string {
    return date.toLocaleString('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }
}
