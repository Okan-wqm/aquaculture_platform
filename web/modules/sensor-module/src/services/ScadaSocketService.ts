/**
 * ScadaSocketService — Singleton Socket.IO client for the /scada namespace.
 *
 * Responsibilities:
 *  - Single shared connection per application lifetime (lazy singleton)
 *  - JWT auth injected on connect and refreshed on every reconnect attempt
 *  - Exponential backoff reconnection: 1s → 2s → 4s → 8s → max 30s
 *  - Typed event emitter facade over the raw socket
 *  - Connection state tracking (connected / connecting / disconnected / error)
 *  - Heartbeat monitoring: marks state 'error' if heartbeat lapses
 */

import { io, type Socket } from 'socket.io-client';
import { getAccessToken, getTenantId, onTenantChange, registerLogoutCleanup } from '@aquaculture/shared-ui';
import {
  ScadaSocketEvent,
  type TagValuesPayload,
  type TagWritePayload,
  type DaqQueryPayload,
  type DaqResultPayload,
  type DeviceStatusChange,
  type DataProviderConnectionState,
} from '../types/scada-runtime.types';

// ── URL resolution (mirrors existing hooks pattern) ──────────────────────────

const SCADA_WS_NAMESPACE: string =
  (() => {
    const base =
      (typeof import.meta !== 'undefined' && (import.meta as unknown as Record<string, unknown>).env != null
        ? (import.meta as unknown as { env: Record<string, string> }).env.VITE_WS_URL
        : undefined) ??
      (typeof window !== 'undefined'
        ? (window as Window & { __RUNTIME_CONFIG__?: { WS_URL?: string } }).__RUNTIME_CONFIG__?.WS_URL
        : undefined) ??
      '';
    return base ? `${base}/scada` : '/scada';
  })();

// ── Backoff config ────────────────────────────────────────────────────────────

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// ── Event payload map (client-visible events) ─────────────────────────────────

/**
 * Maps each ScadaSocketEvent to its payload type for type-safe callbacks.
 * Only the events that flow server→client (or are bidirectional) are included.
 */
export interface ScadaEventPayloadMap {
  [ScadaSocketEvent.TAG_VALUES]: TagValuesPayload;
  [ScadaSocketEvent.TAG_WRITE_ACK]: { tagId: string; success: boolean; error?: string };
  [ScadaSocketEvent.DEVICE_STATUS]: DeviceStatusChange;
  [ScadaSocketEvent.DAQ_RESULT]: DaqResultPayload;
  [ScadaSocketEvent.HEARTBEAT]: { timestamp: number };
  [ScadaSocketEvent.COMMAND_SET_VIEW]: { screenId: string };
  [ScadaSocketEvent.COMMAND_OPEN_CARD]: { screenId: string; x?: number; y?: number };
  [ScadaSocketEvent.COMMAND_TOAST]: { message: string; type?: string };
}

export type ScadaEventCallback<E extends keyof ScadaEventPayloadMap> = (
  payload: ScadaEventPayloadMap[E],
) => void;

// Internal listener store keyed on event name.
type ListenerMap = {
  [E in keyof ScadaEventPayloadMap]?: Set<ScadaEventCallback<E>>;
};

// ── Singleton class ───────────────────────────────────────────────────────────

export class ScadaSocketService {
  private static instance: ScadaSocketService | null = null;

  private socket: Socket | null = null;
  private _connectionState: DataProviderConnectionState = 'disconnected';
  private listeners: ListenerMap = {};
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Heartbeat timeout: if no inbound frame arrives within this window → 'error'. */
  private readonly HEARTBEAT_TIMEOUT_MS = 35_000;

  /**
   * Client heartbeat cadence. The server echoes each HEARTBEAT (resetting the
   * watchdog), so a genuinely idle-but-connected socket stays healthy — the
   * server sends no periodic heartbeat of its own, and without this a live
   * socket carrying no traffic would falsely trip to 'error' after 35 s and
   * block tag writes (SENSOR-HIGH-038).
   */
  private readonly HEARTBEAT_INTERVAL_MS = 15_000;

  private constructor() {}

  // ── Singleton accessor ────────────────────────────────────────────────────

