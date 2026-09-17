/**
 * useFirebaseMessaging device-token deregistration tests — MT-HIGH-050.
 *
 * AquaMobil runs on SHARED devices. Without deregistration the FCM token stays
 * mapped to tenant-A/user-A after logout, so push for tenant-A keeps reaching a
 * phone now logged into tenant-B. These tests prove:
 *   - on registration the hook stamps the active userId on the FCM SW
 *     (SET_ACTIVE_USER) so the SW backstop can drop mismatched pushes;
 *   - on registration the hook registers a logout teardown;
 *   - running that teardown calls the server unregisterDeviceToken mutation AND
 *     FCM deleteToken(), so both the server mapping and the local subscription
 *     are torn down.
 *
 * Env is stubbed BEFORE importing the hook (FIREBASE_CONFIG reads import.meta.env
 * at module load), mirroring useFirebaseMessaging-sw-scope.spec.tsx.
 */

import { render, cleanup, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

vi.stubEnv('VITE_FIREBASE_API_KEY', 'api-key');
vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'project-id');
vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', 'sender-id');
vi.stubEnv('VITE_FIREBASE_APP_ID', 'app-id');
vi.stubEnv('VITE_FIREBASE_VAPID_KEY', 'vapid-key');
vi.stubEnv('BASE_URL', '/mobile/');

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'access-token',
    isAuthenticated: true,
    user: { id: 'user-aaaa', tenantId: 'tenant-xyz' },
  }),
}));

const authenticatedFetch = vi.fn(
  (_url: string, _init?: RequestInit): Promise<{ ok: boolean; status: number }> =>
    Promise.resolve({ ok: true, status: 200 }),
);
vi.mock('@/services/authenticated-fetch', () => ({
  authenticatedFetch: (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number }> =>
    authenticatedFetch(url, init),
}));

// Capture the teardown the hook registers so the test can run it.
let capturedTeardown: (() => Promise<void>) | null = null;
const registerPushTeardown = vi.fn((t: (() => Promise<void>) | null) => {
  capturedTeardown = t;
});
vi.mock('@/services/push-lifecycle', () => ({
  registerPushTeardown: (t: (() => Promise<void>) | null) => registerPushTeardown(t),
}));

const getTokenSpy = vi.fn((..._args: unknown[]) => Promise.resolve('fcm-token-123'));
const onMessageSpy = vi.fn(
  (..._args: unknown[]) =>
    () =>
      undefined,
);
const deleteTokenSpy = vi.fn((..._args: unknown[]) => Promise.resolve(true));

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'app' })),
  getApps: vi.fn(() => []),
}));

vi.mock('firebase/messaging', () => ({
  getMessaging: vi.fn(() => ({ __id: 'messaging-instance' })),
  getToken: (...args: unknown[]): Promise<string> => getTokenSpy(...args),
  onMessage: (...args: unknown[]): (() => void) => onMessageSpy(...args),
  deleteToken: (...args: unknown[]): Promise<boolean> => deleteTokenSpy(...args),
}));

let useFirebaseMessaging: typeof import('../useFirebaseMessaging').useFirebaseMessaging;

beforeAll(async () => {
  ({ useFirebaseMessaging } = await import('../useFirebaseMessaging'));
});

function HookHost(): null {
  useFirebaseMessaging();
  return null;
}

const fcmWorkerPostMessage = vi.fn();

beforeEach(() => {
  capturedTeardown = null;
  getTokenSpy.mockClear();
  deleteTokenSpy.mockClear();
  authenticatedFetch.mockClear();
  registerPushTeardown.mockClear();
  fcmWorkerPostMessage.mockClear();

  const fakeRegistration = {
    scope: '/mobile/firebase-cloud-messaging-push-scope',
    active: { postMessage: fcmWorkerPostMessage },
  };
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    serviceWorker: {
      register: vi.fn(() => Promise.resolve(fakeRegistration)),
      ready: Promise.resolve({ active: { postMessage: vi.fn() } }),
    },
  });
  vi.stubGlobal('Notification', {
    requestPermission: vi.fn(() => Promise.resolve('granted')),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('MT-HIGH-050: useFirebaseMessaging device-token lifecycle', () => {
  it('stamps the active userId on the FCM service worker (SET_ACTIVE_USER backstop)', async () => {
    render(<HookHost />);
    await waitFor(() => expect(getTokenSpy).toHaveBeenCalled());

    expect(fcmWorkerPostMessage).toHaveBeenCalledWith({
      type: 'SET_ACTIVE_USER',
      userId: 'user-aaaa',
    });
  });

  it('registers a logout teardown once the token is registered', async () => {
    render(<HookHost />);
    await waitFor(() => expect(getTokenSpy).toHaveBeenCalled());
    await waitFor(() => expect(capturedTeardown).toBeTypeOf('function'));
  });

  it('teardown deregisters the token server-side AND deletes the local FCM subscription', async () => {
    render(<HookHost />);
    await waitFor(() => expect(capturedTeardown).toBeTypeOf('function'));
    // Reset the registration POST so we only observe the unregister call.
    authenticatedFetch.mockClear();

    const teardown = capturedTeardown;
    if (!teardown) throw new Error('push teardown was not registered');
    await teardown();

    // Server-side mapping removed via unregisterDeviceToken.
    const firstCall = authenticatedFetch.mock.calls[0];
    if (!firstCall) throw new Error('expected an authenticatedFetch call');
    const init = firstCall[1];
    if (!init?.body) throw new Error('expected a request body');
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: { token: string };
    };
    expect(body.query).toMatch(/unregisterDeviceToken/);
    expect(body.variables.token).toBe('fcm-token-123');

    // Local subscription invalidated so the device stops receiving prior-tenant push.
    expect(deleteTokenSpy).toHaveBeenCalledWith({ __id: 'messaging-instance' });
  });

  it('MT-MEDIUM-051: teardown tells the FCM SW the session ended (LOGOUT) so it clears the active user', async () => {
    render(<HookHost />);
    await waitFor(() => expect(capturedTeardown).toBeTypeOf('function'));
    fcmWorkerPostMessage.mockClear();

    const teardown = capturedTeardown;
    if (!teardown) throw new Error('push teardown was not registered');
    await teardown();

    // The SW's persisted active user must be cleared on logout — otherwise a
    // background push for the prior user could surface to the next user on this
    // shared device before token deregistration propagates.
    expect(fcmWorkerPostMessage).toHaveBeenCalledWith({ type: 'LOGOUT' });
  });

  it('still deletes the local subscription even when the server unregister fails', async () => {
    render(<HookHost />);
    await waitFor(() => expect(capturedTeardown).toBeTypeOf('function'));
    authenticatedFetch.mockClear();
    authenticatedFetch.mockRejectedValueOnce(new Error('network down'));

    const teardown = capturedTeardown;
    if (!teardown) throw new Error('push teardown was not registered');
    await teardown().catch(() => undefined);

    // deleteToken runs in the teardown's finally — the leak is closed locally
    // regardless of the network unregister outcome.
    expect(deleteTokenSpy).toHaveBeenCalledWith({ __id: 'messaging-instance' });
  });
});
