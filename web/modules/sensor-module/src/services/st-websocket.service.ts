/**
 * STWebSocketService - Singleton socket.io-client for /st-language namespace
 *
 * Manages WebSocket connection to the ST language service backend.
 * Provides request-response pattern with timeout and server push handling.
 */

import { io, Socket } from 'socket.io-client';
import { getAccessToken } from '@platform/shared-ui/utils/api-client';
import type {
  STRequest,
  STResponse,
  STServerPush,
  STErrorResponse,
} from '../types/st-editor.types';

const WS_NAMESPACE =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL)
    ? `${(import.meta as any).env.VITE_WS_URL}/st-language`
    : (typeof window !== 'undefined' && (window as any).__RUNTIME_CONFIG__?.WS_URL)
      ? `${(window as any).__RUNTIME_CONFIG__.WS_URL}/st-language`
      : '/st-language';

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECTION_DELAY = 1000;
const RECONNECTION_DELAY_MAX = 5000;

/** Timeout per request type (ms) */
const REQUEST_TIMEOUTS: Record<string, number> = {
  analyze: 10_000,
  format: 5_000,
  hover: 3_000,
  complete: 3_000,
  outline: 3_000,
  definition: 3_000,
  references: 3_000,
};

type ConnectionChangeHandler = (connected: boolean) => void;
type PushHandler = (push: STServerPush) => void;

/** Pending request entry for tracking in-flight WS requests */
interface PendingRequest {
  resolve: (response: STResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class STWebSocketService {
  private socket: Socket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private connectionChangeHandlers = new Set<ConnectionChangeHandler>();
  private pushHandlers = new Set<PushHandler>();
  private _isConnected = false;

  connect(token?: string): void {
    if (this.socket?.connected) return;

    const jwt = token || getAccessToken();
    if (!jwt) {
      console.warn('[STWebSocket] No JWT token available, cannot connect');
      return;
    }

    // Disconnect existing socket if any
    this.disconnect();

    this.socket = io(WS_NAMESPACE, {
      auth: { token: jwt },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
      reconnectionDelay: RECONNECTION_DELAY,
      reconnectionDelayMax: RECONNECTION_DELAY_MAX,
    });

    this.socket.on('connect', () => {
      this._isConnected = true;
      this.notifyConnectionChange(true);
    });

    this.socket.on('disconnect', () => {
      this._isConnected = false;
      this.notifyConnectionChange(false);
      // Reject all pending requests on disconnect
      this.rejectAllPending('WebSocket disconnected');
    });

    this.socket.on('connect_error', (error) => {
      console.warn('[STWebSocket] Connection error:', error.message);
      this._isConnected = false;
      this.notifyConnectionChange(false);
    });

    // Server responses to our requests
    this.socket.on('st:response', (response: STResponse | STErrorResponse) => {
      const pending = this.pendingRequests.get(response.requestId);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pendingRequests.delete(response.requestId);

      if (response.type === 'error') {
        const errResp = response as STErrorResponse;
        pending.reject(new Error(errResp.error.message));
      } else {
        pending.resolve(response as STResponse);
      }
    });

    // Server push events
    this.socket.on('st:push', (push: STServerPush) => {
      this.pushHandlers.forEach((handler) => handler(push));
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.rejectAllPending('WebSocket disconnecting');
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this._isConnected = false;
      this.notifyConnectionChange(false);
    }
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Send a request and wait for the corresponding response.
   * Returns a promise that resolves with STResponse or rejects on timeout/error.
   */
  request(req: STRequest): Promise<STResponse> {
    return new Promise<STResponse>((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timeout = REQUEST_TIMEOUTS[req.type] ?? 5_000;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(req.requestId);
        reject(new Error(`Request ${req.type} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(req.requestId, { resolve, reject, timer });

      this.socket.emit('st:request', req);
    });
  }

  /**
   * Register a handler for server push events.
   * Returns an unsubscribe function.
   */
  onPush(handler: PushHandler): () => void {
    this.pushHandlers.add(handler);
    return () => {
      this.pushHandlers.delete(handler);
    };
  }

  /**
   * Register a handler for connection state changes.
   * Returns an unsubscribe function.
   */
  onConnectionChange(handler: ConnectionChangeHandler): () => void {
    this.connectionChangeHandlers.add(handler);
    return () => {
      this.connectionChangeHandlers.delete(handler);
    };
  }

  private notifyConnectionChange(connected: boolean): void {
    this.connectionChangeHandlers.forEach((handler) => handler(connected));
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}

/** Singleton instance */
export const stWebSocketService = new STWebSocketService();
