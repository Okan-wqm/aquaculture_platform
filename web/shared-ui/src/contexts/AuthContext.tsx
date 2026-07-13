/**
 * Auth Context
 * Role-based authentication with automatic redirect support
 *
 * Supports:
 * - SUPER_ADMIN: System-wide access, no tenant
 * - TENANT_ADMIN: Tenant-wide access
 * - MODULE_MANAGER: Specific module management
 * - MODULE_USER: Limited module access
 */

import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo } from 'react';
import { setTokens, clearSession, getAccessToken, setTenantId, graphqlClient } from '../utils/api-client';
import { tokenLifecycle, decodeResourcePermissions } from '../utils/token-lifecycle';
import { logoutCleanup } from '../utils/logout-cleanup';

// ============================================================================
// Types
// ============================================================================

/**
 * User roles matching backend Role enum
 */
export type UserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER';

/**
 * Module info returned from backend
 */
export interface UserModule {
  code: string;
  name: string;
  defaultRoute: string;
}

/**
 * User entity from backend
 */
/**
 * WHY: accessType field lets frontend enforce platform access restrictions.
 * PANEL_ONLY users are blocked from mobile app, MOBILE_ONLY from web panel.
 */
export type AccessType = 'PANEL_ONLY' | 'MOBILE_ONLY' | 'BOTH';

export interface AuthUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: UserRole;
  tenantId?: string | null;
  accessType?: AccessType | null;
  isActive: boolean;
  /**
   * Tenant-RBAC capabilities granted to this user (`resource:action` strings),
   * decoded from the access token's `resourcePermissions` claim. Drives FE
   * action/UI visibility via useAuth().hasPermission — the backend enforces
   * independently. Empty for admins (who bypass) and for ungranted users.
   */
  resourcePermissions?: string[];
}

/**
 * Auth state
 */
interface AuthState {
  user: AuthUser | null;
  modules: UserModule[];
  redirectPath: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
}

type AuthBridgeSnapshot = Readonly<{
  user: AuthUser;
  modules: UserModule[];
  redirectPath: string;
  isAuthenticated: true;
  isLoading: false;
  error: null;
}>;

type AuthBridgeState = {
  snapshot: AuthBridgeSnapshot | null;
};

const AUTH_CONTEXT_BRIDGE_KEY = '__AQUACULTURE_AUTH_CONTEXT_STATE_V1__';

declare global {
  interface Window {
    __AQUACULTURE_AUTH_CONTEXT_STATE_V1__?: AuthBridgeState;
  }
}

/**
 * Auth actions
 */
type AuthAction =
  | { type: 'AUTH_START' }
  | { type: 'AUTH_SUCCESS'; payload: { user: AuthUser; modules: UserModule[]; redirectPath: string } }
  | { type: 'AUTH_FAILURE'; payload: string }
  | { type: 'LOGOUT' }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_LOADING'; payload: boolean };

/**
 * Login payload
 */
interface LoginPayload {
  email: string;
  password: string;
  /**
   * "Remember me" / stay logged in. When true the server issues a persistent
   * refresh cookie (vs a session cookie). The choice is made ONCE here, at the
   * password step — the MFA-verify step does NOT re-send it (the server carries
   * it through the signed mfaToken). Defaults false.
   */
  rememberMe?: boolean;
}

/**
 * MFA challenge result — returned when MFA is required during login
 */
export interface MfaChallengeResult {
  mfaRequired: true;
  mfaToken: string;
}

/**
 * MFA-setup-required result (ADR-045) — returned when the tenant ENFORCES MFA
 * but this user has none enrolled. No session tokens are issued; the
 * short-lived mfaSetupToken authorizes ONLY setupMfa + verifyMfaSetup so the
 * user can enroll and then log in again. A completable path, not a lockout.
 */
export interface MfaSetupRequiredResult {
  mfaSetupRequired: true;
  mfaSetupToken: string;
}

