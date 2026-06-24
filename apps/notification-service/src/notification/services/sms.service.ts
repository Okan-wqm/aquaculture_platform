import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { createAbortSignalTimeout } from '@aquaculture/backend-common/utils';

/**
 * Mask phone number for logging (shows last 4 digits only)
 */
function maskPhoneNumber(phoneNumber: string): string {
  if (phoneNumber.length <= 4) {
    return '***';
  }
  return '***' + phoneNumber.slice(-4);
}

/**
 * SMS Service
 * Handles SMS notifications via multiple providers.
 *
 * Implemented providers:
 * - mock:   Logs SMS to console (development/testing)
 * - twilio: Sends via Twilio REST API using HTTP fetch (no SDK dependency)
 *
 * Planned providers:
 * - aws_sns: Amazon SNS SMS
 *
 * Configuration env vars:
 * - SMS_ENABLED=true/false
 * - SMS_PROVIDER=mock|twilio|aws_sns
 * - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (when provider=twilio)
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly isEnabled: boolean;
  private readonly provider: string;
  private readonly isProduction: boolean;
  private providerHealthy = true;

  // Twilio configuration (loaded from env when provider=twilio)
  private readonly twilioAccountSid?: string;
  private readonly twilioAuthToken?: string;
  private readonly twilioFromNumber?: string;

  // Supported providers that have actual implementations
  private static readonly IMPLEMENTED_PROVIDERS = ['mock', 'twilio'];
  private static readonly PLANNED_PROVIDERS = ['aws_sns'];

  constructor(
    private readonly configService: ConfigService,
    // CIRCUIT-HIGH-005 cure: Twilio SMS API is a billable external
    // upstream. Wrapping every call in the canonical
    // sliding-window breaker isolates Twilio outages (notably common,
    // Twilio publishes a status page with frequent partial-region
    // degradations) from the rest of the service. Per-tenant keying
    // is preferred but sendSms() doesn't carry tenantId today;
    // serviceName-only key still gives time-window protection. A
    // future refactor will plumb tenantId through the SMS call site.
    @Optional() private readonly breaker?: CircuitBreakerService,
  ) {
    this.isEnabled = this.configService.get('SMS_ENABLED', 'false') === 'true';
    this.provider = this.configService.get('SMS_PROVIDER', 'mock');
    this.isProduction = this.configService.get('NODE_ENV') === 'production';

    // Load Twilio configuration if provider is twilio
    if (this.provider === 'twilio') {
      this.twilioAccountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
      this.twilioAuthToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
      this.twilioFromNumber = this.configService.get<string>('TWILIO_FROM_NUMBER');
    }

    // SECURITY: Validate configuration at startup
    this.validateConfiguration();

    if (this.isEnabled) {
      this.logger.log(`SMS service initialized with provider: ${this.provider}`);
    } else {
      this.logger.warn('SMS service is disabled');
    }
  }

  /**
   * Validate SMS configuration at startup
   * Warns if non-implemented provider is configured
   */
  private validateConfiguration(): void {
    if (!this.isEnabled) {
      return;
    }

    const isImplemented = SmsService.IMPLEMENTED_PROVIDERS.includes(this.provider);
    const isPlanned = SmsService.PLANNED_PROVIDERS.includes(this.provider);

    if (!isImplemented && !isPlanned) {
      this.logger.error(
        `Unknown SMS provider configured: ${this.provider}. ` +
          `Valid options: ${[...SmsService.IMPLEMENTED_PROVIDERS, ...SmsService.PLANNED_PROVIDERS].join(', ')}`,
      );
      this.providerHealthy = false;
    }

    if (isPlanned && !isImplemented) {
      const message =
        `SMS provider '${this.provider}' is configured but not yet implemented. ` +
        `Falling back to mock provider. Set SMS_PROVIDER=mock to silence this warning.`;

      if (this.isProduction) {
        // CRITICAL: In production, log error and mark unhealthy
        this.logger.error(`PRODUCTION WARNING: ${message}`);
        this.providerHealthy = false;
      } else {
        this.logger.warn(message);
      }
    }

    // Validate Twilio-specific configuration
    if (this.provider === 'twilio') {
      if (!this.twilioAccountSid || !this.twilioAuthToken || !this.twilioFromNumber) {
        const missing = [
          !this.twilioAccountSid && 'TWILIO_ACCOUNT_SID',
          !this.twilioAuthToken && 'TWILIO_AUTH_TOKEN',
          !this.twilioFromNumber && 'TWILIO_FROM_NUMBER',
        ]
          .filter(Boolean)
          .join(', ');

        this.logger.error(
          `Twilio SMS provider is missing required env vars: ${missing}. ` +
            `SMS sending will fail until these are configured.`,
        );
        this.providerHealthy = false;
      }
    }
  }

  /**
   * Check if SMS provider is healthy
   */
  isHealthy(): boolean {
    return this.providerHealthy;
  }

  /**
   * Get provider status for health checks
   */
  getProviderStatus(): {
    provider: string;
    enabled: boolean;
    healthy: boolean;
    implemented: boolean;
  } {
    return {
      provider: this.provider,
      enabled: this.isEnabled,
      healthy: this.providerHealthy,
      implemented: SmsService.IMPLEMENTED_PROVIDERS.includes(this.provider),
    };
  }

  /**
   * Send an SMS message
   */
  async sendSms(phoneNumber: string, message: string): Promise<string> {
    if (!this.isEnabled) {
      this.logger.warn(`SMS not sent (disabled): to ${maskPhoneNumber(phoneNumber)}`);
      return `mock-sms-${Date.now()}`;
    }

    // Validate phone number format
    const cleanedNumber = this.cleanPhoneNumber(phoneNumber);
    if (!this.isValidPhoneNumber(cleanedNumber)) {
      // Don't log the full invalid phone number
      throw new Error('Invalid phone number format');
    }

    // Truncate message if too long (SMS limit is typically 160 chars)
    const truncatedMessage = this.truncateMessage(message, 160);
    const wasTruncated = message.length > 160;
    if (wasTruncated) {
      this.logger.warn(`SMS message truncated from ${message.length} to 160 characters`);
    }

    try {
      let messageId: string;

      switch (this.provider) {
        case 'twilio':
          messageId = await this.sendViaTwilio(cleanedNumber, truncatedMessage);
          break;
        case 'aws_sns':
          messageId = await this.sendViaAwsSns(cleanedNumber, truncatedMessage);
          break;
        case 'mock':
        default:
          messageId = await this.sendViaMock(cleanedNumber, truncatedMessage);
          break;
      }

      // Log with masked phone number for privacy
      this.logger.log(`SMS sent to ${maskPhoneNumber(cleanedNumber)}: ${messageId}`);
      return messageId;
    } catch (error) {
      this.logger.error(
        `Failed to send SMS to ${maskPhoneNumber(cleanedNumber)}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Send alert SMS
   */
  async sendAlertSms(
    phoneNumber: string,
    alertData: {
      ruleName: string;
      severity: string;
      message: string;
    },
  ): Promise<string> {
    const smsContent = `[${alertData.severity.toUpperCase()}] ${alertData.ruleName}: ${alertData.message}`;
    return await this.sendSms(phoneNumber, smsContent);
  }

  /**
   * Mock SMS provider (for development/testing)
   */
  private async sendViaMock(phoneNumber: string, message: string): Promise<string> {
    // Don't log full phone number or message content for privacy
    this.logger.debug(
      `[MOCK SMS] To: ${maskPhoneNumber(phoneNumber)}, Length: ${message.length} chars`,
    );
    return `mock-sms-${Date.now()}`;
  }

  /**
   * Twilio SMS provider -- uses the Twilio REST API directly via HTTP fetch.
   * No external SDK dependency required.
   *
   * API docs: https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource
   */
  private async sendViaTwilio(phoneNumber: string, message: string): Promise<string> {
    if (!this.twilioAccountSid || !this.twilioAuthToken || !this.twilioFromNumber) {
      throw new Error(
        'Twilio SMS provider is not configured. ' +
          'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER env vars.',
      );
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.twilioAccountSid}/Messages.json`;

    // Twilio uses HTTP Basic Auth: accountSid:authToken
    const authHeader =
      'Basic ' + Buffer.from(`${this.twilioAccountSid}:${this.twilioAuthToken}`).toString('base64');

    const body = new URLSearchParams({
      To: phoneNumber,
      From: this.twilioFromNumber,
      Body: message,
    });

    const timeout = createAbortSignalTimeout(15000);

    try {
      // CIRCUIT-HIGH-005 cure: Twilio call rides through the canonical
      // sliding-window breaker. fail-CLOSED for billable boundary —
      // a degraded SMS upstream must NOT silently substitute a no-op
      // (the user thinks the SMS sent; it didn't). Caller's existing
      // error path (the throw on response.ok=false below) handles
      // CircuitOpenError identically because it's just an Error
      // subclass — the catch around this block already converts to
      // operator-friendly logging.
      const fetchResponse = this.breaker
        ? await this.breaker.execute({
            serviceName: 'twilio-sms',
            options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
            fn: () =>
              fetch(url, {
                method: 'POST',
                headers: {
                  Authorization: authHeader,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
                signal: timeout.signal,
              }),
          })
        : await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
            signal: timeout.signal,
          });
      const response = fetchResponse;

      const responseBody = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        const twilioError = (responseBody['message'] as string) || `HTTP ${response.status}`;
        const errorCode = responseBody['code'] || 'unknown';
        throw new Error(`Twilio API error (${errorCode}): ${twilioError}`);
      }

      const sid = responseBody['sid'] as string;
      if (!sid) {
        throw new Error('Twilio response missing message SID');
      }

      this.logger.debug(`Twilio SMS sent to ${maskPhoneNumber(phoneNumber)}: ${sid}`);

      return sid;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error('Twilio API request timed out after 15 seconds');
      }

      throw error;
    } finally {
      timeout.clear();
    }
  }

  /**
   * AWS SNS SMS provider (placeholder - implement when needed)
   */
  private async sendViaAwsSns(_phoneNumber: string, _message: string): Promise<string> {
    // TODO: Implement AWS SNS integration
    // const sns = new AWS.SNS();
    // const result = await sns.publish({ PhoneNumber: phoneNumber, Message: message }).promise();
    // return result.MessageId;

    throw new Error(
      'AWS SNS SMS provider is not yet implemented. Set SMS_PROVIDER=mock or implement AWS SNS integration.',
    );
  }

  /**
   * Clean phone number (remove spaces, dashes, etc.)
   */
  private cleanPhoneNumber(phoneNumber: string): string {
    return phoneNumber.replace(/[\s\-().]/g, '');
  }

  /**
   * Validate phone number format
   */
  private isValidPhoneNumber(phoneNumber: string): boolean {
    // Require strict E.164 format: mandatory '+' country code prefix followed by 10-15 digits.
    // The leading '+' is required so providers (Twilio, AWS SNS) interpret the number
    // unambiguously rather than as a local/domestic number relative to the sender's country.
    return /^\+[1-9]\d{9,14}$/.test(phoneNumber);
  }

  /**
   * Truncate message to fit SMS limit
   */
  private truncateMessage(message: string, maxLength: number): string {
    if (message.length <= maxLength) {
      return message;
    }
    return message.substring(0, maxLength - 3) + '...';
  }
}