  static getInstance(): ScadaSocketService {
    if (!ScadaSocketService.instance) {
      ScadaSocketService.instance = new ScadaSocketService();
    }
    return ScadaSocketService.instance;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get connectionState(): DataProviderConnectionState {
    return this._connectionState;
  }

  get isConnected(): boolean {
    return this._connectionState === 'connected';
  }

  /**
   * Connect (or reconnect) to the /scada namespace.
   * Safe to call multiple times — no-op when already connected.
   */
  connect(): void {
    if (this.socket?.connected) return;

    const token = getAccessToken();
    if (!token) {
      console.warn('[ScadaSocketService] No auth token — deferring connection');
      return;
    }

    // Tenant gate: never open the tenant-scoped /scada socket without a tenant
    // context to bind it to (matches socketFactory + the sibling sensor sockets).
    // Defer silently — a tenant arrives once AuthContext resolves the session;
    // onTenantChange/login will re-drive connect().
    if (!getTenantId()) {
      return;
    }

    this._setConnectionState('connecting');

    if (this.socket) {
      // Reuse existing socket instance; just update auth and reconnect.
      (this.socket as Socket & { auth: Record<string, unknown> }).auth = { token };
      this.socket.connect();
      return;
    }

    this.socket = io(SCADA_WS_NAMESPACE, {
      // Dedicated WS path: /scada is a sensor-service namespace, but nginx routes
      // ALL default /socket.io/ traffic to the gateway (which serves no /scada), so
      // SCADA real-time never reached sensor-service. A distinct path lets nginx
      // route SCADA straight to sensor-service:3000 (must match the gateway's path).
      path: '/scada-ws/',
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
      // Bounded, not Infinity: a full gateway/SCADA outage must not be amplified by
      // an unbounded reconnect storm against a dead upstream. The backoff already
      // caps the delay; this caps the count so the storm ends.
      reconnectionAttempts: 20,
      reconnectionDelay: BACKOFF_BASE_MS,
      reconnectionDelayMax: BACKOFF_MAX_MS,
      randomizationFactor: 0.3,
    });

    this._attachSocketListeners();
  }

  /**
   * Disconnect the socket and reset state.
   * Existing application-level listeners are preserved.
   */
  disconnect(): void {
    this._clearHeartbeatTimer();
    this._stopHeartbeat();
    if (this.socket) {
      this.socket.disconnect();
    }
    this._setConnectionState('disconnected');
  }

  /**
   * Emit an event to the server.
   * Messages are silently dropped if the socket is not connected.
   * Callers should check `connectionState` before emitting critical messages.
   */
  emit(event: ScadaSocketEvent, payload?: unknown): void {
    if (!this.socket?.connected) {
      console.warn(`[ScadaSocketService] emit(${event}) — not connected, dropping`);
      return;
    }
    this.socket.emit(event, payload);
  }

  /**
   * Register a typed callback for a server-pushed event.
   * Multiple callbacks per event are supported.
   */
  on<E extends keyof ScadaEventPayloadMap>(
    event: E,
    callback: ScadaEventCallback<E>,
  ): void {
    if (!this.listeners[event]) {
      (this.listeners as Record<string, Set<ScadaEventCallback<E>>>)[event] = new Set();
    }
    (this.listeners[event] as Set<ScadaEventCallback<E>>).add(callback);
  }

  /**
   * Remove a previously registered callback.
   */
  off<E extends keyof ScadaEventPayloadMap>(
    event: E,
    callback: ScadaEventCallback<E>,
  ): void {
    (this.listeners[event] as Set<ScadaEventCallback<E>> | undefined)?.delete(callback);
  }

  /**
   * Remove all application-level listeners for a specific event.
   */
  offAll(event: keyof ScadaEventPayloadMap): void {
    delete this.listeners[event];
  }

  /**
   * Register a one-time callback that is automatically removed after the first invocation.
   */
  once<E extends keyof ScadaEventPayloadMap>(
    event: E,
    callback: ScadaEventCallback<E>,
  ): void {
    const wrapper: ScadaEventCallback<E> = (payload) => {
      this.off(event, wrapper);
      callback(payload);
    };
    this.on(event, wrapper);
  }

  // ── Tag-level convenience methods ──────────────────────────────────────────

  /**
   * Subscribe to tag value updates.
   * Emits TAG_SUBSCRIBE with the provided tag IDs.
   */
  subscribeTags(tagIds: string[]): void {
    if (tagIds.length === 0) return;
    this.emit(ScadaSocketEvent.TAG_SUBSCRIBE, { tagIds });
  }

  /**
   * Unsubscribe from tag value updates.
   * Emits TAG_UNSUBSCRIBE with the provided tag IDs.
   */
  unsubscribeTags(tagIds: string[]): void {
    if (tagIds.length === 0) return;
    this.emit(ScadaSocketEvent.TAG_UNSUBSCRIBE, { tagIds });
  }

  /**
   * Write a value to a tag.  Emits TAG_WRITE and returns immediately.
   * For ack-based writes use the LiveDeviceDataProvider's writeTagValue instead.
   */
  writeTag(tagId: string, value: unknown): void {
    const payload: TagWritePayload = { tagId, value, function: 'set' };
    this.emit(ScadaSocketEvent.TAG_WRITE, payload);
  }

  /**
   * Exposes the underlying Socket.IO socket for low-level access (e.g. for
   * connection-state listeners in providers).  Returns null if not yet created.
   */
  get rawSocket(): Socket | null {
    return this.socket;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _attachSocketListeners(): void {
    const s = this.socket!;

    s.on('connect', () => {
      this._setConnectionState('connected');
      this._resetHeartbeatTimer();
      this._startHeartbeat();
    });

    s.on('disconnect', (_reason: string) => {
      this._clearHeartbeatTimer();
      this._stopHeartbeat();
      this._setConnectionState('disconnected');
    });

    s.on('connect_error', (err: Error) => {
      console.warn('[ScadaSocketService] connect_error:', err.message);
      this._setConnectionState('error');
    });

    // Refresh token on every reconnect attempt (mirrors socketFactory pattern)
    s.on('reconnect_attempt', () => {
      const freshToken = getAccessToken();
      if (freshToken) {
        (s as Socket & { auth: Record<string, unknown> }).auth = { token: freshToken };
      }
      this._setConnectionState('connecting');
    });

    s.on('reconnect', () => {
      this._setConnectionState('connected');
      this._resetHeartbeatTimer();
      this._startHeartbeat();
    });

    s.on('reconnect_failed', () => {
      this._setConnectionState('error');
    });

    // Forward all typed server-push events to application listeners.
    const serverPushEvents = Object.values(ScadaSocketEvent) as ScadaSocketEvent[];
    serverPushEvents.forEach((event) => {
      s.on(event, (payload: unknown) => {
        // Any inbound server frame proves the connection is alive — reset the
        // watchdog on all of them, not only HEARTBEAT. Previously a socket
        // streaming TAG_VALUES still tripped to 'error' after 35 s because
        // only HEARTBEAT (which the server never pushes on its own) reset it.
        this._resetHeartbeatTimer();
        this._dispatch(event as keyof ScadaEventPayloadMap, payload);
      });
    });
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit(ScadaSocketEvent.HEARTBEAT);
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private _dispatch<E extends keyof ScadaEventPayloadMap>(
    event: E,
    payload: unknown,
  ): void {
    const callbacks = this.listeners[event] as Set<ScadaEventCallback<E>> | undefined;
    if (!callbacks || callbacks.size === 0) return;
    callbacks.forEach((cb) => {
      try {
        cb(payload as ScadaEventPayloadMap[E]);
      } catch (err) {
        console.error(`[ScadaSocketService] Error in listener for ${String(event)}:`, err);
      }
    });
  }

  private _setConnectionState(state: DataProviderConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
  }

  private _resetHeartbeatTimer(): void {
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      console.warn('[ScadaSocketService] Heartbeat lapsed — marking state as error');
      this._setConnectionState('error');
    }, this.HEARTBEAT_TIMEOUT_MS);
  }

  private _clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ── Tenant-isolation teardown (module-level, registered once) ──────────────────

/**
 * SECURITY: the /scada socket is a process-wide singleton bound to the tenant
 * session it connected with (its JWT handshake). On a tenant switch
 * (SUPER_ADMIN impersonation) the previous tenant's TAG_VALUES stream would
 * otherwise keep pushing into a now-different tenant's view, and on logout the
 * still-open socket could be reused by the next user on the same browser.
 *
 * Disconnecting on both events stops the previous tenant's live stream
 * immediately (fail-safe to no-data, never stale-data). Reconnect for the new
 * tenant is re-established when a data provider next mounts and calls connect();
 * session-ready connect gating is layered on top in the socket-lifecycle pass.
 *
 * onTenantChange fires only on an actual A→B change (never on first login), so
 * normal single-tenant users are unaffected.
 */
onTenantChange(() => {
  ScadaSocketService.getInstance().disconnect();
});
registerLogoutCleanup(() => {
  ScadaSocketService.getInstance().disconnect();
});

// ── Convenience export ────────────────────────────────────────────────────────

/** Pre-bound singleton getter for use in providers/hooks. */
export const getScadaSocketService = (): ScadaSocketService =>
  ScadaSocketService.getInstance();

// Re-export payload types so consumers do not have to import from the types file.
export type {
  TagValuesPayload,
  TagWritePayload,
  DaqQueryPayload,
  DaqResultPayload,
};
