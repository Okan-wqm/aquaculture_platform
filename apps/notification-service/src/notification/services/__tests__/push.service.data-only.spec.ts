import { buildFirebaseMessage } from '../push.service';

/**
 * FCM message shape for data-only vs notification-bearing pushes (MSG-CRITICAL-056,
 * MSG-MEDIUM-069).
 *
 * A data-only message MUST omit the `notification`/`android`/`webpush` presentation
 * blocks so the FCM web SDK cannot auto-display it — the AquaMobil service worker is
 * then the sole presenter and its shared-device userId gate is authoritative. The
 * badge COUNT must travel in `data.badge`, not the webpush badge field (an icon URL).
 */
describe('buildFirebaseMessage', () => {
  it('builds a data-only message with title/body/badge in data and no notification block', () => {
    const message = buildFirebaseMessage('device-1', {
      title: 'New message from Grace',
      body: 'Open the app to read the message.',
      badge: 4,
      dataOnly: true,
      data: { type: 'CHAT_MESSAGE', notificationRef: 'ref-1', userId: 'user-1' },
    });

    // No presentation block → SDK cannot auto-present → SW gate is authoritative.
    expect(message.notification).toBeUndefined();
    expect(message.android).toBeUndefined();
    expect(message.webpush).toBeUndefined();

    // Everything the SW needs to render is in data (stringified).
    expect(message.data).toEqual({
      type: 'CHAT_MESSAGE',
      notificationRef: 'ref-1',
      userId: 'user-1',
      title: 'New message from Grace',
      body: 'Open the app to read the message.',
      badge: '4',
    });
  });

  it('omits data.badge when no badge is provided on a data-only message', () => {
    const message = buildFirebaseMessage('device-1', {
      title: 't',
      body: 'b',
      dataOnly: true,
      data: { userId: 'user-1' },
    });

    expect(message.data).not.toHaveProperty('badge');
  });

  it('builds a notification-bearing message for a non-data-only push', () => {
    const message = buildFirebaseMessage('device-1', {
      title: 'Alert',
      body: 'Tank temperature high',
      badge: 2,
      sound: 'critical.wav',
      data: { type: 'alert' },
    });

    expect(message.notification).toEqual({ title: 'Alert', body: 'Tank temperature high' });
    expect(message.android).toEqual({ notification: { sound: 'critical.wav' } });
    // The badge count does NOT leak into data for a notification-bearing push.
    expect(message.data).toEqual({ type: 'alert' });
  });
});
