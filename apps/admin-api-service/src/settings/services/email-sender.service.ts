import * as crypto from 'crypto';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

import { SystemSettingService } from './system-setting.service';

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  attempts?: number;
  circuitBreakerOpen?: boolean;
}

export interface EmailSendOptions {
  /** If true, throws an error when email cannot be sent (default: false) */
  required?: boolean;
  /** Maximum number of retry attempts (default: 1, max: 5) */
  maxRetries?: number;
  /** Base delay in ms between retries - uses exponential backoff (default: 1000) */
  retryDelayMs?: number;
}

interface SmtpSendResult {
  messageId?: unknown;
}

/** SMTP circuit breaker state */
/**
 * Circuit-breaker states.
 *
 * Exported because the health endpoint publishes this value: it used to widen
 * to `string` on the way out, and the admin panel then re-declared the union by
 * hand — narrower than `string` and with nothing holding the two together.
 */
export enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/** One breaker's observable state. */
export interface CircuitBreakerInfo {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  lastFailureTime: number;
}

/**
 * Email Sender Service
 * Sends emails using SMTP configuration from system settings.
 * Includes circuit breaker to prevent cascading failures when SMTP is down.
 */
@Injectable()
export class EmailSenderService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailSenderService.name);
  private transporter: nodemailer.Transporter | null = null;
  private lastConfigHash = '';

  /** SMTP send timeout in ms */
  private static readonly SEND_TIMEOUT_MS = 30_000;

  // Circuit breaker state
  private circuitState: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private static readonly FAILURE_THRESHOLD = 5;
  private static readonly RECOVERY_TIMEOUT_MS = 60_000; // 1 minute before half-open

  constructor(
    private readonly settingsService: SystemSettingService,
  ) {}

  onModuleDestroy(): void {
    if (this.transporter) {
      this.transporter.close();
      this.logger.log('SMTP transporter closed');
    }
  }

  /** Get current circuit breaker status (for health checks) */
  getCircuitStatus(): CircuitBreakerInfo {
    return {
      state: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  private isCircuitOpen(): boolean {
    if (this.circuitState === CircuitBreakerState.CLOSED) {
      return false;
    }

    if (this.circuitState === CircuitBreakerState.OPEN) {
      // Check if recovery timeout has elapsed — transition to half-open
      if (Date.now() - this.lastFailureTime >= EmailSenderService.RECOVERY_TIMEOUT_MS) {
        this.circuitState = CircuitBreakerState.HALF_OPEN;
        this.logger.log('SMTP circuit breaker transitioning to half-open');
        return false; // Allow one test request
      }
      return true;
    }

    // HALF_OPEN — allow request through
    return false;
  }

  private recordSuccess(): void {
    if (this.circuitState !== CircuitBreakerState.CLOSED) {
      this.logger.log('SMTP circuit breaker closed (recovery successful)');
    }
    this.circuitState = CircuitBreakerState.CLOSED;
    this.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.circuitState === CircuitBreakerState.HALF_OPEN) {
      this.circuitState = CircuitBreakerState.OPEN;
      this.logger.warn('SMTP circuit breaker re-opened (half-open test failed)');
    } else if (this.consecutiveFailures >= EmailSenderService.FAILURE_THRESHOLD) {
      this.circuitState = CircuitBreakerState.OPEN;
      this.logger.warn(
        `SMTP circuit breaker opened after ${this.consecutiveFailures} consecutive failures`,
      );
    }
  }

  /**
   * Initialize or reinitialize transporter with current SMTP settings
   */
  private initializeTransporter(): boolean {
    try {
      const config = this.settingsService.getEmailConfigForSending();

      // Create a hash of config to detect changes
      const configHash = JSON.stringify({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        user: config.smtpUsername,
        passHash: crypto.createHash('sha256').update(config.smtpPassword || '').digest('hex'),
      });

      // Skip if already initialized with same config
      if (this.transporter && this.lastConfigHash === configHash) {
        return true;
      }

      if (!config.smtpHost) {
        this.logger.warn('SMTP host not configured, email service will not work');
        if (this.transporter) {
          this.transporter.close();
        }
        this.transporter = null;
        this.lastConfigHash = '';
        return false;
      }

      if (this.transporter) {
        this.transporter.close();
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

    // Circuit breaker check — fail fast if SMTP is known to be down
    if (this.isCircuitOpen()) {
      const errorMsg = 'SMTP circuit breaker is open. Email delivery temporarily suspended.';
      this.logger.warn(`Email not sent (circuit open): ${subject} to ${to}`);

      if (required) {
        throw new Error(errorMsg);
      }

      return {
        success: false,
        error: errorMsg,
        attempts: 0,
        circuitBreakerOpen: true,
      };
    }

    // Validate retry count
    const effectiveMaxRetries = Math.min(Math.max(1, maxRetries), 5);

    const initialized = this.initializeTransporter();

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
        const config = this.settingsService.getEmailConfigForSending();
        const fromAddress = config.fromAddress || 'noreply@aquaculture.io';
        const fromName = config.fromName || 'Aquaculture Platform';

        const result = await this.sendMailWithTimeout(
          {
            from: `"${fromName}" <${fromAddress}>`,
            to,
            subject,
            html,
            text: text || this.stripHtml(html),
          },
          EmailSenderService.SEND_TIMEOUT_MS,
        );

        const messageId = this.readMessageId(result.messageId);
        this.recordSuccess();
        this.logger.log(`Email sent to ${to}: ${messageId} (attempt ${attempt}/${effectiveMaxRetries})`);
        return {
          success: true,
          messageId,
          attempts,
        };
      } catch (error) {
        lastError = error as Error;
        this.recordFailure();
        this.logger.warn(
          `Email attempt ${attempt}/${effectiveMaxRetries} failed for ${to}: ${lastError.message}`,
        );

        // If circuit just opened, stop retrying immediately
        if (this.circuitState === CircuitBreakerState.OPEN) {
          break;
        }

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
      `Failed to send email to ${to} after ${attempts} attempts: ${errorMessage}`,
    );

    if (required) {
      throw new Error(`Failed to send email after ${attempts} attempts: ${errorMessage}`);
    }

    return {
      success: false,
      error: errorMessage,
      attempts,
    };
  }

  /**
   * Send mail with a timeout to prevent hanging on unresponsive SMTP servers
   */
  private sendMailWithTimeout(
    mailOptions: nodemailer.SendMailOptions,
    timeoutMs: number,
  ): Promise<SmtpSendResult> {
    return new Promise((resolve, reject) => {
      const transporter = this.transporter;
      if (!transporter) {
        reject(new Error('SMTP transporter is not initialized'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`SMTP sendMail timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      transporter.sendMail(mailOptions)
        .then((result: unknown) => {
          clearTimeout(timer);
          resolve(this.toSmtpSendResult(result));
        })
        .catch((error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private toSmtpSendResult(value: unknown): SmtpSendResult {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value;
    }
    return {};
  }

  private readMessageId(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  /**
   * Helper to sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  /** Manually reset the circuit breaker to CLOSED state */
  resetCircuit(): void {
    const previousState = this.circuitState;
    this.circuitState = CircuitBreakerState.CLOSED;
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.logger.log(`SMTP circuit breaker manually reset from ${previousState} to closed`);
  }

  /**
   * Test SMTP configuration.
   * A successful test also resets the circuit breaker, allowing email flow to resume.
   */
  async testConnection(): Promise<EmailResult> {
    const initialized = this.initializeTransporter();

    if (!initialized || !this.transporter) {
      return {
        success: false,
        error: 'SMTP not configured',
      };
    }

    try {
      await this.transporter.verify();
      this.recordSuccess();
      this.logger.log('SMTP connection verified successfully');
      return { success: true };
    } catch (error) {
      this.recordFailure();
      this.logger.error(`SMTP connection test failed: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }
}
