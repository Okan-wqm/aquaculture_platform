/**
 * useEditMessage Hook Tests — MSG-MEDIUM-053 dead-producer revival.
 *
 * `editMessage` was declared as an OperationType and wired through the queue's
 * MUTATIONS map, sync-invalidation map, and executeGraphQL id+input splitter,
 * but NO client code ever enqueued it — the offline-edit path was unreachable.
 * useEditMessage is the missing producer. These tests pin the four write paths:
 *   - online                 → editMessage mutation + SSoT cache invalidation
 *   - offline                → enqueue on the shared offline queue
 *   - online + network error → fall through to the offline queue (no loss)
 *   - disabled / empty       → no-op
 */

import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — declared before imports (hoisted by vitest)
// --------------------------------------------------------------------------

const mockAddToQueue = vi.fn();
const mockInvalidateQueries = vi.fn();
// Typed so the mocked graphqlRequest returns Promise<unknown> (not any) — keeps
// the mock factory + .mock.calls destructuring free of no-unsafe-* lint.
const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

let mockIsOnline = true;
let mockTenantId: string | null = 'tenant-1';
let mockIsAuthenticated = true;

vi.mock('../useOfflineQueue', () => ({
  useOfflineQueue: () => ({ addToQueue: mockAddToQueue }),
}));

vi.mock('../useNetworkStatus', () => ({
  useNetworkStatus: () => mockIsOnline,
}));

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    tenantId: mockTenantId,
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Import after mocks.
import { useEditMessage } from '../useEditMessage';

describe('useEditMessage — MSG-MEDIUM-053 edit producer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnline = true;
    mockTenantId = 'tenant-1';
    mockIsAuthenticated = true;
    mockAddToQueue.mockResolvedValue({ status: 'queued', id: 'op-edit-1' });
    mockInvalidateQueries.mockResolvedValue(undefined);
    mockGraphqlRequest.mockResolvedValue({ editMessage: { id: 'msg-9' } });
  });

  it('online: calls editMessage mutation with { id, input: { content } } and invalidates SSoT keys', async () => {
    const { result } = renderHook(() => useEditMessage('chan-1'));

    await result.current.editMessage('msg-9', 'corrected text');

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const [, variables] = mockGraphqlRequest.mock.calls[0];
    // Shape must match the EDIT_MESSAGE mutation variables ($id, $input).
    expect(variables).toEqual({ id: 'msg-9', input: { content: 'corrected text' } });

    // SSoT invalidation: the same key set the offline replay uses.
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tenant', 'tenant-1', 'messaging', 'channels'],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tenant', 'tenant-1', 'messaging', 'messages'],
    });
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('offline: enqueues editMessage as the typed { id, content } payload, not the mutation', async () => {
    mockIsOnline = false;

    const { result } = renderHook(() => useEditMessage('chan-1'));
    await result.current.editMessage('msg-9', 'corrected text');

    expect(mockAddToQueue).toHaveBeenCalledWith('editMessage', {
      id: 'msg-9',
      content: 'corrected text',
    });
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('online but network error: falls through to the offline queue (edit not lost)', async () => {
    mockGraphqlRequest.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useEditMessage('chan-1'));
    await result.current.editMessage('msg-9', 'corrected text');

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    expect(mockAddToQueue).toHaveBeenCalledWith('editMessage', {
      id: 'msg-9',
      content: 'corrected text',
    });
  });

  it('trims content before sending (online and offline)', async () => {
    const { result } = renderHook(() => useEditMessage('chan-1'));
    await result.current.editMessage('msg-9', '  spaced out  ');

    const [, variables] = mockGraphqlRequest.mock.calls[0];
    expect(variables).toEqual({ id: 'msg-9', input: { content: 'spaced out' } });
  });

  it('whitespace-only content is a no-op (nothing sent or queued)', async () => {
    const { result } = renderHook(() => useEditMessage('chan-1'));
    await result.current.editMessage('msg-9', '   ');

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('disabled when no channel: editMessage is a no-op', async () => {
    const { result } = renderHook(() => useEditMessage(undefined));
    await result.current.editMessage('msg-9', 'text');

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('disabled when unauthenticated: editMessage is a no-op', async () => {
    mockIsAuthenticated = false;

    const { result } = renderHook(() => useEditMessage('chan-1'));
    await result.current.editMessage('msg-9', 'text');

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });
});
