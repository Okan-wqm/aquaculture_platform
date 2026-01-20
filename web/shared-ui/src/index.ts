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
} from './types';

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
export type { AuthProviderProps } from './contexts/AuthContext';

export { TenantProvider, useTenantContext } from './contexts/TenantContext';
export type { TenantProviderProps } from './contexts/TenantContext';

// ============================================================================
// Hooks - simplified exports
// ============================================================================

export { useAuth, useRequireAuth } from './hooks/useAuth';
export { useTenant } from './hooks/useTenant';
export {
  useGraphQLQuery,
  useGraphQLMutation,
  usePrefetchQuery,
  useUpdateQueryCache,
  useInvalidateQueries,
} from './hooks/useGraphQL';
