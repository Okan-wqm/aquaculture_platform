/**
 * Admin Panel Hooks
 *
 * The admin-panel's data layer (ADMIN-HIGH-105). `useAdminQuery` /
 * `useAdminMutation` + the `adminKeys` factory are the sanctioned way to read
 * and write: they put the cache in the shell's `QueryClient` (which
 * `logoutCleanup()` clears) and make a write invalidate the reads it affected.
 *
 * `useAsyncData` is the hand-rolled predecessor being retired page by page.
 * It is exported as `@deprecated` so every remaining call site is named by the
 * compiler rather than found by grep, and
 * `tests/invariants/admin-panel-data-layer.spec.ts` ratchets that count to 0.
 */

export { useAdminQuery, useAdminGraphQLQuery } from './useAdminQuery';
export type { UseAdminQueryOptions } from './useAdminQuery';

export { useAdminMutation, useAdminGraphQLMutation } from './useAdminMutation';
export type { AdminMutationExtras } from './useAdminMutation';

export { adminKeys } from './adminQueryKeys';

export { useAsyncData, clearAsyncCache } from './useAsyncData';
export type {
  AsyncState,
  UseAsyncDataOptions,
  UseAsyncDataReturn,
} from './useAsyncData';

export { usePagination } from './usePagination';
export type {
  PaginationState,
  UsePaginationOptions,
  UsePaginationReturn,
} from './usePagination';

export { useFilters } from './useFilters';
export type {
  UseFiltersOptions,
  UseFiltersReturn,
} from './useFilters';
