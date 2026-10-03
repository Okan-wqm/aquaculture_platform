/**
 * Loadable — a fetch result you cannot read without deciding what a failure means.
 *
 * WHY THIS EXISTS. The same defect has now been found and fixed FIVE separate
 * times in this app, in five different files:
 *
 *   HomePage        a failed fetch rendered "0 Fish · 0kg Biomass · Capacity OK"
 *   ReportsPage     a failed fetch rendered "Nothing stocked"
 *   TankDetailPage  a failed fetch rendered "This unit is not in your inventory"
 *   ScanPage        a failed fetch rendered "does not match a unit you have access to"
 *   StorageHubPage  a failed fetch rendered "0 Items / 0 Low Stock / 0 Today"
 *
 * Every one of them is the same mistake: a hook hands back `data` with a
 * fallback (`?? []`, `?? DEFAULT_SUMMARY`), the screen renders it, and an
 * outage becomes an authoritative claim about the farm. On a boat with no
 * signal — the app's normal operating state — "Capacity OK" from a screen that
 * knows nothing is the worst failure this app can produce.
 *
 * Patching the sixth instance would not have stopped a seventh. The defect is
 * not in the screens; it is that `data` is READABLE WITHOUT the error arm
 * having been considered. So the fix is a type where it is not:
 *
 *     const view = toLoadable(query);
 *     if (view.status === 'error')   return <Retry onRetry={view.retry} />;
 *     if (view.status === 'loading') return <Skeleton />;
 *     view.data                       // only reachable here, and only here
 *
 * `data` exists on exactly one arm of the union. Forgetting the error case is a
 * compile error rather than a screen that lies. Tier 1 — make it impossible.
 *
 * Pair this with <DataState/> (src/components/ui/DataState.tsx) when the three
 * states map onto ordinary skeleton/error/content rendering, which is most of
 * the time.
 */

/** What a query can be, with `data` reachable on exactly one arm. */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error; retry: () => void }
  | { status: 'ready'; data: T };

/**
 * The subset of a TanStack `UseQueryResult` this needs. Declared structurally
 * rather than importing the full type so hand-shaped hook returns can satisfy
 * it too — several hooks in this app return `{ data, isLoading, isError }`
 * rather than the raw query object.
 */
export interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch?: () => unknown;
}

/**
 * Collapse a query result into a Loadable.
 *
 * ORDER MATTERS and is deliberate: error is checked BEFORE data. A query that
 * has failed but still holds a stale `data` from a previous success is reported
 * as an error, because on this app's surfaces a stale biomass figure presented
 * as current is the thing we are trying to prevent. Callers that genuinely want
 * stale-while-error should read the query directly and say so at the callsite.
 */
export function toLoadable<T>(query: QueryLike<T>): Loadable<T> {
  if (query.isError) {
    return {
      status: 'error',
      error: query.error instanceof Error ? query.error : new Error('Request failed'),
      retry: () => {
        void query.refetch?.();
      },
    };
  }
  if (query.isLoading || query.data === undefined) {
    return { status: 'loading' };
  }
  return { status: 'ready', data: query.data };
}
