/**
 * The state of one dashboard cell's source.
 *
 * WHY: a site row reads several sources, each of which may still be loading
 * or may have failed while the others arrived. A cell must then say so —
 * never show "no measurement" for a request that failed, nor a zero nobody
 * measured — so each cell carries its own source's state.
 */
import type { UseQueryResult } from '@tanstack/react-query';

export type Cell<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly value: T };

export const LOADING: Cell<never> = { status: 'loading' };

/** The cell of a query's data turned into a value by `toValue`. */
export function cellOf<TData, T>(
  query: Pick<UseQueryResult<TData>, 'isError' | 'isSuccess' | 'data'>,
  toValue: (data: TData) => T,
): Cell<T> {
  if (query.isError) return { status: 'error' };
  if (query.isSuccess && query.data !== undefined) {
    return { status: 'ready', value: toValue(query.data) };
  }
  return LOADING;
}

/** A ready cell's value turned by `toValue`; loading and error pass through. */
export function mapCell<A, T>(cell: Cell<A>, toValue: (value: A) => T): Cell<T> {
  return cell.status === 'ready' ? { status: 'ready', value: toValue(cell.value) } : cell;
}

/**
 * The cell of the `index`-th result of a useQueries call. Every index of the
 * list the queries were built from has a result; one that does not exist yet
 * (the list changed this render) is loading.
 */
export function cellAt<TData, T>(
  results: readonly Pick<UseQueryResult<TData>, 'isError' | 'isSuccess' | 'data'>[],
  index: number,
  toValue: (data: TData) => T,
): Cell<T> {
  const result = results[index];
  return result === undefined ? LOADING : cellOf(result, toValue);
}

/** Combine two cells: ready only when both are. */
export function bothOf<A, B, T>(a: Cell<A>, b: Cell<B>, combine: (a: A, b: B) => T): Cell<T> {
  if (a.status === 'error' || b.status === 'error') return { status: 'error' };
  if (a.status === 'ready' && b.status === 'ready') {
    return { status: 'ready', value: combine(a.value, b.value) };
  }
  return LOADING;
}
