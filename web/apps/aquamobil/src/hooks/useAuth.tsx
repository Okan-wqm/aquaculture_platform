import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { del } from 'idb-keyval';
import type { AuthState } from '@/types';
import { clearAllOperations, clearCache } from '@/pwa/offline-queue';
import { syncAuthStore } from '@/services/authenticated-fetch';
import { clearBiometricData } from '@/hooks/useWebAuthn';

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
  logout: () => void;
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

// SEC-06: All fetch calls include X-Requested-With for CSRF defense-in-depth
const CSRF_HEADER = { 'X-Requested-With': 'XMLHttpRequest' };

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
    const result = await response.json();
    return result.data?.getMyMobileSettings?.isMobileEnabled ?? true;
  } catch {
    // If we can't check, allow access (graceful degradation)
    return true;
  }
}

// BUG-03 / SEC-02 / SEC-04: Coordinated teardown of all user data stores on logout.
// Clears offline queue (IndexedDB), data cache (IndexedDB), permissions cache (IndexedDB),
// biometric localStorage PII, and service worker Cache Storage to prevent data leakage
// on shared devices.
// SECURITY (FE-CRITICAL-002): clearCache() without tenantId clears ALL tenant
// namespaces on logout, preventing any residual cached data from leaking to
// the next user on a shared device.
async function clearAllUserData(userId?: string): Promise<void> {
  // H-FE-01: Clear biometric PII (webauthn_email, webauthn_credential_ids) on logout
  // so the next user on a shared device cannot use or see prior user's biometric data.
  clearBiometricData();

  await Promise.all([
    clearAllOperations(),
    clearCache(), // No tenantId = clear ALL tenants' cache entries
    // Clear per-user and legacy permission cache keys
    del(`mobile_permissions${userId ? `_${userId}` : ''}`).catch(() => {}),
    del('mobile_permissions').catch(() => {}),
    // Clear service worker Cache Storage (CRIT-2 / SEC-02)
    caches.delete('api-cache').catch(() => {}),
  ]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
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
    const restoreSession = async () => {
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

        const result = await response.json();
        if (result.errors || !result.data?.refreshToken?.accessToken) {
          setIsLoading(false);
          return;
        }

        const { accessToken, user } = result.data.refreshToken;
        const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email.split('@')[0];

        setState({
          user: { ...user, name: displayName },
          accessToken,
          refreshToken: null,
          tenantId: user.tenantId,
          isAuthenticated: true,
        });
      } catch {
        // No valid session
      } finally {
        setIsLoading(false);
      }
    };

    restoreSession();
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

      const result = await response.json();

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
          role: user.role as 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MANAGER' | 'OPERATOR' | 'VIEWER',
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

  const logout = useCallback(() => {
    const currentUserId = state.user?.id;

    // Call logout mutation to clear httpOnly cookie server-side
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
    }).catch(() => {});

    // BUG-03 / SEC-02 / SEC-04: Clear all user data stores before resetting state.
    // Fire-and-forget — UI resets immediately, cleanup runs async.
    clearAllUserData(currentUserId).catch(() => {});

    // C-FE-01: Notify service worker to clear messaging caches (messaging-graphql-v1,
    // messaging-media-v1). Without this, authenticated GraphQL responses remain in
    // Cache Storage and are visible to the next user on shared devices.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then((reg) => reg.active?.postMessage({ type: 'LOGOUT' }))
        .catch(() => {});
    }

    setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      tenantId: null,
      isAuthenticated: false,
    });
    setIsMobileDisabled(false);
  }, [state.accessToken, state.user?.id]);

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

      const result = await response.json();

      if (result.errors || !result.data?.refreshToken?.accessToken) {
        logout();
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
            user: prev.user ? { ...prev.user, ...refreshedUser, name: displayName } : prev.user,
          };
        }
        return { ...prev, accessToken };
      });
    } catch {
      logout();
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

      const result = await response.json();

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
            user: prev.user ? { ...prev.user, ...refreshedUser, name: displayName } : prev.user,
          };
        }
        return { ...prev, accessToken: newToken };
      });

      // Also update the module store immediately so the retry uses the new token
      // without waiting for the next React render cycle.
      syncAuthStore(newToken, freshTenantId, refreshAuthForInterceptor);

      return true;
    } catch {
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tenantId]);

  useEffect(() => {
    syncAuthStore(state.accessToken, state.tenantId, refreshAuthForInterceptor);
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
