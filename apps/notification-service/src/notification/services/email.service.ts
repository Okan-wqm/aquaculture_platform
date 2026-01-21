import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * HTML escape function to prevent XSS in email templates
 * Escapes <, >, &, ", and ' characters
 */
function escapeHtml(str: string | undefined | null): string {
  if (str === null || str === undefined) {
    return '';
  }
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
 * Email Service
 * Handles email notifications using nodemailer
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly fromAddress: string;
  private readonly isEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.fromAddress = this.configService.get(
      'SMTP_FROM',
      'noreply@aquaculture-platform.com',
    );
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
    });

    this.logger.log(`Email service initialized with SMTP host: ${host}`);
  }

  /**
   * Send a generic email
   */
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    text?: string,
  ): Promise<string> {
    if (!this.transporter) {
      this.logger.warn(`Email not sent (disabled): ${subject} to ${to}`);
      return `mock-${Date.now()}`;
    }

    try {
      const result = await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        html,
        text: text || this.stripHtml(html),
      });

      this.logger.log(`Email sent to ${to}: ${result.messageId}`);
      return result.messageId;
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${to}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Send an alert notification email
   */
  async sendAlertEmail(to: string, alertData: AlertEmailData): Promise<string> {
    const subject = `[${alertData.severity.toUpperCase()}] ${alertData.ruleName}`;
    const html = this.generateAlertEmailTemplate(alertData);

    return await this.sendEmail(to, subject, html);
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
              <h1>⚠️ Alert Triggered</h1>
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
              ${data.farmName ? `
              <div class="field">
                <div class="field-label">Farm</div>
                <div class="field-value">${escapeHtml(data.farmName)}</div>
              </div>
              ` : ''}
              ${data.pondName ? `
              <div class="field">
                <div class="field-label">Pond</div>
                <div class="field-value">${escapeHtml(data.pondName)}</div>
              </div>
              ` : ''}
              ${data.sensorId ? `
              <div class="field">
                <div class="field-label">Sensor ID</div>
                <div class="field-value">${escapeHtml(data.sensorId)}</div>
              </div>
              ` : ''}
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
   * Send a regulatory report email to Mattilsynet
   * Used for welfare events, disease outbreaks, and escape reports
   */
  async sendRegulatoryReportEmail(
    data: RegulatoryReportEmailData,
  ): Promise<{ messageId: string; sentTo: string[] }> {
    const reportTitles = {
      welfare: 'Refah Olayı Bildirimi / Welfare Event Report',
      disease: 'Hastalık Salgını Bildirimi / Disease Outbreak Report',
      escape: 'Kaçış Bildirimi / Escape Report',
    };

    const subject = `[URGENT] ${reportTitles[data.reportType]} - ${data.siteName} - ${this.formatDate(data.detectedAt)}`;
    const html = this.generateRegulatoryReportTemplate(data);

    const recipients = [MATTILSYNET_URGENT_EMAIL];
    if (data.siteManagerEmail) {
      recipients.push(data.siteManagerEmail);
    }

    const messageId = await this.sendEmail(
      recipients.join(', '),
      subject,
      html,
    );

    this.logger.log(
      `Regulatory report email sent: ${data.reportType} for ${data.siteName}`,
    );

    return { messageId, sentTo: recipients };
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
      welfare: '#dc3545',   // Red
      disease: '#ff6600',   // Orange
      escape: '#9c27b0',    // Purple
    };

    const reportIcons = {
      welfare: '🐟',
      disease: '🦠',
      escape: '🚨',
    };

    const reportTitles = {
      welfare: 'WELFARE EVENT / REFAH OLAYI',
      disease: 'DISEASE OUTBREAK / HASTALIK SALGINI',
      escape: 'ESCAPE INCIDENT / KAÇIŞ OLAYI',
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
              <div class="urgent-badge">URGENT / ACİL</div>
              <h1>${icon} ${title}</h1>
            </div>
            <div class="content">
              <!-- Facility Information -->
              <div class="section">
                <div class="section-title">Facility Information / Tesis Bilgileri</div>
                <div class="field">
                  <span class="field-label">Site Name / Tesis Adı:</span>
                  <span class="field-value"><strong>${escapeHtml(data.siteName)}</strong></span>
                </div>
                <div class="field">
                  <span class="field-label">Site Code / Tesis Kodu:</span>
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
                <div class="section-title">Contact Information / İletişim Bilgileri</div>
                <div class="field">
                  <span class="field-label">Contact Person / İlgili Kişi:</span>
                  <span class="field-value">${escapeHtml(data.contactPerson)}</span>
                </div>
                <div class="field">
                  <span class="field-label">Email:</span>
                  <span class="field-value">${escapeHtml(data.contactEmail)}</span>
                </div>
                ${data.contactPhone ? `
                <div class="field">
                  <span class="field-label">Phone / Telefon:</span>
                  <span class="field-value">${escapeHtml(data.contactPhone)}</span>
                </div>
                ` : ''}
              </div>

              <!-- Report Metadata -->
              <div class="section">
                <div class="section-title">Report Details / Rapor Detayları</div>
                <div class="field">
                  <span class="field-label">Detected At / Tespit Zamanı:</span>
                  <span class="field-value">${escapeHtml(this.formatDateTime(data.detectedAt))}</span>
                </div>
                <div class="field">
                  <span class="field-label">Reported By / Raporlayan:</span>
                  <span class="field-value">${escapeHtml(data.reportedBy)}</span>
                </div>
                <div class="field">
                  <span class="field-label">Report Time / Rapor Zamanı:</span>
                  <span class="field-value">${escapeHtml(this.formatDateTime(new Date()))}</span>
                </div>
              </div>
            </div>
            <div class="footer">
              <p><strong>This is an urgent regulatory notification sent to Mattilsynet.</strong></p>
              <p>Bu acil düzenleyici bildirim Mattilsynet'e gönderilmiştir.</p>
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
  private generateWelfareSection(data: NonNullable<RegulatoryReportEmailData['welfareData']>): string {
    return `
      <div class="section">
        <div class="section-title">Welfare Event Details / Refah Olayı Detayları</div>
        <div class="field">
          <span class="field-label">Event Type / Olay Türü:</span>
          <span class="field-value">${escapeHtml(data.eventType)}</span>
        </div>
        <div class="field">
          <span class="field-label">Severity / Şiddet:</span>
          <span class="field-value" style="color: ${data.severity === 'critical' ? '#dc3545' : '#ff6600'}; font-weight: 600;">
            ${escapeHtml(data.severity.toUpperCase())}
          </span>
        </div>
        ${data.mortalityRate !== undefined ? `
        <div class="highlight-box">
          <div class="field">
            <span class="field-label">Mortality Rate / Ölüm Oranı:</span>
            <span class="field-value"><strong>${escapeHtml(String(data.mortalityRate))}%</strong> (${escapeHtml(data.mortalityPeriod || 'N/A')})</span>
          </div>
        </div>
        ` : ''}
        <div class="field">
          <span class="field-label">Description / Açıklama:</span>
          <span class="field-value">${escapeHtml(data.description)}</span>
        </div>
        ${data.affectedBatches && data.affectedBatches.length > 0 ? `
        <div class="field">
          <span class="field-label">Affected Batches / Etkilenen Partiler:</span>
          <span class="field-value">${data.affectedBatches.map(b => escapeHtml(b)).join(', ')}</span>
        </div>
        ` : ''}
        <div class="field">
          <span class="field-label">Immediate Actions / Alınan Önlemler:</span>
          <span class="field-value">
            <ul class="list-items">
              ${data.immediateActions.map(action => `<li>${escapeHtml(action)}</li>`).join('')}
            </ul>
          </span>
        </div>
      </div>
    `;
  }

  /**
   * Generate disease outbreak section HTML
   */
  private generateDiseaseSection(data: NonNullable<RegulatoryReportEmailData['diseaseData']>): string {
    const categoryDescriptions: Record<string, string> = {
      A: 'Liste A - Exotic Disease / Egzotik Hastalık',
      C: 'Liste C - Non-Exotic Notifiable / Bildirilmesi Zorunlu',
      F: 'Liste F - Other Notifiable / Diğer Bildirilebilir',
    };

    return `
      <div class="section">
        <div class="section-title">Disease Outbreak Details / Hastalık Salgını Detayları</div>
        <div class="highlight-box" style="background-color: #ffebee; border-color: #f44336;">
          <div class="field">
            <span class="field-label">Disease / Hastalık:</span>
            <span class="field-value"><strong>${escapeHtml(data.diseaseName)}</strong></span>
          </div>
          <div class="field">
            <span class="field-label">Category / Kategori:</span>
            <span class="field-value">${escapeHtml(categoryDescriptions[data.diseaseCategory] || data.diseaseCategory)}</span>
          </div>
          <div class="field">
            <span class="field-label">Status / Durum:</span>
            <span class="field-value" style="color: ${data.confirmation === 'confirmed' ? '#dc3545' : '#ff6600'}; font-weight: 600;">
              ${data.confirmation === 'confirmed' ? 'LAB CONFIRMED / LABORATUVAR ONAYLI' : 'SUSPECTED / ŞÜPHELİ'}
            </span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Affected Population / Etkilenen Popülasyon:</span>
          <span class="field-value">${escapeHtml(data.affectedCount.toLocaleString())} fish (${escapeHtml(String(data.affectedPercentage))}%)</span>
        </div>
        <div class="field">
          <span class="field-label">Clinical Signs / Klinik Belirtiler:</span>
          <span class="field-value">
            <ul class="list-items">
              ${data.clinicalSigns.map(sign => `<li>${escapeHtml(sign)}</li>`).join('')}
            </ul>
          </span>
        </div>
        <div class="field">
          <span class="field-label">Veterinarian Notified / Veteriner Bilgilendirildi:</span>
          <span class="field-value">
            ${data.veterinarianNotified ? `Yes / Evet${data.veterinarianName ? ` - ${escapeHtml(data.veterinarianName)}` : ''}` : 'No / Hayır'}
          </span>
        </div>
      </div>
    `;
  }

  /**
   * Generate escape incident section HTML
   */
  private generateEscapeSection(data: NonNullable<RegulatoryReportEmailData['escapeData']>): string {
    return `
      <div class="section">
        <div class="section-title">Escape Incident Details / Kaçış Olayı Detayları</div>
        <div class="highlight-box" style="background-color: #f3e5f5; border-color: #9c27b0;">
          <div class="field">
            <span class="field-label">Estimated Escaped / Tahmini Kaçan:</span>
            <span class="field-value"><strong>${escapeHtml(data.estimatedCount.toLocaleString())} fish</strong></span>
          </div>
          <div class="field">
            <span class="field-label">Total Biomass / Toplam Biyokütle:</span>
            <span class="field-value"><strong>${escapeHtml(data.totalBiomassKg.toLocaleString())} kg</strong></span>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Species / Tür:</span>
          <span class="field-value">${escapeHtml(data.species)}</span>
        </div>
        <div class="field">
          <span class="field-label">Average Weight / Ortalama Ağırlık:</span>
          <span class="field-value">${escapeHtml(String(data.avgWeightG))} g</span>
        </div>
        <div class="field">
          <span class="field-label">Cause / Sebep:</span>
          <span class="field-value">${escapeHtml(data.cause)}</span>
        </div>
        <div class="field">
          <span class="field-label">Affected Units / Etkilenen Üniteler:</span>
          <span class="field-value">${data.affectedUnits.map(u => escapeHtml(u)).join(', ')}</span>
        </div>
        <div class="field">
          <span class="field-label">Recovery Ongoing / Kurtarma Devam Ediyor:</span>
          <span class="field-value">${data.recoveryOngoing ? 'Yes / Evet' : 'No / Hayır'}</span>
        </div>
      </div>
    `;
  }

  /**
   * Format date for display
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
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