/**
 * Login result — a redirect path (normal login), an MFA challenge (user has MFA
 * and must verify), or an MFA-setup requirement (tenant enforces MFA, user must
 * enroll first).
 */
export type LoginResult =
  | { redirectPath: string }
  | MfaChallengeResult
  | MfaSetupRequiredResult;

/**
 * Verify MFA login payload
 */
interface VerifyMfaLoginPayload {
  mfaToken: string;
  code: string;
}

/**
 * Auth context value
 */
interface AuthContextValue extends AuthState {
  login: (payload: LoginPayload) => Promise<LoginResult>;
  verifyMfaLogin: (payload: VerifyMfaLoginPayload) => Promise<{ redirectPath: string }>;
  logout: () => Promise<void>;
  clearError: () => void;
  refreshAuth: () => Promise<void>;
  isSuperAdmin: () => boolean;
  isTenantAdmin: () => boolean;
  isModuleManager: () => boolean;
  isModuleUser: () => boolean;
  hasRoleOrHigher: (role: UserRole) => boolean;
  hasModuleAccess: (moduleCode: string) => boolean;
}

// ============================================================================
// Role Hierarchy (matching backend)
// ============================================================================

const ROLE_HIERARCHY: Record<UserRole, UserRole[]> = {
  SUPER_ADMIN: ['TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER'],
  TENANT_ADMIN: ['MODULE_MANAGER', 'MODULE_USER'],
  MODULE_MANAGER: ['MODULE_USER'],
  MODULE_USER: [],
};

function roleHasPermission(userRole: UserRole, requiredRole: UserRole): boolean {
  if (userRole === requiredRole) return true;
  return ROLE_HIERARCHY[userRole]?.includes(requiredRole) ?? false;
}

function roleHasModuleAccess(userRole: UserRole | undefined, modules: UserModule[], moduleCode: string): boolean {
  if (!userRole) return false;
  // SUPER_ADMIN has platform access, not tenant-module access.
  if (userRole === 'SUPER_ADMIN') return false;
  if (userRole === 'TENANT_ADMIN') return true;
  return modules.some((m) => m.code === moduleCode);
}

function getAuthBridgeState(): AuthBridgeState | null {
  if (typeof window === 'undefined') return null;

  const existing = window[AUTH_CONTEXT_BRIDGE_KEY];
  if (existing && typeof existing === 'object' && 'snapshot' in existing) {
    return existing;
  }

  const state: AuthBridgeState = { snapshot: null };
  try {
    Object.defineProperty(window, AUTH_CONTEXT_BRIDGE_KEY, {
      value: state,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    return null;
  }

  return state;
}

function createAuthBridgeSnapshot(payload: {
  user: AuthUser;
  modules: UserModule[];
  redirectPath: string;
}): AuthBridgeSnapshot {
  return Object.freeze({
    user: Object.freeze({ ...payload.user }),
    modules: Object.freeze(payload.modules.map((m) => Object.freeze({ ...m }))) as UserModule[],
    redirectPath: payload.redirectPath,
    isAuthenticated: true,
    isLoading: false,
    error: null,
  });
}

function publishAuthBridgeSnapshot(payload: {
  user: AuthUser;
  modules: UserModule[];
  redirectPath: string;
} | null): void {
  const bridge = getAuthBridgeState();
  if (!bridge) return;
  bridge.snapshot = payload ? createAuthBridgeSnapshot(payload) : null;
}

// ============================================================================
// Reducer
// ============================================================================

const initialState: AuthState = {
  user: null,
  modules: [],
  redirectPath: null,
  isLoading: true,
  isAuthenticated: false,
  error: null,
};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'AUTH_START':
      return { ...state, isLoading: true, error: null };

    case 'AUTH_SUCCESS':
      return {
        ...state,
        user: action.payload.user,
        modules: action.payload.modules,
        redirectPath: action.payload.redirectPath,
        isLoading: false,
        isAuthenticated: true,
        error: null,
      };

    case 'AUTH_FAILURE':
      return {
        ...state,
        user: null,
        modules: [],
        redirectPath: null,
        isLoading: false,
        isAuthenticated: false,
        error: action.payload,
      };

    case 'LOGOUT':
      return { ...initialState, isLoading: false };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };

    default:
      return state;
  }
}

