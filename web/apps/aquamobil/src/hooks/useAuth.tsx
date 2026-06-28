import { useQueryClient } from '@tanstack/react-query';
import { del } from 'idb-keyval';
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactElement, type ReactNode } from 'react';

import { clearBiometricData } from '@/hooks/useWebAuthn';
import { clearAllOperations, clearCache } from '@/pwa/offline-queue';
import { markAuthReady, resetAuthReady, syncAuthStore } from '@/services/authenticated-fetch';
import { runPushTeardown } from '@/services/push-lifecycle';
import type { AccessType, AuthState } from '@/types';
import { normalizeRole } from '@/utils/normalize-role';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

interface AuthContextValue extends AuthState {
  isLoading: boolean;
  isMobileDisabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  /**
   * Complete login with pre-obtained token (e.g., from WebAuthn biometric flow).
   * Sets auth state directly without calling the login GraphQL mutation.
   */
  loginWithToken: (accessToken: string, user: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    role: string;
    tenantId: string | null;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// WHY: Fetch accessType on login so the mobile app can immediately enforce
// platform access restrictions without a separate mobile-settings round-trip.
const LOGIN_MUTATION = `
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      accessToken
      refreshToken
      user {
        id
        email
        firstName
        lastName
        role
        tenantId
        accessType
      }
    }
  }
`;

const REFRESH_MUTATION = `
  mutation RefreshToken($input: RefreshTokenInput!) {
    refreshToken(input: $input) {
      accessToken
      user {
        id
        email
        firstName
        lastName
        role
        tenantId
        accessType
      }
    }
  }
`;

const MOBILE_SETTINGS_QUERY = `
  query GetMyMobileSettings {
    getMyMobileSettings {
      isMobileEnabled
    }
  }
`;

// ---------------------------------------------------------------------------
// Typed GraphQL response shapes — FE-MEDIUM-051
// ---------------------------------------------------------------------------
// WHY: the auth mutations above are issued as INLINE fetch strings (invisible
// to codegen), so `await response.json()` returns `any` and every field access
// on the result was unsafe (`no-unsafe-member-access`). Typing the parsed body
// at the trust boundary is the root-cause fix: the LOGIN/REFRESH `user` shape is
// known, so `user.role` is a typed `string` that `normalizeRole` then narrows to
// the canonical `Role`. The role itself stays an UNVALIDATED string here — the
// server's value is only trusted after normalizeRole fail-closes it. The shapes
// mirror the selection sets of LOGIN_MUTATION / REFRESH_MUTATION exactly.

/** The `user { ... }` selection shared by LOGIN_MUTATION and REFRESH_MUTATION. */
interface AuthUserPayload {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Raw server role string — normalized to the canonical `Role` before use. */
  role: string;
  tenantId: string | null;
  accessType?: AccessType;
}

interface GraphQLError {
  message: string;
}

interface LoginResponse {
  errors?: GraphQLError[];
  data?: { login?: { accessToken: string; user: AuthUserPayload } | null };
}

interface RefreshResponse {
  errors?: GraphQLError[];
  data?: {
    refreshToken?: { accessToken: string; user?: AuthUserPayload | null } | null;
  };
}

interface MobileSettingsResponse {
  data?: { getMyMobileSettings?: { isMobileEnabled?: boolean | null } | null };
}

/**
 * Parse a fetch Response body as a typed GraphQL envelope. Centralizes the ONE
 * `any`-producing boundary (`response.json()`) behind an explicit cast so every
 * callsite reads a typed shape instead of `any`. The shape is asserted, not
 * validated — the only field whose value is trusted (role) is fail-closed by
 * `normalizeRole` downstream.
 */
async function parseGraphQL<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// SEC-06: All fetch calls include X-Requested-With for CSRF defense-in-depth
const CSRF_HEADER = { 'X-Requested-With': 'XMLHttpRequest' };
const SILENT_REFRESH_TIMEOUT_MS = 8000;

async function checkMobileEnabled(token: string): Promise<boolean> {
  try {
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...CSRF_HEADER,
      },
      credentials: 'include',
      body: JSON.stringify({ query: MOBILE_SETTINGS_QUERY }),
    });
    const result = await parseGraphQL<MobileSettingsResponse>(response);
    return result.data?.getMyMobileSettings?.isMobileEnabled ?? true;
  } catch {
    // SECURITY: Fail-closed — if we can't verify mobile access, deny it.
    // Returning true here would allow privilege escalation via network isolation.
    return false;
  }
}

