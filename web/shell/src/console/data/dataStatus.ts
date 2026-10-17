/**
 * Console data status — the one shape every console data hook returns.
 *
 * WHY: the console header, title block, annunciator and palette render cells
 * whose source may be loading, failed, or not available to this viewer (module
 * not assigned, permission missing). A cell must then hide or grey out, never
 * show a made-up zero. Typing every value `null` outside 'ready' makes that the
 * only possible rendering: a consumer reads `number | null`, and narrowing on
 * `status === 'ready'` is what yields the number.
 *
 * WHAT: DataStatus, StatusResult<T> (ready → T's values, otherwise all null),
 * and the helpers that build results, directly or from a TanStack query.
 */
import type { UseQueryResult } from '@tanstack/react-query';

/** loading: first fetch in flight · ready: real data · error: the latest fetch failed · unavailable: not for this viewer. */
export type DataStatus = 'loading' | 'ready' | 'error' | 'unavailable';

export type PendingStatus = Exclude<DataStatus, 'ready'>;

/** T's keys, every value null — what a hook holds while it has no real value. */
export type Nulled<T> = { readonly [K in keyof T]: null };

/** Ready carries T's values; every other status carries the same keys, all null. */
export type StatusResult<T extends object> =
  | ({ readonly status: 'ready' } & Readonly<T>)
  | ({ readonly status: PendingStatus } & Nulled<T>);

/** A ready result from real values. */
export function readyResult<T extends object>(values: T): StatusResult<T> {
  return { status: 'ready', ...values };
}

/** A non-ready result: the hook's all-null record under the given status. */
export function pendingResult<T extends object>(
  status: PendingStatus,
  nulls: Nulled<T>,
): StatusResult<T> {
  return { status, ...nulls };
}

/**
 * The result of a hook backed by one query, its data turned into the result's
 * values by `toValues`. An error wins over cached data: after a failed refetch
 * the last-good value is no longer current, and the annunciator must not
 * present it as live.
 */
export function resultFrom<TData, T extends object>(
  query: UseQueryResult<TData>,
  enabled: boolean,
  nulls: Nulled<T>,
  toValues: (data: TData) => T,
): StatusResult<T> {
  if (!enabled) return pendingResult('unavailable', nulls);
  if (query.isError) return pendingResult('error', nulls);
  if (query.isSuccess) return readyResult(toValues(query.data));
  return pendingResult('loading', nulls);
}

/** resultFrom for a query whose data already has the result's shape. */
export function resultOf<T extends object>(
  query: UseQueryResult<T>,
  enabled: boolean,
  nulls: Nulled<T>,
): StatusResult<T> {
  return resultFrom(query, enabled, nulls, (data) => data);
}
