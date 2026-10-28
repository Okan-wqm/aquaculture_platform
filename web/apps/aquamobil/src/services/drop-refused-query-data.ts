/**
 * A refused query keeps no data on screen (MOB-MEDIUM-031, PKG-42).
 *
 * WHY: React Query keeps a query's last good data when a refetch fails. A screen the worker
 * had open — or reopens within main.tsx's 24 h gcTime — kept showing tanks, readings and
 * alarms after the server started refusing the caller: the in-memory half of the defect whose
 * IndexedDB half offline-cache.ts closes.
 *
 * WHAT: the QueryCache `onError` main.tsx installs. When a fetch is refused
 * (request-failure.ts: FORBIDDEN, UNAUTHENTICATED, HTTP 401/403) the query's data is dropped
 * in place; its error stays, so the screen shows the refusal and no stale record. An outage or
 * any other failure leaves the data, which is what the offline screens rely on. Setting state
 * starts no fetch, so a refused query cannot loop.
 */
import type { Query } from '@tanstack/react-query';

import { classifyRequestFailure, isRefusal } from './request-failure';

export function dropRefusedQueryData(
  error: unknown,
  query: Query<unknown, unknown, unknown>,
): void {
  if (!isRefusal(classifyRequestFailure(error))) return;
  query.setState({ data: undefined, dataUpdatedAt: 0 });
}
