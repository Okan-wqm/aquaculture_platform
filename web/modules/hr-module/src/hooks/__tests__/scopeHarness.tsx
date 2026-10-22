/**
 * Shared harness for the module-scope hook specs (useAttendance, useScheduling, useLeaves).
 *
 * A hook is rendered inside a workspace — the shell's `WorkforceScopeProvider` — against a
 * QueryClient the caller owns. Rendering one hook in several workspaces against ONE client is
 * the proof that matters: two workspaces must neither send the same variables nor land on the
 * same cache entry.
 */
import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, type RenderHookResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Mock } from 'vitest';

/** A module workspace, or `null` for Company (every module). */
export type Workspace = HrModuleCode | null;

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

export function renderInWorkspace<T>(
  useHook: () => T,
  workspace: Workspace,
  queryClient: QueryClient,
): RenderHookResult<T, unknown> {
  return renderHook(useHook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <WorkforceScopeProvider moduleCode={workspace}>{children}</WorkforceScopeProvider>
      </QueryClientProvider>
    ),
  });
}

/** The variables of every request that ran `document`, in call order (`graphqlRequest(client, document, variables)`). */
export function requestsFor(request: Mock, document: unknown): Record<string, unknown>[] {
  return request.mock.calls
    .filter(([, requested]) => requested === document)
    .map(([, , variables]) => variables as Record<string, unknown>);
}

/** The cached query keys as JSON: content is compared, and `undefined` drops out exactly as it does when hashing. */
export function cachedKeys(queryClient: QueryClient): string[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify(query.queryKey));
}

/** What the server receives: variables after JSON serialisation (an `undefined` variable is not sent). */
export function onTheWire(variables: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(variables)) as Record<string, unknown>;
}
