/**
 * Visibility-Aware Token Refresh
 *
 * SECURITY: FE-HIGH-006 — When a user closes their laptop lid or switches
 * tabs for an extended period, the access token expires. On return, the
 * first API request uses a stale token, gets a 401, and the user is
 * force-logged-out instead of having their token silently refreshed.
 *
 * This module registers a `visibilitychange` event listener that triggers
 * a proactive token refresh when the tab becomes visible again AND the
 * token is expired or about to expire.
 *
 * Integrates with the existing TokenLifecycleManager singleton so there's
 * exactly ONE refresh path, preventing duplicate refresh mutations.
 *
 * @see FE-HIGH-006
 */

import { tokenLifecycle } from './token-lifecycle';

// ============================================================================
// Constants
// ============================================================================

/** Minimum time (ms) the tab must be hidden before triggering a refresh on return */
const MIN_HIDDEN_DURATION_MS = 30_000; // 30 seconds

// ============================================================================
// State
// ============================================================================

let hiddenTimestamp: number | null = null;
let installed = false;

// ============================================================================
// Handler
// ============================================================================

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    hiddenTimestamp = Date.now();
    return;
  }

  // Tab became visible
  if (document.visibilityState === 'visible' && hiddenTimestamp !== null) {
    const hiddenDuration = Date.now() - hiddenTimestamp;
    hiddenTimestamp = null;

    // Only refresh if tab was hidden long enough for the token to potentially expire
    if (hiddenDuration >= MIN_HIDDEN_DURATION_MS) {
      const state = tokenLifecycle.getState();

      // If the lifecycle is READY, re-initialize to trigger a proactive refresh check.
      // If EXPIRED, also re-initialize to attempt session recovery.
      // If REFRESHING, another refresh is already in flight — do nothing.
      if (state === 'READY' || state === 'EXPIRED') {
        // Re-initialize triggers silentRefresh which checks token validity
        // and refreshes if needed, using the shared tokenRefreshPromise lock.
        tokenLifecycle.initialize().catch(() => {
          // Refresh failed — tokenLifecycle handles redirect to /login
        });
      }
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Install the visibilitychange listener.
 * Idempotent — safe to call multiple times (e.g., from both shell and MFE).
 *
 * Should be called once during app bootstrap, after tokenLifecycle is available.
 *
 * @example
 * // In shell bootstrap.tsx:
 * import { installVisibilityTokenRefresh } from '@aquaculture/shared-ui';
 * installVisibilityTokenRefresh();
 */
export function installVisibilityTokenRefresh(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  document.addEventListener('visibilitychange', handleVisibilityChange);
}

/**
 * Remove the visibilitychange listener.
 * Primarily for testing cleanup.
 */
export function uninstallVisibilityTokenRefresh(): void {
  if (!installed || typeof document === 'undefined') return;
  installed = false;
  hiddenTimestamp = null;

  document.removeEventListener('visibilitychange', handleVisibilityChange);
}
