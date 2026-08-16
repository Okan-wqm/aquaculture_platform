/**
 * Token Lifecycle Manager
 *
 * Enterprise-grade token lifecycle management for the aquaculture platform.
 *
 * Problem: Access token is in-memory only. On page refresh, silentRefresh()
 * runs async while MFE components render and fire requests - no token yet - 401.
 *
 * Solution: A state machine with a "ready barrier" that all API requests await
 * before executing. This ensures no request fires until the token is available.
 *
 * State machine: INITIALIZING -> REFRESHING -> READY -> EXPIRED -> REFRESHING
 *
 * MFE Bridge: Syncs state via window.__AQUACULTURE_AUTH_STATE__ so all
 * micro-frontends share a single lifecycle instance.
 */

import { isTenantPermissionCode, type TenantPermissionCode } from '@platform/tenant-permissions';

// ============================================================================
// Types
// ============================================================================

export type TokenState = 'INITIALIZING' | 'REFRESHING' | 'READY' | 'EXPIRED';

export interface TokenLifecycleManager {
  /** Current state of the token lifecycle */
  getState(): TokenState;
  /** Returns a Promise that resolves when the token is READY. All requests should await this. */
  waitForReady(): Promise<void>;
  /** Called once on app startup. Attempts silent refresh and transitions to READY or EXPIRED. */
  initialize(): Promise<boolean>;
  /** Called when an access token is successfully set (login, refresh, etc.) */
  notifyTokenSet(accessToken: string): void;
  /** Called when a token is cleared (NOT session end - just token invalidation) */
  notifyTokenCleared(): void;
  /** Cleanup timers and listeners */
  destroy(): void;
}

/** Shape of the MFE bridge on window */
interface AuthStateBridge {
  lifecycle: TokenLifecycleManager;
}

declare global {
  interface Window {
    __AQUACULTURE_AUTH_STATE__?: AuthStateBridge;
  }
}

// ============================================================================
// Constants
// ============================================================================

/** Refresh the token proactively at 80% of its TTL */
const PROACTIVE_REFRESH_RATIO = 0.8;

/** Maximum number of consecutive refresh retries before giving up */
const MAX_REFRESH_RETRIES = 3;

/** Minimum time (ms) before scheduling a proactive refresh (safety floor) */
const MIN_REFRESH_INTERVAL_MS = 10_000; // 10 seconds

/** Maximum time (ms) for the ready barrier before timing out */
const READY_BARRIER_TIMEOUT_MS = 15_000; // 15 seconds

// ============================================================================
// JWT Decode Helper (no signature verification - just reads exp claim)
// ============================================================================

/**
 * Decode the payload of a JWT to extract the `exp` claim.
 * Does NOT verify the signature - that is the server's responsibility.
 * Returns the expiry as a Unix timestamp (seconds), or null if unreadable.
 */
function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Base64url decode the payload (middle part)
    const payload = parts[1];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(padded);
    const parsed = JSON.parse(decoded);

    if (typeof parsed.exp === 'number') {
      return parsed.exp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode the tenant-RBAC `resourcePermissions` claim (array of `resource:action`
 * capability strings) from a JWT payload. Does NOT verify the signature — this
 * is for UI visibility only (show/hide granted actions); the backend
 * TenantPermissionGuard independently enforces every action. The claim is
 * omitted from the token when empty (and for admins, who bypass), so a missing
 * or malformed claim yields an empty list (fail-closed for UI: nothing extra
 * shown). Exported so the auth layer can attach it to the current user.
 */
export function decodeResourcePermissions(token: string): TenantPermissionCode[] {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return [];

    const payload = parts[1];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(padded));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const resourcePermissions = Reflect.get(parsed, 'resourcePermissions');

    if (Array.isArray(resourcePermissions) && resourcePermissions.every(isTenantPermissionCode)) {
      return resourcePermissions;
    }
    return [];
  } catch {
    return [];
  }
}

// ============================================================================
// Implementation
// ============================================================================

class TokenLifecycleManagerImpl implements TokenLifecycleManager {
  private state: TokenState = 'INITIALIZING';

  /** The barrier promise that callers await. Resolves when state becomes READY. */
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (reason: Error) => void;

  /** Timer for proactive token refresh */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Consecutive refresh failure counter */
  private refreshRetryCount = 0;

  /** Whether initialize() has been called */
  private initialized = false;

