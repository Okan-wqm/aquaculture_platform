export const NOTIFICATION_COMMAND_SUBJECTS = {
  SEND_EMAIL: 'commands.notification.sendEmail',
  SEND_PUSH: 'commands.notification.sendPush',
} as const;

export type NotificationCommandChannel = 'email' | 'push';

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

// Email and push commands intentionally share one payload shape — the
// channel is carried by the NATS subject (SEND_EMAIL / SEND_PUSH), not
// the payload. The named aliases keep call sites self-documenting; the
// catch-all is the base itself (a union of identical aliases would just
// duplicate constituents).
export type NotificationSendEmailCommand = NotificationSendCommandBase;

export type NotificationSendPushCommand = NotificationSendCommandBase;

export type NotificationSendCommand = NotificationSendCommandBase;

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
