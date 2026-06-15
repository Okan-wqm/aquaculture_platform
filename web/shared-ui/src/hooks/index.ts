/**
 * Shared UI Hooks - Central Export
 */

export { useAuth, useRequireAuth } from './useAuth';
export { useTenant } from './useTenant';
export {
  useTenantScopedStorage,
  TENANT_SCOPED_STORAGE_NAMESPACE,
} from './useTenantScopedStorage';
export type { TenantScopedStorage } from './useTenantScopedStorage';
export {
  useGraphQLQuery,
  useGraphQLMutation,
  usePrefetchQuery,
  useUpdateQueryCache,
  useInvalidateQueries,
} from './useGraphQL';
export { useToast, ToastContainer } from './useToast';
export type { ToastOptions } from './useToast';
