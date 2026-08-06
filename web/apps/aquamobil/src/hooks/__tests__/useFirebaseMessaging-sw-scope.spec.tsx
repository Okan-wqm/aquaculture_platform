/**
 * useFirebaseMessaging dual-SW collision tests — FE-CRITICAL-050-SW / FE-HIGH-057.
 *
 * AquaMobil ships TWO service workers:
 *   - the workbox SW (dist/messaging-sw.js) which OWNS scope `/mobile/` and does
 *     precache + background sync + LOGOUT cache purge, and
 *   - the FCM push SW (firebase-messaging-sw.js) which holds the push subscription.
 *
 * A ServiceWorker registration is keyed by SCOPE. If Firebase's getToken() is
 * left to auto-register `/firebase-messaging-sw.js`, it lands at the ROOT scope
 * — which the `/mobile/` reverse proxy does not route, so push 404s and dies
 * (the deadness this finding flags). And registering the FCM worker at the SAME
 * `/mobile/` scope as the workbox worker would EVICT one of them (the collision).
 *
 * The fix: useFirebaseMessaging registers the FCM worker at a DISTINCT deeper
 * sub-scope `/mobile/firebase-cloud-messaging-push-scope` and passes THAT
 * registration explicitly to getToken(). These tests prove that contract:
 *   - getToken receives an explicit serviceWorkerRegistration (never auto-registers)
 *   - the FCM worker script lives under the /mobile base, not at root
 *   - the FCM worker scope is the distinct push sub-scope, NOT the workbox /mobile scope
 *   - the Firebase config travels as URL query params (the static-SW pattern)
 *
 * NOTE: FIREBASE_CONFIG is captured at MODULE-LOAD time from import.meta.env, so
 * the env must be stubbed BEFORE the hook module is imported. The env stubs are
 * therefore set at the top of this file (before any import of the hook) and the
 * hook is loaded via dynamic import() inside the tests.
 */

import { render, cleanup, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

// --------------------------------------------------------------------------
// Env — set BEFORE importing the hook (FIREBASE_CONFIG reads these at load).
// import.meta.env.BASE_URL is read at CALL time inside the effect, so it is
// stubbed here too and honoured when the registration URL is built.
// --------------------------------------------------------------------------
vi.stubEnv('VITE_FIREBASE_API_KEY', 'api-key');
vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'project-id');
vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', 'sender-id');
vi.stubEnv('VITE_FIREBASE_APP_ID', 'app-id');
vi.stubEnv('VITE_FIREBASE_VAPID_KEY', 'vapid-key');
vi.stubEnv('BASE_URL', '/mobile/');

// --------------------------------------------------------------------------
// Auth: report an authenticated, mobile-enabled user so the effect runs.
// --------------------------------------------------------------------------
vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'access-token',
    isAuthenticated: true,
    // MT-HIGH-050: the hook now requires a user.id to register (it stamps the
    // active user on the FCM SW and registers the per-user logout teardown).
    user: { id: 'user-aaaa', tenantId: 'tenant-xyz' },
  }),
}));

// --------------------------------------------------------------------------
// authenticatedFetch: the device-token registration POST — succeed silently.
// --------------------------------------------------------------------------
vi.mock('@/services/authenticated-fetch', () => ({
  authenticatedFetch: vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
}));

// --------------------------------------------------------------------------
// firebase/app + firebase/messaging dynamic imports.
// --------------------------------------------------------------------------
// WHY the explicit (...args) signatures: vi.fn(() => ...) infers a ZERO-arg
// call signature, so `getTokenSpy.mock.calls[0]` is typed as the empty tuple `[]`
// and indexing `[1]` (the options arg we assert on) is a TS2493 out-of-bounds
// error under strict mode. Declaring the rest parameter makes mock.calls a
// variadic tuple, so reading the second argument typechecks.
const getTokenSpy = vi.fn((..._args: unknown[]) => Promise.resolve('fcm-token-123'));
const onMessageSpy = vi.fn(
  (..._args: unknown[]) =>
    () =>
      undefined,
);

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'app' })),
  getApps: vi.fn(() => []),
}));

vi.mock('firebase/messaging', () => ({
  getMessaging: vi.fn(() => ({})),
  getToken: (...args: unknown[]): Promise<string> => getTokenSpy(...args),
  onMessage: (...args: unknown[]): (() => void) => onMessageSpy(...args),
  // MT-HIGH-050: the hook imports deleteToken for the logout teardown. Vitest
  // module mocks are strict — an unlisted export throws on destructure even if
  // unused in this spec — so it must be present here too.
  deleteToken: vi.fn(() => Promise.resolve(true)),
}));

