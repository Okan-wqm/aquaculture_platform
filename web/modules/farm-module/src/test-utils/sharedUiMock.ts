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
 * stub session (same contract: tenant-prefixed key, auth gate, keepPreviousData,
 * tenant-scoped invalidation). The stubs keep the module's own hook files under
 * test; only the auth/transport boundary is faked.
 */
import { vi } from 'vitest';

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
  const rq =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');

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
    queryFn: () => Promise<TData>,
    options?: TenantQueryOptions,
  ): unknown {
    const { enabled, keepPreviousData: keep = true, ...rest } = options ?? {};
    return rq.useQuery<TData>({
      ...rest,
      queryKey: ['tenant', TEST_TENANT_ID, ...segments],
      queryFn,
      enabled: enabled ?? true,
      placeholderData: keep ? rq.keepPreviousData : undefined,
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
            queryKey: ['tenant', TEST_TENANT_ID, ...segments],
          });
        }
        onSuccess?.(data, variables, context);
      },
    });
  }

  return {
    ...actual,
    useAuth,
    graphqlClient: { request: requestMock },
    useToast: () => ({ toast: toastMock }),
    useTenantQuery,
    useTenantMutation,
  };
}
