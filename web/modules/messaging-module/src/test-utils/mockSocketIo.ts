/**
 * socket.io-client mock — handler-capturing fake Socket for vitest specs.
 *
 * The vi.mock factory (in the spec) lazily imports this module and returns
 * `socketIoModuleMock()`, so the singletons below are the SAME instances the
 * SUT's `io()` call receives. Specs assert on the spies and drive server
 * events via `fireSocketEvent`.
 *
 * FAZ 3: the fake now carries a `connected` flag (the conditional-reconnect
 * loop and join-all effect key off it) — `connect`/`disconnect` events flip
 * it — and `emit` captures ack callbacks so specs can consume the third
 * argument like the real client (joinChannel acks).
 */
import { vi } from 'vitest';

/** Handlers registered via socket.on(event, handler), keyed by event name. */
export const socketHandlers = new Map<string, (...args: unknown[]) => void>();
export const ioSpy = vi.fn();
export const socketEmitSpy = vi.fn();
export const socketDisconnectSpy = vi.fn();
export const socketConnectSpy = vi.fn();
export const socketRemoveAllListenersSpy = vi.fn();

/** The fake Socket handed out for every io() call in the spec. */
interface FakeSocket {
  connected: boolean;
  auth: Record<string, unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => FakeSocket;
  emit: (...args: unknown[]) => void;
  connect: () => void;
  removeAllListeners: () => void;
  disconnect: () => void;
}

const mockSocket: FakeSocket = {
  connected: false,
  auth: {},
  on: (event: string, handler: (...args: unknown[]) => void): FakeSocket => {
    socketHandlers.set(event, handler);
    return mockSocket;
  },
  emit: socketEmitSpy,
  connect: socketConnectSpy,
  removeAllListeners: socketRemoveAllListenersSpy,
  disconnect: socketDisconnectSpy,
};

ioSpy.mockImplementation(() => mockSocket);

/** Server-side event names that carry connection-state semantics for the flag. */
const CONNECTED_STATE_EVENTS = new Set(['connect', 'disconnect', 'connect_error']);

/** Simulate the server emitting `event` with `payload`. */
export function fireSocketEvent(event: string, payload?: unknown): void {
  if (CONNECTED_STATE_EVENTS.has(event)) {
    mockSocket.connected = event === 'connect';
  }
  socketHandlers.get(event)?.(payload);
}

/** The fake socket instance shared by every io() call (specs read .auth etc.). */
export function getMockSocket(): FakeSocket {
  return mockSocket;
}

/**
 * Answer the most recent `emit(event, payload, ack)` call with `ackResult`
 * (the server's ack callback), like the real transport would.
 */
export function ackLastEmit(ackResult: unknown): void {
  const lastCall = socketEmitSpy.mock.calls.at(-1) as unknown[] | undefined;
  const ack = lastCall?.[lastCall.length - 1];
  if (typeof ack === 'function') {
    (ack as (result: unknown) => void)(ackResult);
  }
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
  socketConnectSpy.mockReset();
  socketRemoveAllListenersSpy.mockReset();
  mockSocket.connected = false;
  mockSocket.auth = {};
}
