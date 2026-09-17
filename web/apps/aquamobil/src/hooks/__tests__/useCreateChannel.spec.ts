/**
 * useCreateChannel Hook Tests — MSG-HIGH-054 (channel-create enum-casing 400).
 *
 * The messaging subgraph's `ChannelType` enum is registered WITHOUT a valuesMap,
 * so graphql-js accepts only the uppercase KEYs (`DIRECT`/`GROUP`/`AI`) on the
 * wire. The mobile client formerly posted the lowercase persisted value
 * (`'group'`/`'ai'`) and was rejected with a 400 before the resolver ran.
 *
 * These tests pin the WRITE boundary: the create mutations must serialize the
 * wire KEY into `CreateChannelInput.type`, never the lowercase form.
 */

import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — declared before imports (hoisted by vitest)
//
// WHY @tanstack/react-query is fully mocked (not partially): the monorepo has
// duplicated React instances (root vs local node_modules) which breaks
// renderHook with a real QueryClientProvider. We intercept useMutation to drive
// its mutationFn directly through mutateAsync — that is the actual code path
// that serializes CreateChannelInput.type onto the wire, which is what this
// suite asserts. Pattern mirrors useLeave.spec.ts.
// --------------------------------------------------------------------------

interface MutationConfig<TArgs> {
  mutationFn: (args: TArgs) => Promise<unknown>;
  onSuccess?: () => void;
  onError?: (err: Error) => void;
}

const mockInvalidateQueries = vi.fn();
const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

let mockTenantId: string | null = 'tenant-1';
let mockIsAuthenticated = true;

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    tenantId: mockTenantId,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  useMutation: <TArgs>(config: MutationConfig<TArgs>) => ({
    mutateAsync: vi.fn().mockImplementation(async (args: TArgs) => {
      try {
        const result = await config.mutationFn(args);
        config.onSuccess?.();
        return result;
      } catch (err) {
        config.onError?.(err as Error);
        throw err;
      }
    }),
    isPending: false,
  }),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Import after mocks.
import { useCreateChannel } from '../useCreateChannel';

/** Extract the `input` variable from the most recent graphqlRequest call. */
function lastCreateInput(): {
  type: string;
  name?: string;
  memberIds: string[];
  aiPersona?: string;
} {
  const calls = mockGraphqlRequest.mock.calls;
  const [, variables] = calls[calls.length - 1] as [
    unknown,
    { input: { type: string; name?: string; memberIds: string[]; aiPersona?: string } },
  ];
  return variables.input;
}

describe('useCreateChannel — wire-casing the ChannelType enum (MSG-HIGH-054)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantId = 'tenant-1';
    mockIsAuthenticated = true;
    mockInvalidateQueries.mockResolvedValue(undefined);
    mockGraphqlRequest.mockResolvedValue({ createChannel: { id: 'chan-new' } });
  });

  it('createGroup sends the UPPERCASE wire KEY GROUP, never lowercase group', async () => {
    const { result } = renderHook(() => useCreateChannel());

    const id = await result.current.createGroup('Ops Crew', [
      '11111111-1111-4111-8111-111111111111',
    ]);

    expect(id).toBe('chan-new');
    const input = lastCreateInput();
    expect(input.type).toBe('GROUP');
    expect(input.type).not.toBe('group');
    expect(input.name).toBe('Ops Crew');
    expect(input.memberIds).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('createAiChannel sends the UPPERCASE wire KEY AI, never lowercase ai', async () => {
    mockGraphqlRequest.mockResolvedValue({ createChannel: { id: 'chan-ai' } });
    const { result } = renderHook(() => useCreateChannel());

    const id = await result.current.createAiChannel('expert-v1', 'Expert');

    expect(id).toBe('chan-ai');
    const input = lastCreateInput();
    expect(input.type).toBe('AI');
    expect(input.type).not.toBe('ai');
    expect(input.aiPersona).toBe('expert-v1');
    expect(input.memberIds).toEqual([]);
  });

  it('refuses to create when unauthenticated (no wire call leaks out)', async () => {
    mockIsAuthenticated = false;
    const { result } = renderHook(() => useCreateChannel());

    await expect(
      result.current.createGroup('Ops', ['11111111-1111-4111-8111-111111111111']),
    ).rejects.toThrow('Not authenticated');
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });
});
