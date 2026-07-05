/**
 * useAuth Hook
 * Kimlik doğrulama durumu ve işlemleri için React hook
 * AuthContext ile entegre çalışır
 */

import { useCallback, useMemo } from 'react';
import { useAuthContext } from '../contexts/AuthContext';
import { getAccessToken, getTenantId } from '../utils/api-client';
import type { User, UserRole } from '../types';

// ============================================================================
// Hook Return Type
// ============================================================================

export interface UseAuthReturn {
  /** Giriş yapmış kullanıcı */
  user: User | null;
  /** Aktif tenant ID */
  tenantId: string | null;
  /** Kimlik doğrulaması yapılmış mı */
  isAuthenticated: boolean;
  /** Yükleniyor durumu */
  isLoading: boolean;
  /** Access token (GraphQL istekleri için) */
  token: string | null;
  /** Giriş yap */
  login: (email: string, password: string) => Promise<void>;
  /** Çıkış yap */
  logout: () => Promise<void>;
  /** Auth yenile */
  refreshAuth: () => Promise<void>;
  /** Rol kontrolü */
  hasRole: (role: UserRole) => boolean;
  /** Birden fazla rol kontrolü (OR) */
  hasAnyRole: (roles: UserRole[]) => boolean;
  /** Tüm roller kontrolü (AND) */
  hasAllRoles: (roles: UserRole[]) => boolean;
  /** İzin kontrolü */
  hasPermission: (permission: string) => boolean;
  /** Platform admin mi */
  isPlatformAdmin: boolean;
  /** Tenant admin mi */
  isTenantAdmin: boolean;
}

// ============================================================================
// useAuth Hook
// ============================================================================

/**
 * Kimlik doğrulama hook'u
 *
 * @example
 * const { user, isAuthenticated, login, logout } = useAuth();
 *
 * if (!isAuthenticated) {
 *   return <LoginPage onLogin={login} />;
 * }
 *
 * return <Dashboard user={user} onLogout={logout} />;
 *
 * @example
 * // Rol kontrolü
 * const { hasRole, hasAnyRole } = useAuth();
 *
 * if (hasRole('SUPER_ADMIN')) {
 *   // Platform admin işlemleri
 * }
 *
 * if (hasAnyRole(['MODULE_MANAGER', 'MODULE_USER'])) {
 *   // Modül işlemleri
 * }
 */
export function useAuth(): UseAuthReturn {
  const context = useAuthContext();

  const {
    user,
    isAuthenticated,
    isLoading,
    login: contextLogin,
    logout,
    refreshAuth,
  } = context;

  // Giriş wrapper
  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      await contextLogin({ email, password });
    },
    [contextLogin]
  );

  // Rol kontrolü - user.role tekil olduğu için direkt karşılaştırma
  const hasRole = useCallback(
    (role: UserRole): boolean => {
      return user?.role === role;
    },
    [user]
  );

  // Birden fazla rol kontrolü (OR mantığı) - kullanıcının rolü listede var mı
  const hasAnyRole = useCallback(
    (roles: UserRole[]): boolean => {
      if (!user) return false;
      return roles.includes(user.role);
    },
    [user]
  );

  // CRIT-4/BUG-003: The system uses a single-role-per-user model.
  // hasAllRoles(roles) returns true if the user's single role is present in the roles list,
  // which is the meaningful "has all required roles" check in a single-role model.
  const hasAllRoles = useCallback(
    (roles: UserRole[]): boolean => {
      if (!user) return false;
      return roles.includes(user.role);
    },
    [user]
  );

  // İzin kontrolü - rol hiyerarşisine göre
  const hasPermission = useCallback(
    (permission: string): boolean => {
      if (!user) return false;
      // SUPER_ADMIN and TENANT_ADMIN have full access — mirrors the backend
      // TenantPermissionGuard, which bypasses both (their tokens carry no
      // resourcePermissions precisely because they need none).
      if (user.role === 'SUPER_ADMIN' || user.role === 'TENANT_ADMIN') {
        return true;
      }
      // Tenant-RBAC capability check against the granted set decoded from the
      // access token. Fail-closed: no grant → hidden. The backend still
      // enforces every action independently (this only drives UI visibility).
      return user.resourcePermissions?.includes(permission) ?? false;
    },
    [user]
  );

  // Özel rol kontrolleri - yeni role enum'larına göre
  const isPlatformAdmin = useMemo(
    () => hasRole('SUPER_ADMIN'),
    [hasRole]
  );

  const isTenantAdmin = useMemo(
    () => hasRole('TENANT_ADMIN') || hasRole('SUPER_ADMIN'),
    [hasRole]
  );

  // PERF-005: Memoize token/tenantId reads gated on isAuthenticated to avoid
  // calling localStorage on every render of every consumer component.
  const token = useMemo(() => (isAuthenticated ? getAccessToken() : null), [isAuthenticated]);
  const tenantId = useMemo(
    () => (user?.tenantId ?? (isAuthenticated ? getTenantId() : null)),
    [user, isAuthenticated]
  );

  return {
    user,
    tenantId,
    isAuthenticated,
    isLoading,
    token,
    login,
    logout,
    refreshAuth,
    hasRole,
    hasAnyRole,
    hasAllRoles,
    hasPermission,
    isPlatformAdmin,
    isTenantAdmin,
  };
}

// ============================================================================
// useRequireAuth Hook
// ============================================================================

/**
 * Kimlik doğrulama gerektiren sayfalar için hook
 * Otomatik yönlendirme yapmaz, sadece durum döner
 *
 * PERF-012: Pass a stable array reference for requiredRoles (defined outside the component
 * or wrapped in useMemo) to avoid recomputing isAuthorized on every render.
 *
 * @example
 * // Stable reference — define outside component or with useMemo
 * const REQUIRED_ROLES: UserRole[] = ['MODULE_MANAGER', 'MODULE_USER'];
 * const { isAuthorized, isLoading } = useRequireAuth(REQUIRED_ROLES);
 *
 * if (isLoading) return <LoadingSpinner />;
 * if (!isAuthorized) return <AccessDenied />;
 */
export function useRequireAuth(requiredRoles?: UserRole[]): {
  isAuthorized: boolean;
  isLoading: boolean;
  user: User | null;
} {
  const { user, isAuthenticated, isLoading, hasAnyRole } = useAuth();

  // PERF-012: Stringify roles for stable memo key — avoids recompute when caller passes inline array
  const rolesKey = requiredRoles ? requiredRoles.slice().sort().join(',') : '';

  const isAuthorized = useMemo(() => {
    if (!isAuthenticated) return false;
    if (!requiredRoles || requiredRoles.length === 0) return true;
    return hasAnyRole(requiredRoles);
  }, [isAuthenticated, rolesKey, hasAnyRole]);

  return {
    isAuthorized,
    isLoading,
    user,
  };
}

export default useAuth;
