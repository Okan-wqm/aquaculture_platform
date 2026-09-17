/**
 * Shared `@aquaculture/shared-ui` mock factory for federation-free vitest
 * specs — mirrors farm-module's FARM-MEDIUM-120 scaffolding.
 *
 * Usage — vi.mock factories are hoisted, so import this module lazily inside
 * the factory and re-export the seams you assert on:
 *
 *   vi.mock('@aquaculture/shared-ui', async () =>
 *     (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
 *   );
 *   import { requestMock, TEST_TENANT_ID } from '../../test-utils/sharedUiMock';
 *
 * WHY the factory replaces more than useAuth/graphqlClient: module hooks built
 * on `useTenantQuery`/`useTenantMutation` read shared-ui's INTERNAL AuthContext,
 * which these tests never mount — so both are replicated here on top of the
 * stub session. The stubs keep the module's own hook files under test; only the
 * auth/transport boundary is faked.
 */
import type { QueryFunction } from '@tanstack/react-query';
import { vi } from 'vitest';

export const TEST_TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
export const TEST_USER_ID = 'bbbbbbbb-2222-4333-8444-555555555555';

/** The single GraphQL transport seam — route it per spec via routeGraphql(). */
export const requestMock = vi.fn();

/**
 * FAZ 3.1: getAccessToken seam — the socket hook reads the FRESH access token
 * through shared-ui's storage-backed getter after refreshAuth(); pinning it
 * here keeps specs deterministic (set the next token before firing reAuth).
 */
export const getAccessTokenMock = vi.fn<() => string | null>(() => null);

/**
 * FAZ 3.1: refreshAuth seam — ONE shared mock across useAuth() renders so
 * specs can assert/steer the session-recovery path (the inline vi.fn() per
 * render was unassertable).
 */
export const refreshAuthMock = vi.fn((): Promise<void> => Promise.resolve());

type TenantQueryOptions = {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  keepPreviousData?: boolean;
};

type TenantMutationOptions<TData, TVariables> = {
  invalidate?: ReadonlyArray<readonly unknown[]>;
  onSuccess?: (data: TData, variables: TVariables, context: unknown) => void;
  onError?: (error: Error, variables: TVariables, context: unknown) => void;
};

export async function createSharedUiMock(): Promise<Record<string, unknown>> {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  const rq = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');

  const useAuth = (): Record<string, unknown> => ({
    user: { id: TEST_USER_ID, email: 'operator@messaging.test', roles: ['TENANT_ADMIN'] },
    tenantId: TEST_TENANT_ID,
    isAuthenticated: true,
    isLoading: false,
    token: 'jwt',
    login: vi.fn(),
    logout: vi.fn(),
    refreshAuth: refreshAuthMock,
    hasRole: () => true,
    hasAnyRole: () => true,
    hasAllRoles: () => true,
    hasPermission: () => true,
    isPlatformAdmin: false,
    isTenantAdmin: true,
  });

  function useTenantQuery<TData>(
    segments: readonly unknown[],
    queryFn: QueryFunction<TData, readonly unknown[]>,
    options?: TenantQueryOptions,
  ): unknown {
    const { enabled, keepPreviousData: keep = true, ...rest } = options ?? {};
    return rq.useQuery<TData>({
      ...rest,
      // Inline factory call: the repo's no-bare-tenant-query-key lint gate
      // flags queryKey values it cannot statically trace to the factory.
      queryKey: actual.createTenantQueryKey(TEST_TENANT_ID, ...segments),
      queryFn,
      // The stub session is immutable and authenticated, so the production
      // token/tenant gate is represented by the caller gate. Use the production
      // key and boundary predicate nevertheless: test scaffolding must never
      // teach callers that unconditional keepPreviousData is tenant-safe.
      enabled: enabled ?? true,
      placeholderData: keep
        ? (previousData, previousQuery) =>
            previousQuery &&
            actual.hasSameTenantSessionBoundary(
              previousQuery.queryKey,
              actual.createTenantQueryKey(TEST_TENANT_ID, ...segments),
            )
              ? previousData
              : undefined
        : undefined,
    });
  }

  function useTenantMutation<TData, TVariables>(
    mutationFn: (variables: TVariables) => Promise<TData>,
    options?: TenantMutationOptions<TData, TVariables>,
  ): unknown {
    const queryClient = rq.useQueryClient();
    const { invalidate, onSuccess, ...rest } = options ?? {};
    return rq.useMutation<TData, Error, TVariables>({
      ...rest,
      mutationFn,
      onSuccess: (data, variables, context) => {
        for (const segments of invalidate ?? []) {
          void queryClient.invalidateQueries({
            queryKey: actual.createTenantInvalidationKey(TEST_TENANT_ID, ...segments),
          });
        }
        onSuccess?.(data, variables, context);
      },
    });
  }

  return {
    ...actual,
    useAuth,
    // The socket hook derives invalidation keys from the session tenant —
    // pin the storage-reading helper to the stub tenant too.
    getTenantId: () => TEST_TENANT_ID,
    // FAZ 3.1: fresh-token reads after refreshAuth() go through this seam.
    getAccessToken: getAccessTokenMock,
    graphqlClient: { request: requestMock },
    useTenantQuery,
    useTenantMutation,
  };
}
