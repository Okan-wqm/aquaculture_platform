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

import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import { setTokens, clearTokens, loadTokensFromStorage, getAccessToken, setTenantId, graphqlClient } from '../utils/api-client';

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
export interface AuthUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: UserRole;
  tenantId?: string | null;
  isActive: boolean;
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
}

/**
 * Auth context value
 */
interface AuthContextValue extends AuthState {
  login: (payload: LoginPayload) => Promise<{ redirectPath: string }>;
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

      return response?.me ?? null;
    } catch (error) {
      console.error('Failed to fetch user:', error);
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
      loadTokensFromStorage();

      const token = getAccessToken();
      if (!token) {
        dispatch({ type: 'AUTH_FAILURE', payload: '' });
        return;
      }

      dispatch({ type: 'AUTH_START' });

      const meData = await fetchMe();
      if (meData) {
        dispatch({ type: 'AUTH_SUCCESS', payload: meData });
      } else {
        clearTokens();
        dispatch({ type: 'AUTH_FAILURE', payload: '' });
      }
    };

    checkAuth();
  }, [autoCheck, fetchMe]);

  /**
   * Login - returns redirect path for navigation
   */
  const login = useCallback(async (payload: LoginPayload): Promise<{ redirectPath: string }> => {
    dispatch({ type: 'AUTH_START' });

    try {
      const LOGIN_MUTATION = `
        mutation Login($input: LoginInput!) {
          login(input: $input) {
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
          user: AuthUser;
        };
      }>(LOGIN_MUTATION, {
        input: {
          email: payload.email,
          password: payload.password,
        },
      });

      if (!response?.login) {
        throw new Error('Invalid server response');
      }

      const { accessToken, refreshToken, user, redirectUrl } = response.login;

      // Save tokens
      setTokens(accessToken, refreshToken);

      // Save tenant ID for multi-tenant context
      if (user.tenantId) {
        setTenantId(user.tenantId);
      }

      // Use redirectUrl from login response directly
      const redirectPath = redirectUrl || getDefaultRedirect(user.role);

      // Fetch user data with modules after login
      const meData = await fetchMe();
      const modules = meData?.modules || [];

      dispatch({
        type: 'AUTH_SUCCESS',
        payload: { user, modules, redirectPath },
      });

      return { redirectPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      dispatch({ type: 'AUTH_FAILURE', payload: message });
      throw error;
    }
  }, [fetchMe]);

  /**
   * Logout
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
      clearTokens();
      dispatch({ type: 'LOGOUT' });
    }
  }, []);

  /**
   * Refresh auth state
   */
  const refreshAuth = useCallback(async (): Promise<void> => {
    const meData = await fetchMe();
    if (meData) {
      dispatch({ type: 'AUTH_SUCCESS', payload: meData });
    } else {
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
   */
  const isSuperAdmin = useCallback(() => state.user?.role === 'SUPER_ADMIN', [state.user]);
  const isTenantAdmin = useCallback(() => state.user?.role === 'TENANT_ADMIN', [state.user]);
  const isModuleManager = useCallback(() => state.user?.role === 'MODULE_MANAGER', [state.user]);
  const isModuleUser = useCallback(() => state.user?.role === 'MODULE_USER', [state.user]);

  const hasRoleOrHigher = useCallback(
    (role: UserRole): boolean => {
      if (!state.user) return false;
      return roleHasPermission(state.user.role, role);
    },
    [state.user]
  );

  const hasModuleAccess = useCallback(
    (moduleCode: string): boolean => {
      if (!state.user) return false;
      // SUPER_ADMIN has system access, not module access
      if (state.user.role === 'SUPER_ADMIN') return false;
      // TENANT_ADMIN has access to all tenant modules
      if (state.user.role === 'TENANT_ADMIN') return true;
      // MODULE_MANAGER and MODULE_USER check their assigned modules
      return state.modules.some((m) => m.code === moduleCode);
    },
    [state.user, state.modules]
  );

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    clearError,
    refreshAuth,
    isSuperAdmin,
    isTenantAdmin,
    isModuleManager,
    isModuleUser,
    hasRoleOrHigher,
    hasModuleAccess,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// ============================================================================
// Helper
// ============================================================================

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

  // Fallback for Module Federation: decode user from JWT token
  const token = getAccessToken();
  let fallbackUser: AuthUser | null = null;

  if (token) {
    try {
      // Decode JWT payload (base64)
      const payload = JSON.parse(atob(token.split('.')[1]));
      fallbackUser = {
        id: payload.sub || '',
        email: payload.email || '',
        firstName: payload.firstName || null,
        lastName: payload.lastName || null,
        role: payload.role || 'MODULE_USER',
        tenantId: payload.tenantId || null,
        isActive: true,
      };
    } catch {
      console.warn('Failed to decode auth token in microfrontend');
    }
  }

  // Return fallback context value for microfrontends
  const fallbackValue: AuthContextValue = {
    user: fallbackUser,
    modules: [],
    redirectPath: null,
    isLoading: false,
    isAuthenticated: !!fallbackUser,
    error: null,
    login: async () => {
      console.warn('Login not available in microfrontend context');
      return { redirectPath: '/' };
    },
    logout: async () => {
      clearTokens();
      window.location.href = '/login';
    },
    clearError: () => {},
    refreshAuth: async () => {},
    isSuperAdmin: () => fallbackUser?.role === 'SUPER_ADMIN',
    isTenantAdmin: () => fallbackUser?.role === 'TENANT_ADMIN',
    isModuleManager: () => fallbackUser?.role === 'MODULE_MANAGER',
    isModuleUser: () => fallbackUser?.role === 'MODULE_USER',
    hasRoleOrHigher: (role: UserRole) => {
      if (!fallbackUser) return false;
      return roleHasPermission(fallbackUser.role, role);
    },
    hasModuleAccess: () => true, // Assume access in microfrontend context
  };

  return fallbackValue;
}

export default AuthContext;