// The hook reads FIREBASE_CONFIG at module load, so import it AFTER the env
// stubs above. A static top-level import would be hoisted ABOVE the stubs.
let useFirebaseMessaging: typeof import('../useFirebaseMessaging').useFirebaseMessaging;

beforeAll(async () => {
  ({ useFirebaseMessaging } = await import('../useFirebaseMessaging'));
});

function HookHost(): null {
  useFirebaseMessaging();
  return null;
}

// Captured serviceWorker.register() calls: [scriptURL, options]
let registerCalls: Array<[string, RegistrationOptions | undefined]> = [];

beforeEach(() => {
  registerCalls = [];
  getTokenSpy.mockClear();
  onMessageSpy.mockClear();

  const fakeRegistration = { scope: '/mobile/firebase-cloud-messaging-push-scope' };
  const serviceWorker = {
    register: vi.fn((scriptURL: string, options?: RegistrationOptions) => {
      registerCalls.push([scriptURL, options]);
      return Promise.resolve(fakeRegistration);
    }),
    ready: Promise.resolve({ active: { postMessage: vi.fn() } }),
  };
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    serviceWorker,
  });

  // Notification permission must resolve to 'granted' for getToken to run.
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

describe('FE-CRITICAL-050-SW: useFirebaseMessaging resolves the dual-SW collision', () => {
  it('registers the FCM worker explicitly and passes it to getToken (never auto-registers)', async () => {
    render(<HookHost />);

    await waitFor(() => expect(getTokenSpy).toHaveBeenCalled());

    // getToken MUST receive an explicit serviceWorkerRegistration — that is what
    // stops Firebase from auto-registering `/firebase-messaging-sw.js` at root.
    const tokenOptions = getTokenSpy.mock.calls[0]?.[1] as
      | { serviceWorkerRegistration?: unknown }
      | undefined;
    expect(tokenOptions?.serviceWorkerRegistration).toBeDefined();
    expect(tokenOptions?.serviceWorkerRegistration).toEqual({
      scope: '/mobile/firebase-cloud-messaging-push-scope',
    });
  });

  it('registers the FCM worker script under the /mobile base, not at root', async () => {
    render(<HookHost />);

    await waitFor(() => expect(registerCalls.length).toBeGreaterThan(0));

    const [scriptURL] = registerCalls[0];
    expect(scriptURL.startsWith('/mobile/firebase-messaging-sw.js')).toBe(true);
    // A root-scope script (the broken auto-register path) would have NO /mobile prefix.
    expect(scriptURL.startsWith('/firebase-messaging-sw.js')).toBe(false);
  });

  it('scopes the FCM worker to the distinct push sub-scope, NOT the workbox /mobile scope', async () => {
    render(<HookHost />);

    await waitFor(() => expect(registerCalls.length).toBeGreaterThan(0));

    const [, options] = registerCalls[0];
    // The workbox SW owns exactly `/mobile/`. The FCM worker must take a deeper,
    // disjoint scope so neither registration evicts the other.
    expect(options?.scope).toBe('/mobile/firebase-cloud-messaging-push-scope');
    expect(options?.scope).not.toBe('/mobile/');
  });

  it('FE-HIGH-057: the FCM scope is STRICTLY UNDER /mobile/ (deeper, never equal) — proves no eviction', async () => {
    render(<HookHost />);

    await waitFor(() => expect(registerCalls.length).toBeGreaterThan(0));

    const [, options] = registerCalls[0];
    const scope = options?.scope;
    expect(typeof scope).toBe('string');
    // A ServiceWorker registration is keyed by SCOPE. The FCM worker must be a
    // STRICT sub-path of the workbox `/mobile/` scope: prefixed by it AND strictly
    // longer than it. Equal scope would EVICT the workbox SW (break precache);
    // a non-/mobile scope would 404 behind the reverse proxy (break push). Both
    // failure modes are excluded here in one disjointness assertion.
    const WORKBOX_SCOPE = '/mobile/';
    expect(scope?.startsWith(WORKBOX_SCOPE)).toBe(true);
    expect((scope ?? '').length).toBeGreaterThan(WORKBOX_SCOPE.length);
    expect(scope).not.toBe(WORKBOX_SCOPE);
  });

  it('passes the Firebase config to the static SW as URL query params', async () => {
    render(<HookHost />);

    await waitFor(() => expect(registerCalls.length).toBeGreaterThan(0));

    const [scriptURL] = registerCalls[0];
    const params = new URL(scriptURL, 'https://host.example').searchParams;
    expect(params.get('apiKey')).toBe('api-key');
    expect(params.get('projectId')).toBe('project-id');
    expect(params.get('messagingSenderId')).toBe('sender-id');
    expect(params.get('appId')).toBe('app-id');
  });
});