// BUG-03 / SEC-02 / SEC-04: Coordinated teardown of all user data stores on logout.
// Clears offline queue (IndexedDB), data cache (IndexedDB), permissions cache (IndexedDB),
// biometric localStorage PII, and service worker Cache Storage to prevent data leakage
// on shared devices.
// SECURITY (FE-CRITICAL-002): clearCache() without tenantId clears ALL tenant
// namespaces on logout, preventing any residual cached data from leaking to
// the next user on a shared device.
async function clearAllUserData(userId?: string, tenantId?: string | null): Promise<void> {
  // H-FE-01: Clear biometric PII (webauthn_email, webauthn_credential_ids) on logout
  // so the next user on a shared device cannot use or see prior user's biometric data.
  clearBiometricData();

  // SEC: Clear the two UNSCOPED localStorage keys that otherwise persist across
  // users on a shared field device — the water-quality MRU equipment list and the
  // last-sync timestamp. Neither is tenant/user-namespaced, so without this the
  // next user sees the prior user's MRU + sync time. Mirrors the biometric wipe.
  try {
    localStorage.removeItem('aquamobil-wq-mru');
    localStorage.removeItem('aquamobil_last_sync_at');
  } catch {
    // localStorage unavailable (private mode / SSR) — non-fatal.
  }

  await Promise.all([
    clearAllOperations(),
    clearCache(), // No tenantId = clear ALL tenants' cache entries
    // SECURITY: Clear tenant-scoped, per-user, and legacy permission cache keys.
    // The tenant-scoped key is the current format; the others are legacy fallbacks.
    ...(userId && tenantId
      ? [del(`mobile_permissions_${tenantId}_${userId}`).catch(() => undefined)]
      : []),
    del(`mobile_permissions${userId ? `_${userId}` : ''}`).catch(() => undefined),
    del('mobile_permissions').catch(() => undefined),
    // Clear service worker Cache Storage (CRIT-2 / SEC-02)
    caches.delete('api-cache').catch(() => undefined),
  ]);
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  // MT-CRITICAL-050: AuthProvider is mounted inside <QueryClientProvider> (main.tsx),
  // so it can reach the shared QueryClient. Logout AWAITS a full removal of the
  // in-memory React Query cache here — otherwise tenant-A's cached query data
  // survives for the 24h gcTime and is served to the next login on a shared device.
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    user: null,
    accessToken: null,
    refreshToken: null,
    tenantId: null,
    isAuthenticated: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isMobileDisabled, setIsMobileDisabled] = useState(false);

  // On mount: attempt silent refresh via httpOnly cookie
  useEffect(() => {
    const restoreSession = async (): Promise<void> => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), SILENT_REFRESH_TIMEOUT_MS);

      try {
        const response = await fetch('/graphql', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...CSRF_HEADER,
          },
          credentials: 'include',
          body: JSON.stringify({
            query: REFRESH_MUTATION,
            variables: { input: { refreshToken: '' } },
          }),
        });

        const result = await parseGraphQL<RefreshResponse>(response);
        if (result.errors || !result.data?.refreshToken?.accessToken) {
          setIsLoading(false);
          return;
        }

        const { accessToken, user } = result.data.refreshToken;
        if (!user) {
          setIsLoading(false);
          return;
        }
        const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email.split('@')[0];

        // SECURITY: Fail-closed — reject PANEL_ONLY users and verify mobile access
        // before restoring an authenticated session on the mobile app.
        if (user.accessType === 'PANEL_ONLY') {
          setIsLoading(false);
          return;
        }

        const mobileEnabled = await checkMobileEnabled(accessToken);
        if (!mobileEnabled) {
          setIsMobileDisabled(true);
          setIsLoading(false);
          return;
        }

        setState({
          // FE-MEDIUM-051: normalize the server role string to the canonical
          // backend `Role` at the auth boundary (fail-closed) instead of casting.
          user: { ...user, name: displayName, role: normalizeRole(user.role) },
          accessToken,
          refreshToken: null,
          tenantId: user.tenantId,
          isAuthenticated: true,
        });
      } catch {
        // No valid session
      } finally {
        window.clearTimeout(timeoutId);
        setIsLoading(false);
        // WHY: unblock pending authenticatedFetch() calls — resolves the
        // authReadyPromise barrier whether restoreSession succeeded or not.
        // New visitors and expired-refresh-token users must also unblock.
        markAuthReady();
      }
    };

    // WHY void: restoreSession owns its own try/catch/finally (it never rejects
    // and unblocks the auth-ready barrier in finally), so it runs as a discarded
    // background task on mount.
    void restoreSession();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    setIsMobileDisabled(false);
    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...CSRF_HEADER,
        },
        credentials: 'include',
        body: JSON.stringify({
          query: LOGIN_MUTATION,
          variables: { input: { email, password } },
        }),
      });

      const result = await parseGraphQL<LoginResponse>(response);

      if (result.errors) {
        throw new Error(result.errors[0]?.message || 'Login failed');
      }

      // BUG-13: Null guard before destructuring login result
      if (!result.data?.login) {
        throw new Error('Login failed: no response data');
      }

      const { accessToken, user } = result.data.login;
      // refreshToken is now in httpOnly cookie, not in response body

      // WHY: Check accessType first — PANEL_ONLY users are forbidden from mobile
      // entirely, regardless of mobile_user_settings. This is a hard block.
      if (user.accessType === 'PANEL_ONLY') {
        setIsMobileDisabled(true);
        throw new Error('Mobile access is not enabled for your account. Please contact your administrator.');
      }

      // Check if user has mobile access enabled (mobile_user_settings granular check)
      const mobileEnabled = await checkMobileEnabled(accessToken);
      if (!mobileEnabled) {
        setIsMobileDisabled(true);
        throw new Error('Mobile access is not enabled for your account. Please contact your administrator.');
      }

      // Build display name from firstName + lastName
      const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email.split('@')[0];

      setState({
        user: {
          ...user,
          name: displayName,
          // FE-MEDIUM-051: normalize the server role to the canonical `Role`.
          role: normalizeRole(user.role),
        },
        accessToken,
        refreshToken: null,
        tenantId: user.tenantId,
        isAuthenticated: true,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loginWithToken = useCallback(async (
    accessToken: string,
    user: { id: string; email: string; firstName?: string; lastName?: string; role: string; tenantId: string | null },
  ) => {
    setIsLoading(true);
    setIsMobileDisabled(false);
    try {
      // Check if user has mobile access enabled
      const mobileEnabled = await checkMobileEnabled(accessToken);
      if (!mobileEnabled) {
        setIsMobileDisabled(true);
        throw new Error('Mobile access is not enabled for your account. Please contact your administrator.');
      }

      const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email.split('@')[0];

      setState({
        user: {
          id: user.id,
          email: user.email,
          name: displayName,
          // FE-MEDIUM-051: validate the inbound role against the canonical
          // backend `Role` (fail-closed) — no cast to a drifted union.
          role: normalizeRole(user.role),
          tenantId: user.tenantId,
        },
        accessToken,
        refreshToken: null,
        tenantId: user.tenantId,
        isAuthenticated: true,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  // MT-CRITICAL-050 / MT-MEDIUM-050: logout is ASYNC and AWAITS a full local
  // data wipe BEFORE the auth state is reset, so no window exists in which the
  // identity has flipped to "logged out" while tenant-A data is still resident.
  // The wipe (React Query in-memory cache + IndexedDB queue/cache + AES key +
  // biometric PII + SW Cache Storage) is awaited as a unit; a wipe FAILURE
  // REJECTS rather than presenting as a clean logout (MT-MEDIUM-050) — the auth
  // state is NOT reset and the caller surfaces the error so the user is not told
  // "logged out" while plaintext-recoverable data remains behind.
  const logout = useCallback(async (): Promise<void> => {
    const currentUserId = state.user?.id;
    const currentTenantId = state.tenantId;

    // MT-HIGH-050: tear down the FCM device token FIRST, while the JWT/cookie are
    // still valid, so the server-side unregisterDeviceToken call is authenticated
    // and the local FCM subscription (deleteToken) is dropped. Tolerated on
    // failure: the local deleteToken in the teardown's `finally` plus the SW
    // userId backstop already prevent prior-tenant push from surfacing, so a
    // network hiccup deregistering the token must not strand the user logged in.
    await runPushTeardown().catch(() => undefined);

    // Call logout mutation to clear httpOnly cookie server-side. This is the only
    // step that may legitimately fail without compromising local-data safety
    // (the server cookie expiry is independent of on-device residue), so it stays
    // fire-and-forget and does not gate the local wipe.
    fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {}),
        ...CSRF_HEADER,
      },
      credentials: 'include',
      body: JSON.stringify({
        query: `mutation { logout { success } }`,
      }),
    }).catch(() => undefined);

    // MT-CRITICAL-050: abort in-flight fetches BEFORE clearing. React Query
    // clear() does NOT cancel running requests, so a query dispatched before
    // logout could resolve during the awaited wipe below and repopulate the
    // cache we just cleared — a cross-user residue path on a shared device (the
    // repopulated entry then survives the 24h gcTime into user-B's session).
    // cancelQueries() rejects those in-flight promises so none writes back.
    await queryClient.cancelQueries();

    // MT-CRITICAL-050 / MT-MEDIUM-050: AWAIT the persistent-store wipe. Any
    // failure here propagates out of logout() (no .catch swallow), so a failed
    // IndexedDB/AES-key wipe can never masquerade as a successful logout.
    await clearAllUserData(currentUserId, currentTenantId);

    // C-FE-01: tell the page-controlling workbox SW to purge messaging Cache
    // Storage (messaging-graphql-v1, messaging-media-v1) — otherwise authenticated
    // GraphQL responses stay visible to the next user on a shared device. We post
    // to `controller` (the active worker that OWNS those caches), NOT
    // `serviceWorker.ready`: per spec `.ready` never rejects and stays pending
    // FOREVER until a worker is active (first-load race, plain-HTTP / iOS-PWA
    // contexts where the SW never activates), which would deadlock logout and
    // strand the user logged in. No controller ⇒ no SW cache exists to purge, so
    // skipping is correct.
    navigator.serviceWorker?.controller?.postMessage({ type: 'LOGOUT' });

    // MT-CRITICAL-050: wipe the in-memory React Query cache LAST — after the
    // awaited persistent wipe — so anything a still-mounted observer refetched
    // during the wipe window is dropped before the device is handed over.
    // removeQueries drops the tenant key space; clear() drops any residual
    // (untenanted) entry.
    if (currentTenantId) {
      // SSoT: createTenantQueryKey(currentTenantId) returns exactly
      // [TENANT_QUERY_KEY_ROOT, currentTenantId] — the whole tenant key space —
      // so the wipe targets the same prefix every tenant-scoped hook writes under,
      // using the factory rather than a hand-built array (no-bare-tenant-query-key).
      queryClient.removeQueries({ queryKey: createTenantQueryKey(currentTenantId) });
    }
    queryClient.clear();

    // FE-HIGH-055: re-arm the auth-ready barrier for the NEXT session BEFORE the
    // logged-out state is committed. Session 2's first authenticatedFetch then
    // blocks on a FRESH barrier that only re-resolves when session 2's own
    // restoreSession finally / login → syncAuthStore(token) → markAuthReady fires,
    // so a post-logout request can never fire on session-1's stale token. This is
    // also the single re-arm for the FE-HIGH-054 single-flight fail-closed path:
    // that path calls this logout exactly once, which re-arms the barrier exactly
    // once.
    resetAuthReady();

    setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      tenantId: null,
      isAuthenticated: false,
    });
    setIsMobileDisabled(false);
  }, [queryClient, state.accessToken, state.user?.id, state.tenantId]);

  // BUG-18: refreshAuth must update tenantId from the fresh server response.
  // Previously only accessToken was extracted, leaving tenantId stale in React
  // state. When the old token expired, the stale tenantId was sent as
  // X-Tenant-Id header and was inconsistent with the JWT's own tenantId claim,
  // causing "Tenant ID is required" errors on downstream subgraph calls.
  const refreshAuth = useCallback(async () => {
    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...CSRF_HEADER,
        },
        credentials: 'include',
        body: JSON.stringify({
          query: REFRESH_MUTATION,
          variables: { input: { refreshToken: '' } },
        }),
      });

      const result = await parseGraphQL<RefreshResponse>(response);

      if (result.errors || !result.data?.refreshToken?.accessToken) {
        await logout();
        return;
      }

      const { accessToken, user: refreshedUser } = result.data.refreshToken;

      setState((prev) => {
        // Update tenantId and user from the server response to keep them
        // in sync with the fresh JWT claims. If the server returns user data,
        // merge it; otherwise preserve existing state (defensive).
        if (refreshedUser) {
          const displayName = `${refreshedUser.firstName || ''} ${refreshedUser.lastName || ''}`.trim()
            || refreshedUser.email?.split('@')[0]
            || prev.user?.name
            || '';
          return {
            ...prev,
            accessToken,
            tenantId: refreshedUser.tenantId ?? prev.tenantId,
            // FE-MEDIUM-051: normalize the refreshed role to the canonical
            // `Role` (fail-closed); fall back to the prior role if the refresh
            // response omitted it so a partial response never strips privilege.
            user: prev.user
              ? { ...prev.user, ...refreshedUser, name: displayName, role: normalizeRole(refreshedUser.role ?? prev.user.role) }
              : prev.user,
          };
        }
        return { ...prev, accessToken };
      });
    } catch {
      await logout();
    }
  }, [logout]);

  // D07 API-01: Keep the module-level auth store in sync so that
  // authenticatedFetch (a plain function, not a hook) can read current tokens.
  // refreshAuthForInterceptor performs its own fetch (same mutation) and writes
  // the new token into both React state AND the module-level store synchronously
  // so the interceptor can retry immediately without waiting for a re-render.
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  // BUG-18: refreshAuthForInterceptor must also extract the fresh tenantId
  // from the server response, matching the fix applied to refreshAuth above.
  // The interceptor path is invoked by authenticatedFetch on 401 responses,
  // so stale tenantId here would cause the retried request to fail again.
  const refreshAuthForInterceptor = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...CSRF_HEADER,
        },
        credentials: 'include',
        body: JSON.stringify({
          query: REFRESH_MUTATION,
          variables: { input: { refreshToken: '' } },
        }),
      });

      const result = await parseGraphQL<RefreshResponse>(response);

      if (result.errors || !result.data?.refreshToken?.accessToken) {
        return false;
      }

      const { accessToken: newToken, user: refreshedUser } = result.data.refreshToken;
      const freshTenantId = refreshedUser?.tenantId ?? state.tenantId;

      // Update React state with fresh token and tenantId
      setState((prev) => {
        if (refreshedUser) {
          const displayName = `${refreshedUser.firstName || ''} ${refreshedUser.lastName || ''}`.trim()
            || refreshedUser.email?.split('@')[0]
            || prev.user?.name
            || '';
          return {
            ...prev,
            accessToken: newToken,
            tenantId: refreshedUser.tenantId ?? prev.tenantId,
            // FE-MEDIUM-051: normalize the refreshed role to the canonical
            // `Role` (fail-closed); preserve the prior role on a partial response.
            user: prev.user
              ? { ...prev.user, ...refreshedUser, name: displayName, role: normalizeRole(refreshedUser.role ?? prev.user.role) }
              : prev.user,
          };
        }
        return { ...prev, accessToken: newToken };
      });

      // Also update the module store immediately so the retry uses the new token
      // without waiting for the next React render cycle.
      syncAuthStore(newToken, freshTenantId, refreshAuthForInterceptor, logoutRef.current);

      return true;
    } catch {
      return false;
    }
   
  }, [state.tenantId]);

  useEffect(() => {
    syncAuthStore(state.accessToken, state.tenantId, refreshAuthForInterceptor, logoutRef.current);
  }, [state.accessToken, state.tenantId, refreshAuthForInterceptor]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        isLoading,
        isMobileDisabled,
        login,
        loginWithToken,
        logout,
        refreshAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
