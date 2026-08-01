/**
 * Shared `@aquaculture/shared-ui` mock factory for federation-free vitest
 * specs (FARM-MEDIUM-120 test campaign scaffolding).
 *
 * Usage — vi.mock factories are hoisted, so import this module lazily inside
 * the factory and re-export the seams you assert on:
 *
 *   vi.mock('@aquaculture/shared-ui', async () =>
 *     (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
 *   );
 *   import { requestMock } from '../../test-utils/sharedUiMock';
 *
 * WHY the factory replaces more than useAuth/graphqlClient: module hooks built
 * on `useTenantQuery`/`useTenantMutation` read shared-ui's INTERNAL AuthContext,
 * which these tests never mount — so both are replicated here on top of the
 * stub session. The stubs keep the module's own hook files under test; only the
 * auth/transport boundary is faked.
 */
import { vi } from 'vitest';
import type { QueryFunction } from '@tanstack/react-query';

export const TEST_TENANT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
export const TEST_USER_ID = 'bbbbbbbb-2222-4333-8444-555555555555';

/** The single GraphQL transport seam — route it per spec via routeGraphql(). */
export const requestMock = vi.fn();
/** useToast seam — assert error/success surfacing without a ToastProvider. */
export const toastMock = vi.fn();

type TenantQueryOptions = {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
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
    user: { id: TEST_USER_ID, email: 'operator@farm.test', roles: ['TENANT_ADMIN'] },
    tenantId: TEST_TENANT_ID,
    isAuthenticated: true,
    isLoading: false,
    token: 'jwt',
    login: vi.fn(),
    logout: vi.fn(),
    refreshAuth: vi.fn(),
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
    const queryKey = actual.createTenantQueryKey(TEST_TENANT_ID, ...segments);
    return rq.useQuery<TData>({
      ...rest,
      queryKey,
      queryFn,
      // The stub session is immutable and authenticated, so the production
      // token/tenant gate is represented by the caller gate. Use the production
      // key and boundary predicate nevertheless: test scaffolding must never teach
      // callers that unconditional keepPreviousData is tenant-safe.
      enabled: enabled ?? true,
      placeholderData: keep
        ? (previousData, previousQuery) =>
            previousQuery && actual.hasSameTenantSessionBoundary(previousQuery.queryKey, queryKey)
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
    getSessionSnapshot: () => ({
      accessToken: 'jwt',
      effectiveTenantId: TEST_TENANT_ID,
      sessionEpoch: 0,
      tokenState: 'READY',
      ready: true,
    }),
    graphqlClient: { request: requestMock },
    useToast: () => ({ toast: toastMock }),
    useTenantQuery,
    useTenantMutation,
    // Reads shared-ui's internal AuthContext in production — the stub session
    // is a TENANT_ADMIN, so mutations are visible (per-spec overrides can
    // re-mock this to exercise the hidden state).
    useCanMutate: () => true,
  };
}
