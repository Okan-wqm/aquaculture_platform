/**
 * Shared UI Library
 * Aquaculture Platform için merkezi UI kütüphanesi
 *
 * @description
 * Bu kütüphane, platform genelinde kullanılan tüm UI bileşenlerini,
 * hook'ları, utility fonksiyonlarını ve context'leri içerir.
 * Module Federation ile tüm microfrontend'ler tarafından paylaşılır.
 *
 * @example
 * // Component import
 * import { Button, Card, Table } from '@aquaculture/shared-ui';
 *
 * // Hook import
 * import { useAuth, useTenant } from '@aquaculture/shared-ui';
 *
 * // Context import
 * import { AuthProvider, TenantProvider } from '@aquaculture/shared-ui';
 *
 * // Utils import
 * import { formatDate, formatCurrency, validateEmail } from '@aquaculture/shared-ui';
 */

// ============================================================================
// Types - explicit exports to avoid conflicts
// ============================================================================

export type {
  // User & Auth
  UserRole,
  User,
  AuthState,
  AuthTokens,
  ApiResponse,
  // Tenant
  TenantTier,
  TenantPlan,
  TenantStatus,
  Tenant,
  TenantSettings,
  TenantLimits,
  // API
  PaginationParams,
  PaginatedResult,
  ApiError as ApiErrorType, // Renamed to avoid conflict with ApiError component
  QueryState,
  // Domain
  GeoLocation,
  Farm,
  PondType,
  Pond,
  SensorType,
  SensorStatus,
  Sensor,
  SensorReading,
  AlertSeverity,
  AlertStatus,
  SystemAlert,
  // UI Types
  ButtonVariant,
  TrendDirection,
  Size,
  TableColumn,
  FieldState,
  BaseModalProps,
  NavigationItem,
  BreadcrumbItem,
  NotificationType,
  ToastNotification,
  StandardPaginationInput,
  StandardPaginatedResult,
} from './types';

// ============================================================================
// Brand SSoT
// ============================================================================

export { BRAND } from './config/brand';
export type { Brand } from './config/brand';

// ============================================================================
// Theme & Styles
// ============================================================================

export * from './styles/theme';

// ============================================================================
// Components
// ============================================================================

export * from './components';

// ============================================================================
// Utils
// ============================================================================

export * from './utils';

// ============================================================================
// Water Chemistry (SSoT — pure logic; presentation added in Phase 2)
// ============================================================================

export * from './water-chemistry';

// Error Types
export {
  ErrorCode,
  type AppError,
  type RecoveryAction,
  parseError,
  isRetryableError,
  requiresReauth,
  createError,
} from './utils/error-types';

// ============================================================================
// Contexts - simplified exports
// ============================================================================

export { AuthProvider, useAuthContext } from './contexts/AuthContext';
// WHY: Export AccessType and AuthUser so consumers (tenant-admin, aquamobil) can
// type-check accessType values without duplicating the type definition.
export type { AuthProviderProps, MfaChallengeResult, MfaSetupRequiredResult, LoginResult, AccessType, AuthUser } from './contexts/AuthContext';

export { TenantProvider, useTenantContext } from './contexts/TenantContext';
export type { TenantProviderProps } from './contexts/TenantContext';

// ============================================================================
// Hooks - simplified exports
// ============================================================================

export { useAuth, useRequireAuth } from './hooks/useAuth';
export { useTenant } from './hooks/useTenant';
export { useTenantQuery, useTenantMutation } from './hooks/useTenantQuery';
export type {
  TenantQueryOptions,
  TenantMutationOptions,
} from './hooks/useTenantQuery';
export {
  useTenantScopedStorage,
  TENANT_SCOPED_STORAGE_NAMESPACE,
} from './hooks/useTenantScopedStorage';
export type { TenantScopedStorage } from './hooks/useTenantScopedStorage';
// Pure tenant-scoped storage-key helpers (no React) — SSoT for cross-tenant
// localStorage isolation. TENANT_SCOPED_STORAGE_NAMESPACE is already re-exported
// above via the hook, so it is intentionally omitted here to avoid an ambiguous
// re-export (TS2308).
export {
  tenantScopedStorageKey,
  sweepTenantScopedStorage,
} from './utils/tenant-scoped-storage-namespace';

// ============================================================================
// I18n Infrastructure — FE-HIGH-020
// ============================================================================

export { I18nProvider, useI18n } from './i18n';
export type { I18nProviderProps, I18nContextValue, SupportedLocale, MessageKey } from './i18n';
export {
  useGraphQLQuery,
  useGraphQLMutation,
  usePrefetchQuery,
  useUpdateQueryCache,
  useInvalidateQueries,
} from './hooks/useGraphQL';
export { useToast, ToastContainer, ToastProvider } from './hooks/useToast';
export type { ToastOptions, ToastAction } from './hooks/useToast';

// ============================================================================
// Error-message helpers (Scope C PR-0a)
// ============================================================================

export {
  parseGraphQLError,
  formatErrorForToast,
  useErrorMessage,
  type ParsedGraphQLError,
} from './hooks/useErrorMessage';

// ============================================================================
// Frontend authorization (Scope C PR-0a) — mirror of backend matrix
// ============================================================================

export {
  FRONTEND_MUTATION_ROLES,
  useCanMutate,
  type FrontendMutationName,
} from './authz';

export {
  ADMIN_BILLING_HIDDEN_ROUTES,
  ADMIN_BILLING_NAV_ITEMS,
  ADMIN_BILLING_ROLE,
  ADMIN_BILLING_ROUTES,
  ADMIN_BILLING_VISIBLE_ROUTES,
  getAdminBillingRoute,
  type AdminBillingRoute,
  type AdminBillingRouteId,
} from './authz/admin-billing-routes';
