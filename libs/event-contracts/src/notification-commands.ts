export const NOTIFICATION_COMMAND_SUBJECTS = {
  SEND_EMAIL: 'commands.notification.sendEmail',
  SEND_PUSH: 'commands.notification.sendPush',
  SEND_SMS: 'commands.notification.sendSms',
  SEND_WEBHOOK: 'commands.notification.sendWebhook',
} as const;

export type NotificationCommandChannel = 'email' | 'push' | 'sms' | 'webhook';

export interface NotificationRecipientRef {
  kind: 'userId' | 'deliveryEndpointRef' | 'tenantContactRef' | 'roleRef';
  ref: string;
}

export interface NotificationSendCommandBase {
  deliveryId: string;
  requestReference: string;
  tenantId: string;
  source: string;
  recipientRef: NotificationRecipientRef;
  templateId: string;
  templateVersion: string;
  templateVariables?: Record<string, string | number | boolean | null>;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface NotificationSendEmailCommand extends NotificationSendCommandBase {}

export interface NotificationSendPushCommand extends NotificationSendCommandBase {}

export interface NotificationSendSmsCommand extends NotificationSendCommandBase {}

export interface NotificationSendWebhookCommand extends NotificationSendCommandBase {}

export type NotificationSendCommand =
  | NotificationSendEmailCommand
  | NotificationSendPushCommand
  | NotificationSendSmsCommand
  | NotificationSendWebhookCommand;

export interface NotificationSendResult {
  success: boolean;
  deliveryId: string;
  tenantId: string;
  channel: NotificationCommandChannel;
  externalId?: string;
  replayed?: boolean;
  errorCode?: 'VALIDATION_ERROR' | 'PROVIDER_ERROR' | 'RATE_LIMITED' | 'INTERNAL_ERROR';
  error?: string;
}
