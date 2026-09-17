/**
 * useMessageSocket token-rotation stability — FE-MEDIUM-052.
 *
 * Before the fix, the connect/disconnect lifecycle effect listed `accessToken`
 * in its dependency array, so every ~5-minute token rotation tore down the
 * socket and rebuilt a new one — racing the in-band `reAuth` handshake and
 * dropping live delivery each rotation. The fix keys the lifecycle on auth
 * IDENTITY only (isAuthenticated, tenantId); the rotated token reaches the live
 * socket via accessTokenRef + the `reAuth` handler, with NO reconnect.
 *
 * These tests rotate the token while connected and assert:
 *   - the socket instance is NOT rebuilt (io factory called once, no disconnect)
 *   - a server `reAuth` updates socket.auth.token to the rotated value
 *   - a genuine tenant switch DOES rebuild (room/tenant scoping must change)
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Controllable fake Socket.IO socket — captures registered event handlers.
// --------------------------------------------------------------------------
type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();

function makeSocket(): {
  connected: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: (event: string, handler: Handler) => void;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  auth: Record<string, unknown>;
} {
  return {
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    off: vi.fn(),
    emit: vi.fn(),
    auth: {},
  };
}

let currentSocket = makeSocket();
const mockIo = vi.fn(() => currentSocket);
vi.mock('socket.io-client', () => ({ io: mockIo }));

// --------------------------------------------------------------------------
// Mutable auth holder — lets a rerender change accessToken while keeping the
// identity (isAuthenticated, tenantId) stable, simulating a token rotation.
// --------------------------------------------------------------------------
const refreshAuth = vi.fn().mockResolvedValue(undefined);
const authState = {
  accessToken: 'token-1' as string | null,
  isAuthenticated: true,
  tenantId: 'tenant-1' as string | null,
  refreshAuth,
};
vi.mock('../useAuth', () => ({
  useAuth: () => ({ ...authState }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
  };
});

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: vi.fn(),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

import { useMessageSocket } from '../useMessageSocket';

describe('useMessageSocket — FE-MEDIUM-052 token-rotation stability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    currentSocket = makeSocket();
    authState.accessToken = 'token-1';
    authState.isAuthenticated = true;
    authState.tenantId = 'tenant-1';
  });

  afterEach(() => {
    cleanup();
  });

  it('does NOT rebuild the socket on a token rotation (no disconnect/reconnect)', async () => {
    const { rerender } = renderHook(() => useMessageSocket());
    await waitFor(() => expect(mockIo).toHaveBeenCalledTimes(1));
    const socketAfterConnect = currentSocket;

    // Rotate the token (identity unchanged) and re-render.
    await act(async () => {
      authState.accessToken = 'token-2';
      rerender();
      await Promise.resolve();
    });

    // The lifecycle effect did NOT re-run: same io factory call count, no
    // disconnect, and the same socket instance is still live.
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(socketAfterConnect.disconnect).not.toHaveBeenCalled();
    expect(currentSocket).toBe(socketAfterConnect);
  });

  it('delivers the rotated token to the live socket via the reAuth handler (no reconnect)', async () => {
    const { rerender } = renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('reAuth')).toBeDefined());

    // The server requests fresh auth AFTER a rotation. Rotate the token and
    // re-render so accessTokenRef.current advances to the new value (the ref is
    // assigned on every render).
    await act(async () => {
      authState.accessToken = 'token-2';
      rerender();
      await Promise.resolve();
    });

    // Fire reAuth: refreshAuth resolves, then the handler reads accessTokenRef
    // and pushes the rotated token onto the SAME socket's auth — no reconnect.
    await act(async () => {
      handlers.get('reAuth')?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(refreshAuth).toHaveBeenCalled());
    // The rotated token reached the live socket without rebuilding it.
    await waitFor(() => expect(currentSocket.auth.token).toBe('token-2'));
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(currentSocket.disconnect).not.toHaveBeenCalled();
  });

  it('DOES rebuild the socket on a genuine tenant switch (room scoping changes)', async () => {
    const { rerender } = renderHook(() => useMessageSocket());
    await waitFor(() => expect(mockIo).toHaveBeenCalledTimes(1));
    const firstSocket = currentSocket;

    await act(async () => {
      authState.tenantId = 'tenant-2';
      currentSocket = makeSocket(); // io() will hand back the new socket
      rerender();
      await Promise.resolve();
    });

    // A tenant change MUST tear down the old socket and build a new one.
    await waitFor(() => expect(mockIo).toHaveBeenCalledTimes(2));
    expect(firstSocket.disconnect).toHaveBeenCalled();
  });
});
