import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
 * Handles SMS notifications
 * Currently implements a mock provider - can be extended for Twilio, AWS SNS, etc.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly isEnabled: boolean;
  private readonly provider: string;
  private readonly isProduction: boolean;
  private providerHealthy = true;

  // Supported providers that have actual implementations
  private static readonly IMPLEMENTED_PROVIDERS = ['mock'];
  private static readonly PLANNED_PROVIDERS = ['twilio', 'aws_sns'];

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get('SMS_ENABLED', 'false') === 'true';
    this.provider = this.configService.get('SMS_PROVIDER', 'mock');
    this.isProduction = this.configService.get('NODE_ENV') === 'production';

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
      const message = `SMS provider '${this.provider}' is configured but not yet implemented. ` +
        `Falling back to mock provider. Set SMS_PROVIDER=mock to silence this warning.`;

      if (this.isProduction) {
        // CRITICAL: In production, log error and mark unhealthy
        this.logger.error(`PRODUCTION WARNING: ${message}`);
        this.providerHealthy = false;
      } else {
        this.logger.warn(message);
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
  getProviderStatus(): { provider: string; enabled: boolean; healthy: boolean; implemented: boolean } {
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
  private async sendViaMock(
    phoneNumber: string,
    message: string,
  ): Promise<string> {
    // Don't log full phone number or message content for privacy
    this.logger.debug(`[MOCK SMS] To: ${maskPhoneNumber(phoneNumber)}, Length: ${message.length} chars`);
    return `mock-sms-${Date.now()}`;
  }

  /**
   * Twilio SMS provider (placeholder - implement when needed)
   */
  private async sendViaTwilio(
    _phoneNumber: string,
    _message: string,
  ): Promise<string> {
    // TODO: Implement Twilio integration
    // const client = require('twilio')(accountSid, authToken);
    // const result = await client.messages.create({ body: message, from: fromNumber, to: phoneNumber });
    // return result.sid;

    throw new Error(
      'Twilio SMS provider is not yet implemented. Set SMS_PROVIDER=mock or implement Twilio integration.',
    );
  }

  /**
   * AWS SNS SMS provider (placeholder - implement when needed)
   */
  private async sendViaAwsSns(
    _phoneNumber: string,
    _message: string,
  ): Promise<string> {
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
    return phoneNumber.replace(/[\s\-\(\)\.]/g, '');
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
