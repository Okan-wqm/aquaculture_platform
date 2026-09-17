/**
 * Attachment send-retry tests — MSG-LOW-052.
 *
 * The orphan window: ChatRoomPage uploads media (durable storageKey in MinIO)
 * then calls sendMessage. If the send FAILS after a successful upload, the old
 * code lost the message with no retry, leaving an unreferenced object. The fix
 * (in useSendMessage) queues the SAME send — same idempotencyKey, same
 * attachmentKeys — for idempotent retry on a send failure, WITHOUT re-uploading.
 * The message-level idempotencyKey makes the retry at-most-once on the server.
 *
 * These tests pin the producer that ChatRoomPage drives (useSendMessage): a
 * post-upload send failure enqueues an idempotent retry carrying the durable
 * storageKey, and never triggers a second upload.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isOnline: true,
  addToQueue: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  graphqlRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, tenantId: 'tenant-1', isAuthenticated: true }),
}));

vi.mock('../../../hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => h.isOnline,
}));

vi.mock('../../../hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ addToQueue: h.addToQueue }),
}));

vi.mock('../../../services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => h.graphqlRequest(...args),
}));

vi.mock('../../../utils/offline-sync-invalidation', () => ({
  invalidateSyncedOperationQueries: vi.fn().mockResolvedValue(undefined),
}));

import { useSendMessage } from '../../../hooks/useSendMessage';

function makeWrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

describe('useSendMessage post-upload send retry (MSG-LOW-052)', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    h.isOnline = true;
    h.addToQueue.mockResolvedValue({ status: 'queued', id: 'q1' });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  it('queues an idempotent retry (same key + attachmentKeys) when the online send fails', async () => {
    // The send mutation fails AFTER the (already-successful) upload.
    h.graphqlRequest.mockRejectedValue(new Error('send 503'));

    const { result } = renderHook(() => useSendMessage('channel-1'), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current
        .sendMessage({
          content: null,
          contentType: 'IMAGE',
          attachmentKeys: ['messaging/tenant-1/ch/2026/06/img.png'],
        })
        .catch(() => undefined);
    });

    // The failed online send must enqueue a retry of the SAME send — carrying the
    // durable storageKey (no re-upload) and a stable idempotencyKey threaded as
    // the at-most-once command id.
    expect(h.addToQueue).toHaveBeenCalledTimes(1);
    const call = h.addToQueue.mock.calls[0] ?? [];
    const [type, payload, commandId] = call;
    expect(type).toBe('sendMessage');
    const p = payload as { attachmentKeys: string[]; idempotencyKey: string };
    expect(p.attachmentKeys).toEqual(['messaging/tenant-1/ch/2026/06/img.png']);
    // The queued idempotencyKey equals the threaded command id (at-most-once).
    expect(commandId).toBe(p.idempotencyKey);
    expect(typeof p.idempotencyKey).toBe('string');
  });

  it('does NOT queue a retry when the online send succeeds', async () => {
    h.graphqlRequest.mockResolvedValue({
      sendMessage: {
        id: 'm1',
        channelId: 'channel-1',
        content: null,
        contentType: 'IMAGE',
        createdAt: '',
      },
    });

    const { result } = renderHook(() => useSendMessage('channel-1'), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.sendMessage({
        content: null,
        contentType: 'IMAGE',
        attachmentKeys: ['messaging/tenant-1/ch/2026/06/img.png'],
      });
    });

    expect(h.addToQueue).not.toHaveBeenCalled();
  });
});
