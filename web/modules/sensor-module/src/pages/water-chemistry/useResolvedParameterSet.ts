/**
 * useResolvedParameterSet — the mock→real data seam.
 *
 * Built on `useTenantQuery` (tenant-keyed cache + enabled-gate + keepPreviousData), so
 * the mock already has real loading/error states. The real-phase swap replaces ONLY the
 * queryFn body (mock `resolveScope` → typed GraphQL op); key, tenant isolation, and every
 * consumer stay untouched.
 */
import { useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import { resolveScope, resolveTanks } from './mock/resolveScope';
import type { ResolvedParameterSet, WcScope } from './types';

export function useResolvedParameterSet(scope: WcScope): UseQueryResult<ResolvedParameterSet, Error> {
  return useTenantQuery<ResolvedParameterSet>(
    ['water-chemistry', 'resolve', scope.kind, scope.id],
    () => resolveScope(scope),
    { staleTime: 10_000 },
  );
}

/** Resolve every member tank of a scope (for the status grid). */
export function useScopeTanks(scope: WcScope): UseQueryResult<ResolvedParameterSet[], Error> {
  return useTenantQuery<ResolvedParameterSet[]>(
    ['water-chemistry', 'tanks', scope.kind, scope.id],
    () => resolveTanks(scope),
    { staleTime: 10_000 },
  );
}
