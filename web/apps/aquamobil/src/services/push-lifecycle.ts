// ============================================================================
// Push (FCM) device-token lifecycle registry — MT-HIGH-050
// ============================================================================
//
// AquaMobil runs on SHARED field devices. On logout the FCM device token must be
// torn down (FCM deleteToken() + server-side unregisterDeviceToken) BEFORE the
// session is cleared — otherwise push for tenant-A keeps reaching a phone now
// logged into tenant-B.
//
// WHY a module-level registry (mirroring authenticated-fetch's authStore):
//   useFirebaseMessaging is a hook and owns the live Firebase messaging instance
//   + the current token. logout() is also a hook callback but lives in useAuth,
//   which must NOT import firebase (it would pull the SDK into the auth bundle
//   and couple auth to messaging). This registry is the seam: useFirebaseMessaging
//   REGISTERS its teardown here while authenticated; logout AWAITS
//   runPushTeardown() as the FIRST step of the wipe, so the deregistration runs
//   while the JWT/cookie are still valid. One owner of the teardown
//   (useFirebaseMessaging), one invocation point (logout) — single lifecycle.

/**
 * Teardown callback contributed by the active push subscriber. Returns a promise
 * that resolves once the FCM token is deleted and the server mapping is removed.
 */
type PushTeardown = () => Promise<void>;

let activeTeardown: PushTeardown | null = null;

/**
 * Register the current push-teardown routine. Called by useFirebaseMessaging
 * once a device token is registered; called with `null` when the subscription is
 * torn down so a stale teardown is never invoked.
 */
export function registerPushTeardown(teardown: PushTeardown | null): void {
  activeTeardown = teardown;
}

/**
 * Run the registered push teardown, if any. Invoked by logout BEFORE the session
 * is cleared. Idempotent and safe to call when no subscriber is active (no-op).
 * The teardown is cleared after running so a second logout cannot double-invoke
 * a teardown bound to an already-deleted token.
 */
export async function runPushTeardown(): Promise<void> {
  const teardown = activeTeardown;
  if (!teardown) return;
  activeTeardown = null;
  await teardown();
}
