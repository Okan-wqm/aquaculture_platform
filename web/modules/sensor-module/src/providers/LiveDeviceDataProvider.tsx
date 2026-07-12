/**
 * LiveDeviceDataProvider — IDataProvider backed by real device data over
 * the /scada Socket.IO namespace.
 *
 * Responsibilities:
 *  - Maintains an in-memory tag-value cache (tagId → TagValueChange).
 *  - Uses ScadaSocketService singleton for the WebSocket connection.
 *  - Uses TagSubscriptionManager for efficient, debounced, ref-counted subs.
 *  - Listens to TAG_VALUES events and merges incoming values into the cache.
 *  - writeTagValue emits TAG_WRITE and resolves on TAG_WRITE_ACK.
 *  - queryHistory emits DAQ_QUERY, accumulates chunked DAQ_RESULT payloads,
 *    and resolves once hasMore === false (or the single non-chunked result).
 *  - Tracks connectionState from the socket service.
 *  - Re-subscribes all active tags on reconnect.
 *  - Full cleanup on unmount (listeners, timers, subscriptions).
 */

import React, {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { onTenantChange, registerLogoutCleanup } from '@aquaculture/shared-ui';
import { ScadaSocketService } from '../services/ScadaSocketService';
import {
  createTagSubscriptionManager,
  TagSubscriptionManager,
} from '../services/TagSubscriptionManager';
import { DataProviderContext } from './DataProviderContext';
import {
  ScadaSocketEvent,
  type TagValueChange,
  type TagValuesPayload,
  type TagWritePayload,
  type DaqQueryPayload,
  type DaqResultPayload,
  type HistoricalDataResult,
  type HistoricalDataPoint,
  type DataProviderConnectionState,
} from '../types/scada-runtime.types';
import type { ScadaEventPayloadMap } from '../services/ScadaSocketService';

// ── DAQ query tracking ────────────────────────────────────────────────────────

interface PendingQuery {
  accumulated: Record<string, HistoricalDataPoint[]>;
  resolve: (result: HistoricalDataResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Timeout for a single DAQ query before rejecting the promise.
const DAQ_QUERY_TIMEOUT_MS = 30_000;

// TAG_WRITE ack timeout.
const WRITE_ACK_TIMEOUT_MS = 5_000;

// ── Inner provider ────────────────────────────────────────────────────────────

interface LiveDeviceDataProviderInnerProps {
  children: ReactNode;
}

/**
 * LiveDeviceDataProviderInner
 *
 * Exported as a named export so DataProviderRoot can import it dynamically
 * via React.lazy.
 */
export function LiveDeviceDataProviderInner({
  children,
}: LiveDeviceDataProviderInnerProps): React.ReactElement {
  // ── Socket service & subscription manager (stable across renders) ──────────

  const socketRef = useRef<ScadaSocketService>(ScadaSocketService.getInstance());
  const subManagerRef = useRef<TagSubscriptionManager | null>(null);

  if (subManagerRef.current === null) {
    subManagerRef.current = createTagSubscriptionManager(socketRef.current);
  }

  // ── Tag value cache ───────────────────────────────────────────────────────
  // Stored in a ref so writes inside event listeners don't trigger re-renders.
  // We deliberately do NOT put the cache into React state: widget components
  // should poll via getTagValue or subscribe to specific tags themselves.

  const tagCacheRef = useRef<Map<string, TagValueChange>>(new Map());

  // ── Connection state ──────────────────────────────────────────────────────

  const [connectionState, setConnectionState] =
    useState<DataProviderConnectionState>(
      () => socketRef.current.connectionState,
    );

  // ── Pending DAQ queries ───────────────────────────────────────────────────

  const pendingQueriesRef = useRef<Map<string, PendingQuery>>(new Map());

  // ── Pending write-ack promises ────────────────────────────────────────────

  type WriteResolvers = {
    resolve: () => void;
    reject: (err: Error) => void;
    handle: ReturnType<typeof setTimeout>;
  };
  const pendingWritesRef = useRef<Map<string, WriteResolvers>>(new Map());

  // ── Effect: wire up socket event listeners and lifecycle ──────────────────

  useEffect(() => {
    const socket = socketRef.current;
    const subManager = subManagerRef.current!;

    // Ensure the socket is connected.
    socket.connect();

    // --- TAG_VALUES handler ---
    const handleTagValues: ScadaEventPayloadMap[ScadaSocketEvent.TAG_VALUES] extends infer P
      ? (payload: P) => void
      : never = (payload: TagValuesPayload) => {
      const now = Date.now();
      for (const change of payload.values) {
        tagCacheRef.current.set(change.tagId, {
          ...change,
          timestamp: change.timestamp || now,
          deviceId: change.deviceId ?? payload.deviceId,
        });
      }
    };

    // --- TAG_WRITE_ACK handler ---
    const handleWriteAck = (payload: ScadaEventPayloadMap[ScadaSocketEvent.TAG_WRITE_ACK]) => {
      const pending = pendingWritesRef.current.get(payload.tagId);
      if (!pending) return;
      clearTimeout(pending.handle);
      pendingWritesRef.current.delete(payload.tagId);
      if (payload.success) {
        pending.resolve();
      } else {
        pending.reject(new Error(payload.error ?? `Write to ${payload.tagId} failed`));
      }
    };

    // --- DAQ_RESULT handler ---
    const handleDaqResult = (payload: DaqResultPayload) => {
      const pending = pendingQueriesRef.current.get(payload.queryId);
      if (!pending) return;

      // Merge incoming chunk into the accumulated result.
      for (const [tagId, points] of Object.entries(payload.data)) {
        if (!pending.accumulated[tagId]) {
          pending.accumulated[tagId] = [];
        }
        pending.accumulated[tagId].push(...points);
      }

      // Resolve when there are no more chunks coming.
      if (!payload.hasMore) {
        clearTimeout(pending.timeoutHandle);
        pendingQueriesRef.current.delete(payload.queryId);
        pending.resolve({
          data: pending.accumulated,
          queryId: payload.queryId,
        });
      }
    };

    // --- Connection state tracking ---
    const handleConnect = () => {
      setConnectionState('connected');
      // Re-subscribe all active tags immediately after reconnect.
      subManager.resubscribeAll();
    };

    const handleDisconnect = () => {
      setConnectionState('disconnected');
    };

    const handleConnectError = () => {
      setConnectionState('error');
    };

    const handleConnecting = () => {
      setConnectionState('connecting');
    };

    // Register application-level listeners on the socket service.
    socket.on(ScadaSocketEvent.TAG_VALUES, handleTagValues);
    socket.on(ScadaSocketEvent.TAG_WRITE_ACK, handleWriteAck);
    socket.on(ScadaSocketEvent.DAQ_RESULT, handleDaqResult);

    // Lightweight connection-change observers — the socket service doesn't
    // expose a generic state-change callback, so we hook the same socket
    // events that the service itself uses internally, mapping them to our
    // local state setter.
    const rawSocket = (socket as unknown as { socket: { on: (event: string, cb: () => void) => void; off: (event: string, cb: () => void) => void } }).socket;
    if (rawSocket) {
      rawSocket.on('connect', handleConnect);
      rawSocket.on('disconnect', handleDisconnect);
      rawSocket.on('connect_error', handleConnectError);
      rawSocket.on('reconnect_attempt', handleConnecting);
      rawSocket.on('reconnect', handleConnect);
    }

    // Sync initial state.
    setConnectionState(socket.connectionState);

    // ── Cleanup ─────────────────────────────────────────────────────────────
    return () => {
      socket.off(ScadaSocketEvent.TAG_VALUES, handleTagValues);
      socket.off(ScadaSocketEvent.TAG_WRITE_ACK, handleWriteAck);
      socket.off(ScadaSocketEvent.DAQ_RESULT, handleDaqResult);

      if (rawSocket) {
        rawSocket.off('connect', handleConnect);
        rawSocket.off('disconnect', handleDisconnect);
        rawSocket.off('connect_error', handleConnectError);
        rawSocket.off('reconnect_attempt', handleConnecting);
        rawSocket.off('reconnect', handleConnect);
      }

      // Cancel all in-flight DAQ queries.
      pendingQueriesRef.current.forEach((q) => {
        clearTimeout(q.timeoutHandle);
        q.reject(new Error('LiveDeviceDataProvider unmounted'));
      });
      pendingQueriesRef.current.clear();

      // Cancel all pending writes.
      pendingWritesRef.current.forEach((w) => {
        clearTimeout(w.handle);
        w.reject(new Error('LiveDeviceDataProvider unmounted'));
      });
      pendingWritesRef.current.clear();

      // Reset subscription manager so all ref-counts go to zero and the
      // server is notified on next mount.
      subManager.reset();

      // Clear tag cache.
      tagCacheRef.current.clear();
    };
   
  }, []); // Run once on mount; refs are stable.

  // ── Effect: tenant-isolation cache purge ──────────────────────────────────
  // SECURITY: the tag cache is keyed by bare tagId and the /scada socket is a
  // singleton bound to the tenant session it connected with. On a tenant switch
  // (SUPER_ADMIN impersonation) or logout, ScadaSocketService disconnects the
  // singleton so the previous tenant's TAG_VALUES stream stops; here we clear the
  // cached values so getTagValue / getTagSnapshot can never return the previous
  // tenant's data into the new tenant's view.
  useEffect(() => {
    const clearCache = (): void => {
      tagCacheRef.current.clear();
    };
    const unregisterTenantChange = onTenantChange(clearCache);
    const unregisterLogout = registerLogoutCleanup(clearCache);
    return () => {
      unregisterTenantChange();
      unregisterLogout();
    };
  }, []);

  // ── IDataProvider implementation ──────────────────────────────────────────

  const subscribeToTags = useCallback((componentId: string, tagIds: string[]): void => {
    // Each consumer subscribes under its own id; the manager ref-counts tags
    // across consumers and only unsubscribes a tag server-side when the last
    // consumer drops it.
    subManagerRef.current!.subscribe(componentId, tagIds);
  }, []);

  const unsubscribeFromTags = useCallback((componentId: string): void => {
    // Drop this consumer entirely — the manager decrements each of its tags and
    // emits TAG_UNSUBSCRIBE only for those no other consumer still holds.
    subManagerRef.current!.unsubscribe(componentId);
  }, []);

  const writeTagValue = useCallback(
    (tagId: string, value: unknown): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        const socket = socketRef.current;

        if (!socket.isConnected) {
          reject(new Error(`Cannot write ${tagId}: socket not connected`));
          return;
        }

        // Replace any in-flight write for the same tag.
        const existing = pendingWritesRef.current.get(tagId);
        if (existing) {
          clearTimeout(existing.handle);
          existing.reject(new Error(`Write to ${tagId} superseded`));
        }

        const handle = setTimeout(() => {
          pendingWritesRef.current.delete(tagId);
          reject(new Error(`Write to ${tagId} timed out`));
        }, WRITE_ACK_TIMEOUT_MS);

        pendingWritesRef.current.set(tagId, { resolve, reject, handle });

        const payload: TagWritePayload = { tagId, value, function: 'set' };
        socket.emit(ScadaSocketEvent.TAG_WRITE, payload);
      });
    },
    [],
  );

  const getTagValue = useCallback((tagId: string): TagValueChange | null => {
    return tagCacheRef.current.get(tagId) ?? null;
  }, []);

  const getTagSnapshot = useCallback((): Record<string, TagValueChange> => {
    // Copy the live tag cache into a plain object so the client-script
    // sandbox can serialize a self-contained snapshot across the Worker
    // boundary at execution start.
    const snapshot: Record<string, TagValueChange> = {};
    for (const [tagId, change] of tagCacheRef.current) {
      snapshot[tagId] = change;
    }
    return snapshot;
  }, []);

  const queryHistory = useCallback(
    (tagIds: string[], from: Date, to: Date): Promise<HistoricalDataResult> => {
      return new Promise<HistoricalDataResult>((resolve, reject) => {
        const socket = socketRef.current;

        if (!socket.isConnected) {
          reject(new Error('Cannot query history: socket not connected'));
          return;
        }

        const queryId = crypto.randomUUID();

        const timeoutHandle = setTimeout(() => {
          pendingQueriesRef.current.delete(queryId);
          reject(new Error(`DAQ query ${queryId} timed out`));
        }, DAQ_QUERY_TIMEOUT_MS);

        const pending: PendingQuery = {
          accumulated: {},
          resolve,
          reject,
          timeoutHandle,
        };

        pendingQueriesRef.current.set(queryId, pending);

        const payload: DaqQueryPayload = {
          queryId,
          tagIds,
          from: from.getTime(),
          to: to.getTime(),
          chunked: true,
        };

        socket.emit(ScadaSocketEvent.DAQ_QUERY, payload);
      });
    },
    [],
  );

  // ── Stable provider object ────────────────────────────────────────────────

  const provider = useMemo(
    () => ({
      subscribeToTags,
      unsubscribeFromTags,
      writeTagValue,
      getTagValue,
      getTagSnapshot,
      queryHistory,
      connectionState,
    }),
    [
      subscribeToTags,
      unsubscribeFromTags,
      writeTagValue,
      getTagValue,
      getTagSnapshot,
      queryHistory,
      connectionState,
    ],
  );

  return (
    <DataProviderContext.Provider value={provider}>
      {children}
    </DataProviderContext.Provider>
  );
}

export default LiveDeviceDataProviderInner;