// ============================================================================
// Context
// ============================================================================

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ============================================================================
// Provider
// ============================================================================

export interface AuthProviderProps {
  children: React.ReactNode;
  autoCheck?: boolean;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children, autoCheck = true }) => {
  const [state, dispatch] = useReducer(authReducer, initialState);

  /**
   * Fetch current user with modules and redirect path
   */
  const fetchMe = useCallback(async (): Promise<{
    user: AuthUser;
    modules: UserModule[];
    redirectPath: string;
  } | null> => {
    try {
      // WHY: Fetch accessType so frontend can enforce platform access restrictions
      // (block PANEL_ONLY users from mobile, MOBILE_ONLY users from web panel).
      const ME_QUERY = `
        query Me {
          me {
            user {
              id
              email
              firstName
              lastName
              role
              tenantId
              accessType
              isActive
            }
            modules {
              code
              name
              defaultRoute
            }
            redirectPath
          }
        }
      `;

      const response = await graphqlClient.request<{
        me: {
          user: AuthUser;
          modules: UserModule[];
          redirectPath: string;
        };
      }>(ME_QUERY);

      const me = response?.me ?? null;
      if (!me) return null;

      // Attach the tenant-RBAC capabilities from the access-token claim so
      // useAuth().hasPermission can gate action/UI visibility. The `me` query
      // intentionally does not carry them (they are a token concern); the token
      // is the same trust anchor the FE already uses for role/tenantId.
      const token = getAccessToken();
      const resourcePermissions = token ? decodeResourcePermissions(token) : [];
      return { ...me, user: { ...me.user, resourcePermissions } };
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('Failed to fetch user:', error);
      }
      return null;
    }
  }, []);

  /**
   * Initial auth check
   */
  useEffect(() => {
    if (!autoCheck) {
      dispatch({ type: 'SET_LOADING', payload: false });
      return;
    }

    const checkAuth = async () => {
      // Use lifecycle manager to initialize token.
      // This handles silent refresh, barrier management, and proactive refresh scheduling.
      const initialized = await tokenLifecycle.initialize();

      if (!initialized) {
        // No session to restore (new visitor or expired refresh token)
        dispatch({ type: 'AUTH_FAILURE', payload: '' });
        return;
      }

      // Token is ready — verify we actually have one
      const token = getAccessToken();
      if (!token) {
        dispatch({ type: 'AUTH_FAILURE', payload: '' });
        return;
      }

      dispatch({ type: 'AUTH_START' });

      const meData = await fetchMe();
      if (meData) {
        // Restore tenant ID from server response. Passing null is intentional:
        // SUPER_ADMIN sessions are platform-scoped and must clear any stale
        // tenant_id left by a previous tenant-scoped login.
        setTenantId(meData.user.tenantId ?? null);
        publishAuthBridgeSnapshot(meData);
        dispatch({ type: 'AUTH_SUCCESS', payload: meData });
      } else {
        clearSession();
        publishAuthBridgeSnapshot(null);
        dispatch({ type: 'AUTH_FAILURE', payload: '' });
      }
    };

    checkAuth();

    // NOTE: Do NOT call tokenLifecycle.destroy() here.
    // The lifecycle manager is a process-level singleton shared across MFE bundles.
    // Destroying it on AuthProvider unmount would permanently break the auth system
    // since the singleton cannot be recreated (window global is non-configurable).
    // The singleton's timers are cleaned up by the browser on page unload.
  }, [autoCheck, fetchMe]);

  /**
   * Login - returns redirect path for navigation, or MFA challenge if MFA is enabled
   */
  const login = useCallback(async (payload: LoginPayload): Promise<LoginResult> => {
    dispatch({ type: 'AUTH_START' });

    try {
      // WHY: Fetch accessType on login so platform access guard can be enforced
      // immediately without waiting for a separate me() query.
      const LOGIN_MUTATION = `
        mutation Login($input: LoginInput!) {
          login(input: $input) {
            accessToken
            refreshToken
            redirectUrl
            mfaRequired
            mfaToken
            mfaSetupRequired
            mfaSetupToken
            user {
              id
              email
              firstName
              lastName
              role
              tenantId
              accessType
              isActive
            }
          }
        }
      `;

      const response = await graphqlClient.request<{
        login: {
          accessToken: string;
          refreshToken: string;
          redirectUrl: string;
          mfaRequired?: boolean;
          mfaToken?: string;
          mfaSetupRequired?: boolean;
          mfaSetupToken?: string;
          user: AuthUser;
        };
      }>(LOGIN_MUTATION, {
        input: {
          email: payload.email,
          password: payload.password,
          rememberMe: payload.rememberMe ?? false,
        },
      });

      if (!response?.login) {
        throw new Error('Invalid server response');
      }

      // MFA required — return challenge info without completing login
      if (response.login.mfaRequired && response.login.mfaToken) {
        // Stop loading state but don't set error — MFA challenge UI will take over
        dispatch({ type: 'SET_LOADING', payload: false });
        return {
          mfaRequired: true,
          mfaToken: response.login.mfaToken,
        };
      }

      // ADR-045: tenant enforces MFA and this user has none enrolled. No tokens
      // are issued — hand back the setup token so the UI can drive enrollment
      // (setupMfa + verifyMfaSetup) and then send the user back to log in.
      if (response.login.mfaSetupRequired && response.login.mfaSetupToken) {
        dispatch({ type: 'SET_LOADING', payload: false });
        return {
          mfaSetupRequired: true,
          mfaSetupToken: response.login.mfaSetupToken,
        };
      }

      const { accessToken: loginAccessToken, user, redirectUrl } = response.login;

      // Save access token in memory (refresh token is set as httpOnly cookie by server)
      setTokens(loginAccessToken);

      // Save tenant ID for multi-tenant context. Null clears stale tenant scope
      // for platform-level SUPER_ADMIN sessions.
      setTenantId(user.tenantId ?? null);

      // Validate redirectUrl is a safe relative path (SEC-005: prevent open redirect)
      const safeRedirectUrl = sanitizeRedirectUrl(redirectUrl);
      const redirectPath = safeRedirectUrl || getDefaultRedirect(user.role);

      // Fetch user data with modules after login
      const meData = await fetchMe();
      if (!meData) {
        clearSession();
        publishAuthBridgeSnapshot(null);
        throw new Error('Session verification failed');
      }

      setTenantId(meData.user.tenantId ?? null);
      const authSuccessPayload = { user: meData.user, modules: meData.modules, redirectPath };
      publishAuthBridgeSnapshot(authSuccessPayload);
      dispatch({ type: 'AUTH_SUCCESS', payload: authSuccessPayload });

      return { redirectPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      dispatch({ type: 'AUTH_FAILURE', payload: message });
      throw error;
    }
  }, [fetchMe]);

  /**
   * Verify MFA login — completes login after MFA challenge
   */
  const verifyMfaLogin = useCallback(async (payload: VerifyMfaLoginPayload): Promise<{ redirectPath: string }> => {
    dispatch({ type: 'AUTH_START' });

    try {
      const VERIFY_MFA_LOGIN_MUTATION = `
        mutation VerifyMfaLogin($input: VerifyMfaLoginInput!) {
          verifyMfaLogin(input: $input) {
            accessToken
            refreshToken
            redirectUrl
            user {
              id
              email
              firstName
              lastName
              role
              tenantId
              accessType
              isActive
            }
          }
        }
      `;

      const response = await graphqlClient.request<{
        verifyMfaLogin: {
          accessToken: string;
          refreshToken: string;
          redirectUrl: string;
          user: AuthUser;
        };
      }>(VERIFY_MFA_LOGIN_MUTATION, {
        input: {
          mfaToken: payload.mfaToken,
          code: payload.code,
        },
      });

      if (!response?.verifyMfaLogin) {
        throw new Error('Invalid server response');
      }

      const { accessToken: loginAccessToken, user, redirectUrl } = response.verifyMfaLogin;

      // Save access token in memory (refresh token is set as httpOnly cookie by server)
      setTokens(loginAccessToken);

      // Save tenant ID for multi-tenant context. Null clears stale tenant scope
      // for platform-level SUPER_ADMIN sessions.
      setTenantId(user.tenantId ?? null);

      // Validate redirectUrl is a safe relative path (SEC-005: prevent open redirect)
      const safeRedirectUrl = sanitizeRedirectUrl(redirectUrl);
      const redirectPath = safeRedirectUrl || getDefaultRedirect(user.role);

      // Fetch user data with modules after login
      const meData = await fetchMe();
      if (!meData) {
        clearSession();
        publishAuthBridgeSnapshot(null);
        throw new Error('Session verification failed');
      }

      setTenantId(meData.user.tenantId ?? null);
      const authSuccessPayload = { user: meData.user, modules: meData.modules, redirectPath };
      publishAuthBridgeSnapshot(authSuccessPayload);
      dispatch({ type: 'AUTH_SUCCESS', payload: authSuccessPayload });

      return { redirectPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MFA verification failed';
      dispatch({ type: 'AUTH_FAILURE', payload: message });
      throw error;
    }
  }, [fetchMe]);

  /**
   * Logout
   *
   * SECURITY: FE-HIGH-005 — Uses logoutCleanup() to clear ALL browser
   * storage layers (in-memory tokens, sessionStorage, IndexedDB, Workbox
   * caches, service workers). This makes zombie tokens after logout
   * structurally impossible.
   */
  const logout = useCallback(async (): Promise<void> => {
    try {
      const LOGOUT_MUTATION = `
        mutation Logout {
          logout {
            success
          }
        }
      `;
      await graphqlClient.request(LOGOUT_MUTATION).catch(() => {});
    } finally {
      // FE-HIGH-005: Complete cleanup across all storage layers
      await logoutCleanup({ revokeServerToken: false });
      publishAuthBridgeSnapshot(null);
      dispatch({ type: 'LOGOUT' });
    }
  }, []);

  /**
   * Refresh auth state
   */
  const refreshAuth = useCallback(async (): Promise<void> => {
    const meData = await fetchMe();
    if (meData) {
      setTenantId(meData.user.tenantId ?? null);
      publishAuthBridgeSnapshot(meData);
      dispatch({ type: 'AUTH_SUCCESS', payload: meData });
    } else {
      publishAuthBridgeSnapshot(null);
      dispatch({ type: 'AUTH_FAILURE', payload: 'Session refresh failed' });
    }
  }, [fetchMe]);

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' });
  }, []);

  /**
   * Role check helpers
   * Depend on the primitive role string, not the full state.user object,
   * so they only get new identities when the role actually changes.
   */
  const userRole = state.user?.role;
  const isSuperAdmin = useCallback(() => userRole === 'SUPER_ADMIN', [userRole]);
  const isTenantAdmin = useCallback(() => userRole === 'TENANT_ADMIN', [userRole]);
  const isModuleManager = useCallback(() => userRole === 'MODULE_MANAGER', [userRole]);
  const isModuleUser = useCallback(() => userRole === 'MODULE_USER', [userRole]);

  const hasRoleOrHigher = useCallback(
    (role: UserRole): boolean => {
      if (!userRole) return false;
      return roleHasPermission(userRole, role);
    },
    [userRole]
  );

  const stateModules = state.modules;
  const hasModuleAccess = useCallback(
    (moduleCode: string): boolean => {
      return roleHasModuleAccess(userRole, stateModules, moduleCode);
    },
    [userRole, stateModules]
  );

  // PERF-001: Memoize context value to prevent full subtree re-render on every parent render
  const value = useMemo<AuthContextValue>(() => ({
    ...state,
    login,
    verifyMfaLogin,
    logout,
    clearError,
    refreshAuth,
    isSuperAdmin,
    isTenantAdmin,
    isModuleManager,
    isModuleUser,
    hasRoleOrHigher,
    hasModuleAccess,
  }), [state, login, verifyMfaLogin, logout, clearError, refreshAuth,
      isSuperAdmin, isTenantAdmin, isModuleManager,
      isModuleUser, hasRoleOrHigher, hasModuleAccess]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sanitize redirectUrl to prevent open redirect attacks (SEC-005).
 * Only allows relative paths starting with '/' that don't contain '//' or a protocol.
 */
function sanitizeRedirectUrl(url?: string | null): string | null {
  if (!url) return null;
  // Must start with '/', must not contain '//' (protocol-relative), must not contain ':'
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes(':')) {
    return url;
  }
  return null;
}

