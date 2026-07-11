import { signedFetch } from '@aquaculture/backend-common/http';
import { ConfigService } from '@nestjs/config';
import type {
  NotificationSendEmailCommand,
  NotificationSendPushCommand,
} from '@platform/event-contracts';

import { NotificationChannel } from '../entities/notification-log.entity';

import { NotificationCommandHandler } from './notification-command.handler';

jest.mock('@aquaculture/backend-common/http', () => ({
  signedFetch: jest.fn(),
}));

function createHandler() {
  const dispatcher = {
    dispatchCommandNotification: jest.fn().mockResolvedValue({
      externalId: 'provider-1',
      replayed: false,
    }),
  };
  const deviceTokenRepository = {
    findOne: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      if (key === 'AUTH_SERVICE_INTERNAL_URL') return 'http://auth-internal';
      if (key === 'HR_SERVICE_INTERNAL_URL') return 'http://hr-internal';
      return defaultValue;
    }),
  } as unknown as ConfigService;

  const handler = new NotificationCommandHandler(
    dispatcher as never,
    deviceTokenRepository as never,
    configService,
  );

  return { handler, dispatcher, deviceTokenRepository };
}

function emailCommand(
  overrides: Partial<NotificationSendEmailCommand> = {},
): NotificationSendEmailCommand {
  return {
    deliveryId: 'delivery-email-1',
    requestReference: 'request-email-1',
    tenantId: 'tenant-1',
    source: 'hr-service',
    recipientRef: {
      kind: 'tenantContactRef',
      ref: 'hr.employee.email:emp-1',
    },
    templateId: 'hr.weekly_schedule.email',
    templateVersion: '1',
    templateVariables: {
      employeeName: 'Ada Lovelace',
      weekStartDate: '2026-06-08',
      weekEndDate: '2026-06-14',
      totalWorkDays: 5,
      totalWorkHours: 40,
    },
    ...overrides,
  };
}

function pushCommand(
  overrides: Partial<NotificationSendPushCommand> = {},
): NotificationSendPushCommand {
  return {
    deliveryId: 'delivery-push-1',
    requestReference: 'request-push-1',
    tenantId: 'tenant-1',
    source: 'messaging-service',
    recipientRef: {
      kind: 'userId',
      ref: 'user-1',
    },
    templateId: 'messaging.chat.message.push',
    templateVersion: '1',
    templateVariables: {
      senderName: 'Grace',
      badge: 3,
      notificationRef: 'notification-ref-1',
    },
    metadata: {
      notificationRef: 'notification-ref-1',
    },
    ...overrides,
  };
}

describe('NotificationCommandHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects raw recipient material on the command bus', async () => {
    const { handler, dispatcher } = createHandler();

    await expect(
      handler.sendEmail(
        emailCommand({
          recipientRef: {
            kind: 'tenantContactRef',
            ref: 'ada@example.com',
          },
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        errorCode: 'VALIDATION_ERROR',
      }),
    );

    expect(dispatcher.dispatchCommandNotification).not.toHaveBeenCalled();
  });

  it('resolves tenant contact refs through the tenant owner before dispatching email', async () => {
    const { handler, dispatcher } = createHandler();
    (signedFetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        email: 'ada@example.com',
        contactRef: 'hr.employee.email:emp-1',
      }),
    });

    await expect(handler.sendEmail(emailCommand())).resolves.toEqual(
      expect.objectContaining({
        success: true,
        channel: 'email',
        externalId: 'provider-1',
      }),
    );

    expect(signedFetch).toHaveBeenCalledWith(
      'http://hr-internal/api/v1/internal/notification-contacts/hr.employee.email%3Aemp-1',
      expect.objectContaining({
        serviceName: 'notification-service',
        tenantId: 'tenant-1',
        audience: 'hr-service',
      }),
    );
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: NotificationChannel.EMAIL,
        recipient: 'ada@example.com',
        recipientLogRef: 'hr.employee.email:emp-1',
        subject: 'Weekly schedule: 2026-06-08 - 2026-06-14',
      }),
    );
  });

  it('preserves notificationRef in push provider payload without leaking channel or message ids', async () => {
    const { handler, dispatcher, deviceTokenRepository } = createHandler();
    deviceTokenRepository.findOne.mockResolvedValue({
      token: 'device-token-1',
    });

    await expect(handler.sendPush(pushCommand())).resolves.toEqual(
      expect.objectContaining({
        success: true,
        channel: 'push',
        externalId: 'provider-1',
      }),
    );

    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: NotificationChannel.PUSH,
        recipient: 'device-token-1',
        recipientLogRef: 'userId:user-1',
        pushData: {
          type: 'CHAT_MESSAGE',
          notificationRef: 'notification-ref-1',
          // MT-HIGH-050: a userId-kind recipient is stamped with the recipient
          // userId CENTRALLY, so the AquaMobil FCM service-worker shared-device
          // backstop (drop a push whose userId != the active on-device session)
          // covers chat push — the highest-volume user-targeted push — without
          // per-template opt-in.
          userId: 'user-1',
        },
        badge: 3,
        // MSG-CRITICAL-056: the chat push is data-only so the AquaMobil FCM SW is
        // the sole presenter and its shared-device userId gate cannot be bypassed
        // by FCM SDK auto-display.
        dataOnly: true,
      }),
    );
    const [firstDispatchCall] = dispatcher.dispatchCommandNotification.mock
      .calls as readonly (readonly unknown[])[];
    expect(JSON.stringify(firstDispatchCall?.[0])).not.toMatch(/channel-1|message-1/);
  });

  it('MT-HIGH-050: stamps the recipient userId on every userId-kind push (backstop is complete-by-construction)', async () => {
    const { handler, dispatcher, deviceTokenRepository } = createHandler();
    deviceTokenRepository.findOne.mockResolvedValue({ token: 'device-token-2' });

    // A chat push for a DIFFERENT recipient — the stamped userId must be THAT
    // recipient's id (recipientRef.ref), proving it is the genuine recipient
    // partition rather than a hard-coded value, so the SW can compare it against
    // the active session and drop a cross-user push on a shared device.
    await handler.sendPush(
      pushCommand({ recipientRef: { kind: 'userId', ref: 'user-B' } }),
    );

    const [call] = dispatcher.dispatchCommandNotification.mock.calls as readonly (readonly {
      pushData?: { userId?: string };
    }[])[];
    expect(call?.[0]?.pushData?.userId).toBe('user-B');
  });
});
