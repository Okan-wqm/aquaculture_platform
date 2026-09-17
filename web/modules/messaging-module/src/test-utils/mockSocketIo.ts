/**
 * socket.io-client mock — handler-capturing fake Socket for vitest specs.
 *
 * The vi.mock factory (in the spec) lazily imports this module and returns
 * `socketIoModuleMock()`, so the singletons below are the SAME instances the
 * SUT's `io()` call receives. Specs assert on the spies and drive server
 * events via `fireSocketEvent`.
 */
import { vi } from 'vitest';

/** Handlers registered via socket.on(event, handler), keyed by event name. */
export const socketHandlers = new Map<string, (...args: unknown[]) => void>();
export const ioSpy = vi.fn();
export const socketEmitSpy = vi.fn();
export const socketDisconnectSpy = vi.fn();
export const socketRemoveAllListenersSpy = vi.fn();

/** The fake Socket handed out for every io() call in the spec. */
interface FakeSocket {
  on: (event: string, handler: (...args: unknown[]) => void) => FakeSocket;
  emit: (...args: unknown[]) => void;
  removeAllListeners: () => void;
  disconnect: () => void;
}

const mockSocket: FakeSocket = {
  on: (event: string, handler: (...args: unknown[]) => void): FakeSocket => {
    socketHandlers.set(event, handler);
    return mockSocket;
  },
  emit: socketEmitSpy,
  removeAllListeners: socketRemoveAllListenersSpy,
  disconnect: socketDisconnectSpy,
};

ioSpy.mockImplementation(() => mockSocket);

/** Simulate the server emitting `event` with `payload`. */
export function fireSocketEvent(event: string, payload?: unknown): void {
  socketHandlers.get(event)?.(payload);
}

/** The module shape substituted for 'socket.io-client'. */
export function socketIoModuleMock(): Record<string, unknown> {
  return { io: ioSpy };
}

export function resetSocketMock(): void {
  socketHandlers.clear();
  ioSpy.mockReset();
  ioSpy.mockImplementation(() => mockSocket);
  socketEmitSpy.mockReset();
  socketDisconnectSpy.mockReset();
  socketRemoveAllListenersSpy.mockReset();
}
