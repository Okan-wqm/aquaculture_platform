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

  // Tüm roller kontrolü - tek rol olduğu için listede tek eleman varsa karşılaştır
  const hasAllRoles = useCallback(
    (roles: UserRole[]): boolean => {
      if (!user) return false;
      // Tek rol olduğu için, kullanıcının rolünün listede olup olmadığını kontrol et
      return roles.length === 1 && roles[0] === user.role;
    },
    [user]
  );

  // İzin kontrolü - rol hiyerarşisine göre
  const hasPermission = useCallback(
    (permission: string): boolean => {
      if (!user) return false;
      // Basit izin kontrolü: SUPER_ADMIN her şeye erişebilir
      if (user.role === 'SUPER_ADMIN') return true;
      // İzin tabanlı kontrol ileride eklenebilir
      return false;
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

  return {
    user,
    tenantId: user?.tenantId ?? getTenantId(),
    isAuthenticated,
    isLoading,
    token: getAccessToken(),
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
 * @example
 * const { isAuthorized, isLoading } = useRequireAuth(['MODULE_MANAGER', 'MODULE_USER']);
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

  const isAuthorized = useMemo(() => {
    if (!isAuthenticated) return false;
    if (!requiredRoles || requiredRoles.length === 0) return true;
    return hasAnyRole(requiredRoles);
  }, [isAuthenticated, requiredRoles, hasAnyRole]);

  return {
    isAuthorized,
    isLoading,
    user,
  };
}

export default useAuth;
