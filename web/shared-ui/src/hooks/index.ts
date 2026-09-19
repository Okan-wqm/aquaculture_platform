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
export { useFeedbackMutation, DEFAULT_MUTATION_ERROR_TITLE } from './useFeedbackMutation';
export type { MutationFeedback, FeedbackMutationOptions } from './useFeedbackMutation';
export type { ToastOptions } from './useToast';
export { useConfirm, usePrompt } from './useConfirm';
export type { ConfirmOptions, PromptOptions, ConfirmFn, PromptFn } from './useConfirm';
export { useClickOutside } from './useClickOutside';
export { useActAsContext } from './useActAsContext';
