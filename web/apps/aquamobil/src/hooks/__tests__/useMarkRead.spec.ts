/**
 * useMarkRead Hook Tests — Wave-6 M2 read-cursor advance.
 *
 * The mobile client's only job in the read-state SSoT is to TRIGGER the
 * server `markMessagesRead` handler. These tests pin the three write paths:
 *   - online            → markMessagesRead mutation + SSoT cache invalidation
 *   - offline           → enqueue on the shared offline queue
 *   - online + network error → fall through to the offline queue (no loss)
 *   - disabled (no channel / unauthenticated) → no-op
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
import { useMarkRead } from '../useMarkRead';

describe('useMarkRead — Wave-6 M2 read-cursor advance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnline = true;
    mockTenantId = 'tenant-1';
    mockIsAuthenticated = true;
    mockAddToQueue.mockResolvedValue('op-queued-1');
    mockInvalidateQueries.mockResolvedValue(undefined);
    mockGraphqlRequest.mockResolvedValue({ markMessagesRead: true });
  });

  it('online: calls markMessagesRead mutation with { channelId, messageId } and invalidates SSoT keys', async () => {
    const { result } = renderHook(() => useMarkRead('chan-1'));

    await result.current.markRead('msg-9');

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    const [, variables] = mockGraphqlRequest.mock.calls[0];
    expect(variables).toEqual({ input: { channelId: 'chan-1', messageId: 'msg-9' } });

    // SSoT invalidation: the same key set the offline replay uses.
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tenant', 'tenant-1', 'messaging', 'channels'],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tenant', 'tenant-1', 'messaging', 'messages'],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tenant', 'tenant-1', 'messaging', 'unreadCount'],
    });
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('offline: enqueues markMessagesRead on the offline queue and does NOT call the mutation', async () => {
    mockIsOnline = false;

    const { result } = renderHook(() => useMarkRead('chan-1'));
    await result.current.markRead('msg-9');

    expect(mockAddToQueue).toHaveBeenCalledWith('markMessagesRead', {
      channelId: 'chan-1',
      messageId: 'msg-9',
    });
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('online but network error: falls through to the offline queue (read advance not lost)', async () => {
    mockGraphqlRequest.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useMarkRead('chan-1'));
    await result.current.markRead('msg-9');

    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    expect(mockAddToQueue).toHaveBeenCalledWith('markMessagesRead', {
      channelId: 'chan-1',
      messageId: 'msg-9',
    });
  });

  it('disabled when no channel: markRead is a no-op', async () => {
    const { result } = renderHook(() => useMarkRead(undefined));
    await result.current.markRead('msg-9');

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('disabled when unauthenticated: markRead is a no-op', async () => {
    mockIsAuthenticated = false;

    const { result } = renderHook(() => useMarkRead('chan-1'));
    await result.current.markRead('msg-9');

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });
});