  constructor() {
    // Create the initial barrier.
    // Attach a no-op catch handler to prevent "Uncaught (in promise)" when
    // resolveBarrierAsExpired() rejects this barrier during failed initialization.
    // Actual rejection handling is done by waitForReady() callers.
    this.readyPromise = this.createBarrier();
    this.readyPromise.catch(() => {
      /* handled by waitForReady() callers */
    });
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  getState(): TokenState {
    return this.state;
  }

  waitForReady(): Promise<void> {
    // If already READY, resolve immediately
    if (this.state === 'READY') {
      return Promise.resolve();
    }

    // If EXPIRED and not refreshing, reject immediately
    if (this.state === 'EXPIRED') {
      return Promise.reject(new Error('Token expired, please login again'));
    }

    // If initialize() was never called, don't block requests.
    // This preserves backward compatibility: requests can proceed without
    // the lifecycle being explicitly initialized (e.g., in tests, or when
    // the shell hasn't mounted AuthProvider yet but an MFE fires a request).
    if (!this.initialized && this.state === 'INITIALIZING') {
      return Promise.resolve();
    }

    // Otherwise wait on the barrier with a timeout (REFRESHING state after init)
    return Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error('Auth initialization timed out')),
          READY_BARRIER_TIMEOUT_MS,
        );
      }),
    ]);
  }

  async initialize(): Promise<boolean> {
    if (this.initialized) {
      // Already initialized - just wait for ready
      if (this.state === 'READY') return true;
      try {
        await this.waitForReady();
        return true;
      } catch {
        return false;
      }
    }

    this.initialized = true;
    this.transition('REFRESHING');

    try {
      // Dynamic import to avoid circular dependency
      const { silentRefresh, getAccessToken } = await import('./api-client');

      const token = getAccessToken();
      if (token) {
        // Already have a token in memory (e.g. HMR, or set before initialize)
        this.onTokenAcquired(token);
        return true;
      }

      // Attempt silent refresh via httpOnly cookie
      const success = await silentRefresh();
      if (success) {
        const newToken = getAccessToken();
        if (newToken) {
          this.onTokenAcquired(newToken);
          return true;
        }
      }

      // No session to restore - new visitor or expired refresh token
      this.transition('EXPIRED');
      this.resolveBarrierAsExpired();
      return false;
    } catch {
      this.transition('EXPIRED');
      this.resolveBarrierAsExpired();
      return false;
    }
  }

  notifyTokenSet(accessToken: string): void {
    this.refreshRetryCount = 0;
    this.onTokenAcquired(accessToken);
  }

  notifyTokenCleared(): void {
    this.clearRefreshTimer();

    // If we're already in REFRESHING state, don't transition to EXPIRED
    // because handleUnauthorized is in progress
    if (this.state !== 'REFRESHING') {
      this.transition('EXPIRED');
      // Reject old barrier so any waiters get an error instead of hanging forever
      try {
        this.readyReject?.(new Error('Token cleared'));
      } catch {
        // Already resolved/rejected
      }
      // Create a fresh barrier for subsequent waitForReady() calls
      this.readyPromise = this.createBarrier();
      this.readyPromise.catch(() => {
        /* handled by waitForReady() callers */
      });
    }
  }

  destroy(): void {
    this.clearRefreshTimer();
    // Resolve any pending barrier to avoid dangling promises
    try {
      this.readyResolve?.();
    } catch {
      // Already resolved/rejected
    }
    // Reset state so the singleton can be re-initialized (e.g., after SPA navigation)
    this.initialized = false;
    this.state = 'INITIALIZING';
    this.refreshRetryCount = 0;
    this.readyPromise = this.createBarrier();
    this.readyPromise.catch(() => {
      /* handled by waitForReady() callers */
    });
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private createBarrier(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  private transition(newState: TokenState): void {
    const prevState = this.state;
    this.state = newState;

    if (import.meta.env.DEV) {
      console.debug(`[TokenLifecycle] ${prevState} -> ${newState}`);
    }
  }

  /**
   * Called when a valid token is acquired (login, refresh, silent refresh).
   * Transitions to READY, resolves the barrier, and schedules proactive refresh.
   */
  private onTokenAcquired(token: string): void {
    this.transition('READY');

    // Resolve the barrier so all waiting requests can proceed
    try {
      this.readyResolve?.();
    } catch {
      // Already resolved
    }

    // Schedule proactive refresh based on JWT expiry
    this.scheduleProactiveRefresh(token);
  }

  /**
   * Reject the barrier when we know auth is not possible
   * (no refresh token, max retries exceeded, etc.)
   */
  private resolveBarrierAsExpired(): void {
    try {
      // We reject so waitForReady() callers get an error
      this.readyReject?.(new Error('Authentication failed'));
    } catch {
      // Already resolved/rejected
    }
  }

  /**
   * Schedule a proactive token refresh at 80% of the token's TTL.
   * This prevents the token from expiring while the user is active.
   */
  private scheduleProactiveRefresh(token: string): void {
    this.clearRefreshTimer();

    const exp = decodeJwtExp(token);
    if (!exp) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const ttlSec = exp - nowSec;

    if (ttlSec <= 0) {
      // Token already expired
      this.triggerProactiveRefresh();
      return;
    }

    const refreshAtMs = Math.max(ttlSec * PROACTIVE_REFRESH_RATIO * 1000, MIN_REFRESH_INTERVAL_MS);

    if (import.meta.env.DEV) {
      console.debug(
        `[TokenLifecycle] Token TTL: ${ttlSec}s, scheduling refresh in ${Math.round(refreshAtMs / 1000)}s`,
      );
    }

    this.refreshTimer = setTimeout(() => {
      this.triggerProactiveRefresh();
    }, refreshAtMs);
  }

  /**
   * Proactively refresh the token before it expires.
   */
  private async triggerProactiveRefresh(): Promise<void> {
    if (this.state !== 'READY' && this.state !== 'EXPIRED') return;

    this.transition('REFRESHING');

    // Create a fresh barrier so new requests wait during refresh
    this.readyPromise = this.createBarrier();
    // Prevent unhandled rejection if silentRefresh() fails —
    // waitForReady() callers handle the rejection themselves.
    this.readyPromise.catch(() => {
      /* handled by waitForReady() callers */
    });

    try {
      const { silentRefresh, getAccessToken } = await import('./api-client');

      const success = await silentRefresh();
      if (success) {
        const newToken = getAccessToken();
        if (newToken) {
          this.refreshRetryCount = 0;
          this.onTokenAcquired(newToken);
          return;
        }
      }

      // Refresh failed - retry or give up
      this.handleRefreshFailure();
    } catch {
      this.handleRefreshFailure();
    }
  }

  /**
   * Handle a failed proactive refresh — if the current token is still valid,
   * fall back to READY instead of disrupting the user. Only give up when
   * the token is truly expired AND retries are exhausted.
   */
  private async handleRefreshFailure(): Promise<void> {
    this.refreshRetryCount++;

    // Bug 9 fix: Check if current token is still valid before escalating
    try {
      const { getAccessToken } = await import('./api-client');
      const currentToken = getAccessToken();
      if (currentToken) {
        const exp = decodeJwtExp(currentToken);
        if (exp && exp > Date.now() / 1000 + 30) {
          // Token still has > 30s of life — stay READY, don't disrupt user
          if (import.meta.env.DEV) {
            console.debug(
              `[TokenLifecycle] Proactive refresh failed but token still valid (exp in ${Math.round(exp - Date.now() / 1000)}s), staying READY`,
            );
          }
          this.transition('READY');
          try {
            this.readyResolve?.();
          } catch {
            /* already resolved */
          }
          // Re-schedule with remaining TTL
          this.scheduleProactiveRefresh(currentToken);
          return;
        }
      }
    } catch {
      // Import failed or token unreadable — continue with retry/expiry logic
    }

    if (this.refreshRetryCount < MAX_REFRESH_RETRIES) {
      if (import.meta.env.DEV) {
        console.debug(
          `[TokenLifecycle] Proactive refresh failed, retry ${this.refreshRetryCount}/${MAX_REFRESH_RETRIES}`,
        );
      }
      // Store retry timer in refreshTimer so clearRefreshTimer() can cancel it
      this.clearRefreshTimer();
      this.refreshTimer = setTimeout(() => this.triggerProactiveRefresh(), 2000);
    } else {
      if (import.meta.env.DEV) {
        console.debug('[TokenLifecycle] Max refresh retries exceeded, redirecting to /login');
      }
      this.transition('EXPIRED');
      this.resolveBarrierAsExpired();
      this.redirectToLogin();
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private redirectToLogin(): void {
    if (typeof window !== 'undefined') {
      // Use location.replace to avoid polluting browser history
      window.location.replace('/login');
    }
  }
}

// ============================================================================
// Singleton (MFE-aware via window bridge)
// ============================================================================

function createOrReuseSingleton(): TokenLifecycleManager {
  if (typeof window !== 'undefined' && window.__AQUACULTURE_AUTH_STATE__?.lifecycle) {
    // Another bundle (e.g. shell) already created the singleton - reuse it
    return window.__AQUACULTURE_AUTH_STATE__.lifecycle;
  }

  const instance = new TokenLifecycleManagerImpl();

  if (typeof window !== 'undefined') {
    // Install on window for cross-MFE access
    // Use Object.defineProperty for tamper-resistance, matching __AQUACULTURE_AUTH__ pattern
    try {
      const bridge: AuthStateBridge = Object.freeze({ lifecycle: instance });
      Object.defineProperty(window, '__AQUACULTURE_AUTH_STATE__', {
        value: bridge,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch {
      // Property already defined (non-configurable) - another bundle beat us to it.
      // Use the existing one.
      if (window.__AQUACULTURE_AUTH_STATE__?.lifecycle) {
        return window.__AQUACULTURE_AUTH_STATE__.lifecycle;
      }
      // Fallback: just use our local instance (shouldn't happen in practice)
    }
  }

  return instance;
}

/**
 * Singleton token lifecycle manager.
 * Shared across all Module Federation bundles via window.__AQUACULTURE_AUTH_STATE__.
 */
export const tokenLifecycle: TokenLifecycleManager = createOrReuseSingleton();

export default tokenLifecycle;
