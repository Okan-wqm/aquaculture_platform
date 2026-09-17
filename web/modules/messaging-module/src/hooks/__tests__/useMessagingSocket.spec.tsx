/**
 * useMessagingSocket specs — FAZ 1 Görev 3.
 *
 * Pins the live-update contract: joins the active channel on connect,
 * invalidates tenant-scoped queries on newMessage/messageSyncHint, reports
 * connection liveness ({ isConnected }) across disconnect/connect_error, and
 * catches up with an invalidation on (re)connect.
 */
import { createTenantInvalidationKey } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fireSocketEvent,
  ioSpy,
  resetSocketMock,
  socketDisconnectSpy,
  socketEmitSpy,
  socketRemoveAllListenersSpy,
} from '../../test-utils/mockSocketIo';
import { TEST_TENANT_ID } from '../../test-utils/sharedUiMock';
import { useMessagingSocket } from '../useMessagingSocket';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);
vi.mock('socket.io-client', async () =>
  (await import('../../test-utils/mockSocketIo')).socketIoModuleMock(),
);

const ACTIVE_CHANNEL = 'cccccccc-3333-4444-8555-666666666666';

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  resetSocketMock();
});

describe('useMessagingSocket', () => {
  it('connects to /messaging with the auth token and joins the active channel on connect', async () => {
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());

    expect(ioSpy.mock.calls[0][0]).toBe('/messaging');
    expect(ioSpy.mock.calls[0][1]).toMatchObject({ auth: { token: 'jwt' } });

    expect(result.current.isConnected).toBe(false);
    act(() => fireSocketEvent('connect'));
    expect(result.current.isConnected).toBe(true);
    expect(socketEmitSpy).toHaveBeenCalledWith('joinChannel', { channelId: ACTIVE_CHANNEL });
  });

  it('reports isConnected=false on disconnect and connect_error', async () => {
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());

    act(() => fireSocketEvent('connect'));
    expect(result.current.isConnected).toBe(true);

    act(() => fireSocketEvent('disconnect'));
    expect(result.current.isConnected).toBe(false);

    act(() => fireSocketEvent('connect'));
    act(() => fireSocketEvent('connect_error', new Error('xhr poll error')));
    expect(result.current.isConnected).toBe(false);
  });

  it('invalidates the thread + channels on newMessage (tenant-scoped keys)', async () => {
    const queryClient = newQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    invalidateSpy.mockClear();

    act(() => fireSocketEvent('newMessage', { channelId: ACTIVE_CHANNEL }));

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'messages', ACTIVE_CHANNEL),
    );
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('invalidates the hinted thread + channels on messageSyncHint (MSG-HIGH-063 parity)', async () => {
    const queryClient = newQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    invalidateSpy.mockClear();

    act(() => fireSocketEvent('messageSyncHint', { channelId: ACTIVE_CHANNEL }));

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'messages', ACTIVE_CHANNEL),
    );
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('ignores a messageSyncHint without a channelId (no messages-key invalidation)', async () => {
    const queryClient = newQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    invalidateSpy.mockClear();

    act(() => fireSocketEvent('messageSyncHint', {}));

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).not.toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'messages', ACTIVE_CHANNEL),
    );
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('catches up on reconnect: connect re-joins AND invalidates thread + channels', async () => {
    const queryClient = newQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());

    act(() => fireSocketEvent('connect'));
    act(() => fireSocketEvent('disconnect'));
    expect(result.current.isConnected).toBe(false);
    invalidateSpy.mockClear();

    // The reconnection gap may have dropped events — a fresh connect must
    // refetch instead of trusting the cache.
    act(() => fireSocketEvent('connect'));
    expect(result.current.isConnected).toBe(true);
    expect(socketEmitSpy).toHaveBeenCalledWith('joinChannel', { channelId: ACTIVE_CHANNEL });

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'messages', ACTIVE_CHANNEL),
    );
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('leaves the channel and disconnects on unmount (no dangling socket)', async () => {
    const queryClient = newQueryClient();
    const { unmount } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());

    unmount();

    expect(socketEmitSpy).toHaveBeenCalledWith('leaveChannel', { channelId: ACTIVE_CHANNEL });
    expect(socketRemoveAllListenersSpy).toHaveBeenCalled();
    expect(socketDisconnectSpy).toHaveBeenCalled();
  });
});
