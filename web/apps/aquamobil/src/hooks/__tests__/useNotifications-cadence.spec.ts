/**
 * useNotifications unified cadence — FE-MEDIUM-053.
 *
 * The notification bell used a bespoke 300s setInterval over local useState while
 * the message badge used a 60s react-query poll, so the two unread surfaces could
 * disagree for up to ~5 minutes. The fix converges the bell onto react-query (same
 * QueryClient, same ~60s cadence) and wires a single FCM push to invalidate BOTH
 * the notification keys AND the messaging unreadCount key in one tick.
 *
 * These tests assert:
 *   - one PUSH_NOTIFICATION_EVENT invalidates the notification list + count AND
 *     the messaging unreadCount (bell and badge converge in one tick)
 *   - markAsRead applies an optimistic count decrement before the network settles
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import { PUSH_NOTIFICATION_EVENT } from '../useFirebaseMessaging';
import { useNotifications } from '../useNotifications';

import {
  GET_MY_NOTIFICATIONS,
  GET_UNREAD_COUNT,
  MARK_NOTIFICATION_READ,
} from '@/graphql/operations';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// --------------------------------------------------------------------------
// Mocks: auth (authenticated, fixed tenant) + graphqlRequest backend.
// --------------------------------------------------------------------------
vi.mock('../useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
}));

const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
}));

const TENANT = 'tenant-1';

function makeWrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  return ({ children }) => createElement(QueryClientProvider, { client }, children);
}

describe('useNotifications — FE-MEDIUM-053 unified cadence', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    mockGraphqlRequest.mockImplementation((doc: unknown) => {
      if (doc === GET_MY_NOTIFICATIONS) {
        return Promise.resolve({
          myNotifications: [
            { id: 'n1', title: 'A', body: 'b', isRead: false, createdAt: '2026-06-13T00:00:00Z' },
            { id: 'n2', title: 'B', body: 'b', isRead: false, createdAt: '2026-06-13T00:00:00Z' },
          ],
        });
      }
      if (doc === GET_UNREAD_COUNT) {
        return Promise.resolve({ unreadNotificationCount: 2 });
      }
      if (doc === MARK_NOTIFICATION_READ) {
        return Promise.resolve({ markNotificationAsRead: true });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it('lives in the shared QueryClient under the tenant query-key root', async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(client) });

    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    await waitFor(() => expect(result.current.notifications.length).toBe(2));

    // The count is addressable under the tenant root — provable cache convergence.
    const cached = client.getQueryData(
      createTenantQueryKey(TENANT, 'notifications', 'unreadCount'),
    );
    expect(cached).toBe(2);
  });

  it('a single PUSH event invalidates the bell AND the message badge in one tick', async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PUSH_NOTIFICATION_EVENT, { detail: {} }));
      await Promise.resolve();
    });

    // All three keys invalidated together: notification list, notification count,
    // AND the messaging unreadCount badge — the convergence contract.
    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown }).queryKey),
    );
    expect(invalidatedKeys).toContain(
      JSON.stringify(createTenantQueryKey(TENANT, 'notifications', 'list')),
    );
    expect(invalidatedKeys).toContain(
      JSON.stringify(createTenantQueryKey(TENANT, 'notifications', 'unreadCount')),
    );
    expect(invalidatedKeys).toContain(
      JSON.stringify(createTenantQueryKey(TENANT, 'messaging', 'unreadCount')),
    );
  });

  it('markAsRead applies an optimistic count decrement before the network settles', async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    // Hold the mark mutation open so we can observe the OPTIMISTIC state.
    let resolveMark: (v: unknown) => void = () => undefined;
    mockGraphqlRequest.mockImplementation((doc: unknown) => {
      if (doc === MARK_NOTIFICATION_READ) {
        return new Promise((resolve) => {
          resolveMark = resolve;
        });
      }
      if (doc === GET_UNREAD_COUNT) return Promise.resolve({ unreadNotificationCount: 1 });
      if (doc === GET_MY_NOTIFICATIONS) return Promise.resolve({ myNotifications: [] });
      return Promise.resolve({});
    });

    act(() => {
      void result.current.markAsRead('n1');
    });

    // Optimistic decrement applied immediately (2 → 1) BEFORE the mutation resolves.
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    // The marked notification is optimistically flagged read.
    await waitFor(() =>
      expect(result.current.notifications.find((n) => n.id === 'n1')?.isRead).toBe(true),
    );

    // Settle the network so the test does not leak a pending promise.
    await act(async () => {
      resolveMark({ markNotificationAsRead: true });
      await Promise.resolve();
    });
  });
});
