import { createHash } from 'crypto';

import { signedFetch } from '@aquaculture/backend-common/http';
import { BadRequestException, Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
} from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { DeviceToken } from '../entities/device-token.entity';
import { NotificationChannel } from '../entities/notification-log.entity';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

interface RenderedNotificationTemplate {
  subject: string;
  message: string;
  pushData?: Record<string, string | number | boolean | null>;
  badge?: number;
  // MSG-CRITICAL-056: a user-targeted push the mobile SW must present itself
  // (data-only FCM message) so the shared-device userId gate is authoritative.
  dataOnly?: boolean;
}

@Controller()
export class NotificationCommandHandler {
  private readonly logger = new Logger(NotificationCommandHandler.name);
  private readonly authServiceUrl: string;
  private readonly hrServiceUrl: string;

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
    private readonly configService: ConfigService,
  ) {
    this.authServiceUrl = this.configService
      .get<string>('AUTH_SERVICE_INTERNAL_URL', 'http://auth-service:3000')
      .replace(/\/+$/, '');
    this.hrServiceUrl = this.configService
      .get<string>('HR_SERVICE_INTERNAL_URL', 'http://hr-service:3000')
      .replace(/\/+$/, '');
  }

  @MessagePattern(NOTIFICATION_COMMAND_SUBJECTS.SEND_EMAIL)
  async sendEmail(
    @Payload() command: NotificationSendEmailCommand,
  ): Promise<NotificationSendResult> {
    return this.dispatch(command, 'email', NotificationChannel.EMAIL);
  }

  @MessagePattern(NOTIFICATION_COMMAND_SUBJECTS.SEND_PUSH)
  async sendPush(@Payload() command: NotificationSendPushCommand): Promise<NotificationSendResult> {
    return this.dispatch(command, 'push', NotificationChannel.PUSH);
  }

  private async dispatch(
    command: NotificationSendCommand,
    commandChannel: NotificationCommandChannel,
    channel: NotificationChannel,
  ): Promise<NotificationSendResult> {
    try {
      this.assertCommand(command);
      const recipient = await this.resolveRecipient(
        command.tenantId,
        command.recipientRef,
        channel,
      );
      const rendered = this.renderTemplate(command, commandChannel);
      // MT-HIGH-050 (tier-2, complete-by-default): stamp the recipient userId on
      // EVERY user-targeted push centrally here, so the AquaMobil FCM service
      // worker's shared-device backstop (drop a push whose userId != the active
      // on-device session) covers every template BY CONSTRUCTION — not per-template
      // opt-in, which silently missed the highest-volume push (chat messages) and
      // surfaced sender name + unread badge to the next user on a shared device.
      // For userId-kind recipients recipientRef.ref IS the user id (a UUID, not raw
      // PII — assertCommand already rejects raw recipient material); other kinds
      // (tenantContact, broadcast) legitimately carry no userId and stay broadcast.
      const pushData =
        command.recipientRef.kind === 'userId'
          ? { ...(rendered.pushData ?? {}), userId: command.recipientRef.ref }
          : rendered.pushData;
      const result = await this.dispatcher.dispatchCommandNotification({
        tenantId: command.tenantId,
        channel,
        recipient: recipient.value,
        recipientLogRef: recipient.logRef,
        deliveryId: command.deliveryId,
        requestReference: command.requestReference,
        source: command.source,
        commandPayloadHash: this.hashCommandPayload(command, commandChannel),
        subject: rendered.subject,
        message: rendered.message,
        pushData,
        badge: rendered.badge,
        dataOnly: rendered.dataOnly,
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

  private assertCommand(command: NotificationSendCommand): void {
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

    if (!this.isSupportedRecipientKind(command.recipientRef.kind)) {
      throw new BadRequestException('Unsupported notification recipientRef kind');
    }

    if (this.containsRawRecipientMaterial(command.recipientRef.ref)) {
      throw new BadRequestException(
        'Notification command recipientRef must not contain raw recipient material',
      );
    }
  }

  private async resolveRecipient(
    tenantId: string,
    recipient: NotificationRecipientRef,
    channel: NotificationChannel,
  ): Promise<{ value: string; logRef?: string }> {
    switch (recipient.kind) {
      case 'userId':
        return this.resolveUserRecipient(tenantId, recipient.ref, channel);
      case 'tenantContactRef':
        return this.resolveTenantContactRef(tenantId, recipient.ref, channel);
      case 'deliveryEndpointRef':
        throw new BadRequestException(
          'Webhook deliveryEndpointRef resolution requires a tenant-owned endpoint registry',
        );
      case 'roleRef':
        throw new BadRequestException(
          'roleRef expansion is not supported on the notification command bus',
        );
      default:
        throw new BadRequestException('Unsupported notification recipientRef kind');
    }
  }

  private async resolveUserRecipient(
    tenantId: string,
    userId: string,
    channel: NotificationChannel,
  ): Promise<{ value: string; logRef?: string }> {
    if (channel === NotificationChannel.PUSH) {
      const deviceToken = await this.deviceTokenRepository.findOne({
        where: {
          tenantId,
          userId,
        },
        order: { lastSeenAt: 'DESC', createdAt: 'DESC' },
      });
      if (!deviceToken) {
        throw new BadRequestException('No active push device token found for recipient user');
      }
      return {
        value: deviceToken.token,
        logRef: `userId:${userId}`,
      };
    }

    if (channel !== NotificationChannel.EMAIL) {
      throw new BadRequestException(
        'userId recipient resolution is supported only for email and push',
      );
    }

    const response = await signedFetch(
      `${this.authServiceUrl}/api/v1/internal/users/${encodeURIComponent(userId)}/pii`,
      {
        method: 'GET',
        serviceName: 'notification-service',
        tenantId,
        audience: 'auth-service',
        headers: { 'content-type': 'application/json' },
      },
    );
    if (!response.ok) {
      throw new BadRequestException(
        `Unable to resolve user email recipient: HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as { email?: string };
    if (!body.email) {
      throw new BadRequestException('Resolved user recipient has no email');
    }
    return { value: body.email, logRef: `userId:${userId}` };
  }

  private async resolveTenantContactRef(
    tenantId: string,
    ref: string,
    channel: NotificationChannel,
  ): Promise<{ value: string; logRef?: string }> {
    if (channel !== NotificationChannel.EMAIL) {
      throw new BadRequestException('tenantContactRef currently resolves only email contacts');
    }
    if (!/^hr\.(employee|manager)\.email:[A-Za-z0-9_-]+$/.test(ref)) {
      throw new BadRequestException('Unsupported tenantContactRef owner');
    }

    const response = await signedFetch(
      `${this.hrServiceUrl}/api/v1/internal/notification-contacts/${encodeURIComponent(ref)}`,
      {
        method: 'GET',
        serviceName: 'notification-service',
        tenantId,
        audience: 'hr-service',
        headers: { 'content-type': 'application/json' },
      },
    );
    if (!response.ok) {
      throw new BadRequestException(
        `Unable to resolve HR contact recipient: HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as { email?: string; contactRef?: string };
    if (!body.email) {
      throw new BadRequestException('Resolved HR contact has no email');
    }
    return { value: body.email, logRef: body.contactRef ?? ref };
  }

  private renderTemplate(
    command: NotificationSendCommand,
    channel: NotificationCommandChannel,
  ): RenderedNotificationTemplate {
    const variables = command.templateVariables ?? {};
    const key = `${command.templateId}@${command.templateVersion}`;
    switch (key) {
      case 'messaging.chat.message.push@1': {
        if (channel !== 'push') {
          throw new BadRequestException('messaging.chat.message.push is push-only');
        }
        const notificationRef = this.requiredString(variables, 'notificationRef');
        const senderName = this.requiredString(variables, 'senderName');
        const badge = this.optionalNumber(variables, 'badge');
        return {
          subject: `New message from ${senderName}`,
          message: 'Open the app to read the message.',
          badge,
          // MSG-CRITICAL-056: chat push is data-only so the AquaMobil FCM SW is the
          // sole presenter and its shared-device userId gate cannot be bypassed.
          dataOnly: true,
          pushData: {
            type: 'CHAT_MESSAGE',
            notificationRef,
          },
        };
      }
      case 'hr.weekly_schedule.email@1':
        if (channel !== 'email') {
          throw new BadRequestException('hr.weekly_schedule.email is email-only');
        }
        return {
          subject: `Weekly schedule: ${this.requiredString(variables, 'weekStartDate')} - ${this.requiredString(variables, 'weekEndDate')}`,
          message:
            `Hello ${this.requiredString(variables, 'employeeName')}, your weekly schedule is ready. ` +
            `Work days: ${this.requiredNumber(variables, 'totalWorkDays')}; ` +
            `hours: ${this.requiredNumber(variables, 'totalWorkHours')}.`,
        };
      case 'hr.overtime_warning.email@1':
        if (channel !== 'email') {
          throw new BadRequestException('hr.overtime_warning.email is email-only');
        }
        return {
          subject: `Overtime warning: ${this.requiredString(variables, 'warningType')}`,
          message:
            `${this.requiredString(variables, 'employeeName')} has ` +
            `${this.requiredNumber(variables, 'overtimeHours')} overtime hours ` +
            `against a ${this.requiredNumber(variables, 'maxHours')} hour limit.`,
        };
      default:
        throw new BadRequestException(`Unsupported notification template: ${key}`);
    }
  }

  private isSupportedRecipientKind(kind: string): kind is NotificationRecipientRef['kind'] {
    return ['userId', 'deliveryEndpointRef', 'tenantContactRef', 'roleRef'].includes(kind);
  }

  private containsRawRecipientMaterial(value: string): boolean {
    return /@/.test(value) || /^https?:\/\//i.test(value) || /^\+?[0-9][0-9 .()-]{6,}$/.test(value);
  }

  private hashCommandPayload(
    command: NotificationSendCommand,
    channel: NotificationCommandChannel,
  ): string {
    return createHash('sha256')
      .update(
        this.stableStringify({
          channel,
          deliveryId: command.deliveryId,
          requestReference: command.requestReference,
          tenantId: command.tenantId,
          source: command.source,
          recipientRef: command.recipientRef,
          templateId: command.templateId,
          templateVersion: command.templateVersion,
          templateVariables: command.templateVariables ?? {},
          metadata: command.metadata ?? {},
        }),
      )
      .digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`)
      .join(',')}}`;
  }

  private requiredString(
    values: Record<string, string | number | boolean | null>,
    key: string,
  ): string {
    const value = values[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`Notification template missing string variable: ${key}`);
    }
    return value.replace(/[\r\n]/g, ' ').trim();
  }

  private requiredNumber(
    values: Record<string, string | number | boolean | null>,
    key: string,
  ): number {
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`Notification template missing numeric variable: ${key}`);
    }
    return value;
  }

  private optionalNumber(
    values: Record<string, string | number | boolean | null>,
    key: string,
  ): number | undefined {
    const value = values[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