function getDefaultRedirect(role: UserRole): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return '/admin';
    case 'TENANT_ADMIN':
      return '/tenant';
    case 'MODULE_MANAGER':
    case 'MODULE_USER':
      return '/dashboard';
    default:
      return '/';
  }
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Safe auth context hook that works with Module Federation
 * Falls back to token-based auth when context is not available
 */
export function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);

  if (context !== undefined) {
    return context;
  }

  const bridgeSnapshot = getAuthBridgeState()?.snapshot ?? null;
  const bridgeToken = getAccessToken();
  if (bridgeSnapshot && bridgeToken) {
    const { user, modules, redirectPath } = bridgeSnapshot;
    return {
      user,
      modules,
      redirectPath,
      isLoading: false,
      isAuthenticated: true,
      error: null,
      login: async () => ({ redirectPath }),
      verifyMfaLogin: async () => ({ redirectPath }),
      logout: async () => {
        await logoutCleanup();
        publishAuthBridgeSnapshot(null);
        if (typeof window !== 'undefined') {
          window.location.replace('/login');
        }
      },
      clearError: () => {},
      refreshAuth: async () => {},
      isSuperAdmin: () => user.role === 'SUPER_ADMIN',
      isTenantAdmin: () => user.role === 'TENANT_ADMIN',
      isModuleManager: () => user.role === 'MODULE_MANAGER',
      isModuleUser: () => user.role === 'MODULE_USER',
      hasRoleOrHigher: (role: UserRole) => roleHasPermission(user.role, role),
      hasModuleAccess: (moduleCode: string) => roleHasModuleAccess(user.role, modules, moduleCode),
    };
  }

  // Fallback for Module Federation: fail closed unless a server-verified
  // snapshot was published by AuthProvider. Never trust client-decoded JWT
  // role claims for route authorization.
  if (import.meta.env.DEV) {
    console.warn('AuthContext not available — microfrontend loaded outside AuthProvider. Denying access.');
  }

  const fallbackValue: AuthContextValue = {
    user: null,
    modules: [],
    redirectPath: null,
    isLoading: false,
    isAuthenticated: false,
    error: null,
    login: async () => {
      if (import.meta.env.DEV) {
        console.warn('Login not available in microfrontend context');
      }
      return { redirectPath: '/' };
    },
    verifyMfaLogin: async () => {
      if (import.meta.env.DEV) {
        console.warn('MFA verification not available in microfrontend context');
      }
      return { redirectPath: '/' };
    },
    logout: async () => {
      // FE-HIGH-005: Complete cleanup even in MFE fallback context
      await logoutCleanup();
      // Use location.replace to avoid history pollution (SEC-008: avoid window.location.href anti-pattern)
      if (typeof window !== 'undefined') {
        window.location.replace('/login');
      }
    },
    clearError: () => {},
    refreshAuth: async () => {},
    isSuperAdmin: () => false,
    isTenantAdmin: () => false,
    isModuleManager: () => false,
    isModuleUser: () => false,
    hasRoleOrHigher: () => false,
    hasModuleAccess: () => false,
  };

  return fallbackValue;
}

export default AuthContext;
