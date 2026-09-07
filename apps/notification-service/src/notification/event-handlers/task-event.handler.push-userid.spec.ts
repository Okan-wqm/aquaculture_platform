import { TaskEventHandler } from './task-event.handler';

/**
 * TaskEventHandler push-payload userId stamp — MT-HIGH-050 (tier-1 SW backstop).
 *
 * The FCM service worker on a SHARED device drops a push whose userId does not
 * match the active session. For that gate to work the SENDER must stamp the
 * intended recipient userId on the push payload. This test proves the task push
 * carries `pushData.userId` set to the resolved recipient.
 */

type SendPushToUser = (
  tenantId: string,
  userId: string,
  taskId: string,
  title: string,
  eventType: string,
) => Promise<void>;

/** Typed view of the handler exposing the private send path under test. */
interface TaskEventHandlerInternals {
  sendPushToUser: SendPushToUser;
}

/**
 * Single-boundary widening to the internals view. Accepting `object` (not the
 * banned `unknown as`) and returning the typed view keeps the spec body free of
 * cast constructs while still reaching the private method under test.
 */
function asInternals(handler: object): TaskEventHandlerInternals {
  return handler as TaskEventHandlerInternals;
}

describe('TaskEventHandler push payload (MT-HIGH-050)', () => {
  it('stamps the recipient userId on the push payload so the SW can gate it', async () => {
    const dispatchCommandNotification = jest.fn().mockResolvedValue(undefined);
    const deviceTokenFindOne = jest.fn().mockResolvedValue({ token: 'fcm-token-123' });

    // `as never` partial-mock injection is the repo's sanctioned spec idiom
    // (see notification-dispatcher.service.spec.ts) — no double-cast hack needed.
    const handler = new TaskEventHandler(
      { dispatchCommandNotification } as never,
      {} as never,
      { findOne: deviceTokenFindOne } as never,
      { subscribeWildcard: jest.fn() } as never,
    );

    await asInternals(handler).sendPushToUser(
      'tenant-xyz',
      'user-aaaa',
      'task-1',
      'New task',
      'assigned',
    );

    expect(dispatchCommandNotification).toHaveBeenCalledTimes(1);
    const arg = dispatchCommandNotification.mock.calls[0][0] as { pushData?: { userId?: string } };
    expect(arg.pushData).toEqual({ userId: 'user-aaaa' });
  });
});
