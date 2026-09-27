import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { HttpFailureClass } from '@aquaculture/backend-common/http';
import { maskEmail } from '@aquaculture/backend-common/utils';
import {
  renderEmail,
  emailRows,
  emailSection,
  emailButton,
  emailCallout,
  emailParagraph,
  emailLinkFallback,
  emailPlainText,
  type EmailRow,
  type EmailTone,
} from '@aquaculture/shared-contracts';

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

/** The alert severities the platform emits, mapped to the layout's tones. */
const ALERT_SEVERITY_TONE: Readonly<Record<string, EmailTone>> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
};

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

    return renderEmail({
      title: 'Welcome to Aquaculture Platform',
      subtitle: 'Your account has been created',
      preheader: `Set up your password for ${data.tenantName}`,
      body: [
        emailParagraph(`Hello ${escapeHtml(displayName)},`),
        emailParagraph(
          `You've been invited to join <strong>${escapeHtml(data.tenantName)}</strong> on Aquaculture Platform. Your account has been created and is ready for you to set up.`,
        ),
        emailRows([
          { label: 'Organization', value: data.tenantName },
          { label: 'Email', value: data.email },
          { label: 'Role', value: data.role.replace(/_/g, ' ') },
        ]),
        emailButton('Set Up Your Password', data.actionUrl),
        emailCallout(
          `<strong>Important:</strong> this link expires in ${expiresIn} days. Please set up your password before it does.`,
        ),
        emailLinkFallback(
          data.actionUrl,
          "If the button doesn't work, copy this link into your browser:",
        ),
      ].join('\n'),
      footerLines: [
        "If you didn't expect this email, please ignore it or contact your administrator.",
      ],
    });
  }

  /**
   * Generate alert email HTML template
   */
  private generateAlertEmailTemplate(data: AlertEmailData): string {
    const tone = ALERT_SEVERITY_TONE[data.severity] ?? 'info';
    const context: EmailRow[] = [
      { label: 'Alert Rule', value: data.ruleName },
      { label: 'Severity', value: data.severity.toUpperCase() },
    ];
    if (data.farmName) context.push({ label: 'Farm', value: data.farmName });
    if (data.pondName) context.push({ label: 'Pond', value: data.pondName });
    if (data.sensorId) context.push({ label: 'Sensor ID', value: data.sensorId });
    context.push({ label: 'Time', value: (data.timestamp || new Date()).toLocaleString() });

    return renderEmail({
      title: 'Alert Triggered',
      subtitle: data.ruleName,
      tone,
      preheader: data.message,
      body: [emailCallout(escapeHtml(data.message), tone), emailRows(context)].join('\n'),
      footerLines: ['Please do not reply to this email.'],
    });
  }

  /**
   * Strip HTML tags for plain text version
   */
  private stripHtml(html: string): string {
    return emailPlainText(html);
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
    const REPORT_TONE: Record<RegulatoryReportEmailData['reportType'], EmailTone> = {
      welfare: 'error',
      disease: 'warning',
      escape: 'info',
    };
    const REPORT_TITLE: Record<RegulatoryReportEmailData['reportType'], string> = {
      welfare: 'Welfare Event / Velferdsmelding',
      disease: 'Disease Outbreak / Sykdomsutbrudd',
      escape: 'Escape Incident / Rømmingshendelse',
    };

    const contact: EmailRow[] = [
      { label: 'Contact Person / Kontaktperson', value: data.contactPerson },
      { label: 'Email', value: data.contactEmail },
    ];
    if (data.contactPhone) contact.push({ label: 'Phone / Telefon', value: data.contactPhone });

    let eventSection = '';
    if (data.reportType === 'welfare' && data.welfareData) {
      eventSection = this.generateWelfareSection(data.welfareData);
    } else if (data.reportType === 'disease' && data.diseaseData) {
      eventSection = this.generateDiseaseSection(data.diseaseData);
    } else if (data.reportType === 'escape' && data.escapeData) {
      eventSection = this.generateEscapeSection(data.escapeData);
    }

    return renderEmail({
      title: REPORT_TITLE[data.reportType],
      subtitle: 'URGENT / HASTER',
      tone: REPORT_TONE[data.reportType],
      preheader: `${REPORT_TITLE[data.reportType]} — ${data.siteName}`,
      body: [
        emailSection('Facility Information / Anleggsinformasjon', [
          { label: 'Site Name / Anleggsnavn', value: data.siteName, strong: true },
          { label: 'Site Code / Anleggskode', value: data.siteCode },
          { label: 'Lokalitetsnummer', value: data.lokalitetsnummer },
          { label: 'Org.nummer', value: data.organisasjonsnummer },
        ]),
        eventSection,
        emailSection('Contact Information / Kontaktinformasjon', contact),
        emailSection('Report Details / Rapportdetaljer', [
          { label: 'Detected At / Oppdaget', value: this.formatDateTime(data.detectedAt) },
          { label: 'Reported By / Rapportert av', value: data.reportedBy },
          { label: 'Report Time / Rapporttidspunkt', value: this.formatDateTime(new Date()) },
        ]),
      ].join('\n'),
      footerLines: [
        'This is an urgent regulatory notification sent to Mattilsynet.',
        'Dette er en akutt regulatorisk varsling sendt til Mattilsynet.',
        'varsling.akva@mattilsynet.no',
      ],
    });
  }

  /**
   * Generate welfare event section
   */
  private generateWelfareSection(
    data: NonNullable<RegulatoryReportEmailData['welfareData']>,
  ): string {
    const rows: EmailRow[] = [
      { label: 'Event Type / Hendelsestype', value: data.eventType },
      {
        label: 'Severity / Alvorlighetsgrad',
        value: data.severity.toUpperCase(),
        tone: data.severity === 'critical' ? 'error' : 'warning',
      },
    ];
    if (data.mortalityRate !== undefined) {
      rows.push({
        label: 'Mortality Rate / Dødelighet',
        value: `${data.mortalityRate}% (${data.mortalityPeriod || 'N/A'})`,
        strong: true,
      });
    }
    rows.push({ label: 'Description / Beskrivelse', value: data.description });
    if (data.affectedBatches && data.affectedBatches.length > 0) {
      rows.push({ label: 'Affected Batches / Berørte partier', items: data.affectedBatches });
    }
    rows.push({ label: 'Immediate Actions / Strakstiltak', items: data.immediateActions });

    return emailSection('Welfare Event Details / Velferdshendelsedetaljer', rows);
  }

  /**
   * Generate disease outbreak section
   */
  private generateDiseaseSection(
    data: NonNullable<RegulatoryReportEmailData['diseaseData']>,
  ): string {
    const categoryDescriptions: Record<string, string> = {
      A: 'Liste A - Exotic Disease / Eksotisk sykdom',
      C: 'Liste C - Non-Exotic Notifiable / Meldepliktig ikke-eksotisk',
      F: 'Liste F - Other Notifiable / Annen meldepliktig',
    };
    const confirmed = data.confirmation === 'confirmed';

    return emailSection('Disease Outbreak Details / Sykdomsutbruddetaljer', [
      { label: 'Disease / Sykdom', value: data.diseaseName, strong: true },
      {
        label: 'Category / Kategori',
        value: categoryDescriptions[data.diseaseCategory] || data.diseaseCategory,
      },
      {
        label: 'Status',
        value: confirmed ? 'LAB CONFIRMED / LABORATORIEBEKREFTET' : 'SUSPECTED / MISTENKT',
        tone: confirmed ? 'error' : 'warning',
      },
      {
        label: 'Affected Population / Berørte individer',
        value: `${data.affectedCount.toLocaleString()} fish (${data.affectedPercentage}%)`,
      },
      { label: 'Clinical Signs / Kliniske tegn', items: data.clinicalSigns },
      {
        label: 'Veterinarian Notified / Veterinær varslet',
        value: data.veterinarianNotified
          ? `Yes / Ja${data.veterinarianName ? ` - ${data.veterinarianName}` : ''}`
          : 'No / Nei',
      },
    ]);
  }

  /**
   * Generate escape incident section
   */
  private generateEscapeSection(
    data: NonNullable<RegulatoryReportEmailData['escapeData']>,
  ): string {
    return emailSection('Escape Incident Details / Rømmingshendelsedetaljer', [
      {
        label: 'Estimated Escaped / Anslått rømming',
        value: `${data.estimatedCount.toLocaleString()} fish`,
        strong: true,
      },
      {
        label: 'Total Biomass / Total biomasse',
        value: `${data.totalBiomassKg.toLocaleString()} kg`,
        strong: true,
      },
      { label: 'Species / Art', value: data.species },
      { label: 'Average Weight / Gjennomsnittsvekt', value: `${data.avgWeightG} g` },
      { label: 'Cause / Årsak', value: data.cause },
      { label: 'Affected Units / Berørte enheter', items: data.affectedUnits },
      {
        label: 'Recovery Ongoing / Bergingsoperasjon pågår',
        value: data.recoveryOngoing ? 'Yes / Ja' : 'No / Nei',
      },
    ]);
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
