/**
 * Shared list-view error/data state helper.
 *
 * Decide whether a list/detail view should render a BLOCKING error view
 * (replacing the whole page) or keep showing the last-loaded data with a
 * non-blocking error banner.
 *
 * Blanking the page on a background-refetch error while cached data exists is
 * the "data appears then disappears" UX bug (Farm Data SSOT plan §3-D / §5-6):
 * TanStack Query keeps the previous data in cache on a failed refetch, so the
 * view must keep rendering it. The only time a blocking error is correct is
 * when there is genuinely nothing to show yet (the initial load failed and no
 * cached data exists).
 */
export function isBlockingError(error: unknown, hasData: boolean): boolean {
  return Boolean(error) && !hasData;
}
