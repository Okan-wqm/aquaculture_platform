import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get('SMS_ENABLED', 'false') === 'true';
    this.provider = this.configService.get('SMS_PROVIDER', 'mock');

    if (this.isEnabled) {
      this.logger.log(`SMS service initialized with provider: ${this.provider}`);
    } else {
      this.logger.warn('SMS service is disabled');
    }
  }

  /**
   * Send an SMS message
   */
  async sendSms(phoneNumber: string, message: string): Promise<string> {
    if (!this.isEnabled) {
      this.logger.warn(`SMS not sent (disabled): to ${phoneNumber}`);
      return `mock-sms-${Date.now()}`;
    }

    // Validate phone number format
    const cleanedNumber = this.cleanPhoneNumber(phoneNumber);
    if (!this.isValidPhoneNumber(cleanedNumber)) {
      throw new Error(`Invalid phone number: ${phoneNumber}`);
    }

    // Truncate message if too long (SMS limit is typically 160 chars)
    const truncatedMessage = this.truncateMessage(message, 160);

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

      this.logger.log(`SMS sent to ${cleanedNumber}: ${messageId}`);
      return messageId;
    } catch (error) {
      this.logger.error(
        `Failed to send SMS to ${cleanedNumber}: ${(error as Error).message}`,
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
    this.logger.debug(`[MOCK SMS] To: ${phoneNumber}, Message: ${message}`);
    return `mock-sms-${Date.now()}`;
  }

  /**
   * Twilio SMS provider (placeholder - implement when needed)
   */
  private async sendViaTwilio(
    phoneNumber: string,
    message: string,
  ): Promise<string> {
    // TODO: Implement Twilio integration
    // const client = require('twilio')(accountSid, authToken);
    // const result = await client.messages.create({ body: message, from: fromNumber, to: phoneNumber });
    // return result.sid;

    this.logger.warn('Twilio integration not implemented, using mock');
    return await this.sendViaMock(phoneNumber, message);
  }

  /**
   * AWS SNS SMS provider (placeholder - implement when needed)
   */
  private async sendViaAwsSns(
    phoneNumber: string,
    message: string,
  ): Promise<string> {
    // TODO: Implement AWS SNS integration
    // const sns = new AWS.SNS();
    // const result = await sns.publish({ PhoneNumber: phoneNumber, Message: message }).promise();
    // return result.MessageId;

    this.logger.warn('AWS SNS integration not implemented, using mock');
    return await this.sendViaMock(phoneNumber, message);
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
    // Basic validation - should start with + and have 10-15 digits
    return /^\+?[1-9]\d{9,14}$/.test(phoneNumber);
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
