import { BadRequestException, Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  NOTIFICATION_COMMAND_SUBJECTS,
  type NotificationCommandChannel,
  type NotificationRecipientRef,
  type NotificationSendCommand,
  type NotificationSendEmailCommand,
  type NotificationSendPushCommand,
  type NotificationSendResult,
  type NotificationSendSmsCommand,
  type NotificationSendWebhookCommand,
} from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { DeviceToken } from '../entities/device-token.entity';
import { NotificationChannel } from '../entities/notification-log.entity';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

@Controller()
export class NotificationCommandHandler {
  private readonly logger = new Logger(NotificationCommandHandler.name);

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
  ) {}

  @MessagePattern(NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL)
  async sendEmail(
    @Payload() command: NotificationSendEmailCommand,
  ): Promise<NotificationSendResult> {
    return this.dispatch(command, 'email', NotificationChannel.EMAIL);
  }

  @MessagePattern(NOTIFICATION_COMMAND_SUBJECTS.SEND_PUSH)
  async sendPush(
    @Payload() command: NotificationSendPushCommand,
  ): Promise<NotificationSendResult> {
    return this.dispatch(command, 'push', NotificationChannel.PUSH);
  }

  @MessagePattern(NOTIFICATION_COMMAND_SUBJECTS.SEND_SMS)
  async sendSms(
    @Payload() command: NotificationSendSmsCommand,
  ): Promise<NotificationSendResult> {
    return this.dispatch(command, 'sms', NotificationChannel.SMS);
  }

  @MessagePattern(NOTIFICATION_COMMAND_SUBJECTS.SEND_WEBHOOK)
  async sendWebhook(
    @Payload() command: NotificationSendWebhookCommand,
  ): Promise<NotificationSendResult> {
    return this.dispatch(command, 'webhook', NotificationChannel.WEBHOOK);
  }

  private async dispatch(
    command: NotificationSendCommand,
    commandChannel: NotificationCommandChannel,
    channel: NotificationChannel,
  ): Promise<NotificationSendResult> {
    try {
      this.assertCommand(command);
      const recipient = await this.resolveRecipient(command.tenantId, command.recipientRef);
      const result = await this.dispatcher.dispatchCommandNotification({
        tenantId: command.tenantId,
        channel,
        recipient: recipient.value,
        recipientLogRef: recipient.logRef,
        deliveryId: command.deliveryId,
        requestReference: command.requestReference,
        source: command.source,
        subject: this.templateSubject(command),
        message: this.templateMessage(command),
      });
      return {
        success: true,
        deliveryId: command.deliveryId,
        tenantId: command.tenantId,
        channel: commandChannel,
        externalId: result.externalId,
        replayed: result.replayed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Notification command failed channel=${commandChannel} deliveryId=${command?.deliveryId ?? 'unknown'}: ${message}`,
      );
      return {
        success: false,
        deliveryId: command?.deliveryId ?? '',
        tenantId: command?.tenantId ?? '',
        channel: commandChannel,
        errorCode: error instanceof BadRequestException ? 'VALIDATION_ERROR' : 'PROVIDER_ERROR',
        error: message,
      };
    }
  }

  private assertCommand(
    command: NotificationSendCommand,
  ): void {
    const missing = [
      ['deliveryId', command.deliveryId],
      ['requestReference', command.requestReference],
      ['tenantId', command.tenantId],
      ['source', command.source],
      ['recipientRef.ref', command.recipientRef?.ref],
      ['templateId', command.templateId],
      ['templateVersion', command.templateVersion],
    ].filter(([, value]) => typeof value !== 'string' || value.trim().length === 0);

    if (missing.length > 0) {
      throw new BadRequestException(
        `Notification command missing required fields: ${missing.map(([name]) => name).join(', ')}`,
      );
    }

    if (
      command.recipientRef.kind === 'deliveryEndpointRef'
      && /[@:/\\?&#]/.test(command.recipientRef.ref)
    ) {
      throw new BadRequestException('Notification command recipientRef must not contain raw recipient material');
    }
  }

  private async resolveRecipient(
    tenantId: string,
    recipient: NotificationRecipientRef,
  ): Promise<{ value: string; logRef?: string }> {
    if (recipient.kind !== 'userId') {
      return { value: recipient.ref.trim() };
    }

    const deviceToken = await this.deviceTokenRepository.findOne({
      where: {
        tenantId,
        userId: recipient.ref,
      },
      order: { lastSeenAt: 'DESC', createdAt: 'DESC' },
    });
    if (!deviceToken) {
      throw new BadRequestException('No active push device token found for recipient user');
    }
    return {
      value: deviceToken.token,
      logRef: `userId:${recipient.ref}`,
    };
  }

  private templateSubject(command: NotificationSendCommand): string {
    return `${command.templateId}@${command.templateVersion}`.replace(/[\r\n]/g, '');
  }

  private templateMessage(command: NotificationSendCommand): string {
    return `template:${command.templateId}:${command.templateVersion}`;
  }
}
