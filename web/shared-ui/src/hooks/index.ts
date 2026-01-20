/**
 * Shared UI Hooks - Central Export
 */

export { useAuth, useRequireAuth } from './useAuth';
export { useTenant } from './useTenant';
export {
  useGraphQLQuery,
  useGraphQLMutation,
  usePrefetchQuery,
  useUpdateQueryCache,
  useInvalidateQueries,
} from './useGraphQL';
