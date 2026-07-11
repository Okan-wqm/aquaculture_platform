/**
 * HybridDataProvider — Mixes simulation and live device data.
 *
 * Per-tag source routing:
 *  - Default: all tags come from the LiveDeviceDataProvider.
 *  - Individual tags can be overridden to come from SimulationDataProvider.
 *  - `setTagSource(tagId, 'simulation' | 'live')` mutates the routing map.
 *
 * The provider exposes both the standard IDataProvider interface AND a
 * `setTagSource` method via HybridDataProvider context (see below).
 *
 * Architecture:
 *  - Internally mounts both SimulationDataProviderInner and
 *    LiveDeviceDataProviderInner but does NOT nest them as React context
 *    providers.  Instead, it creates the two provider objects imperatively
 *    and routes calls based on the tag-source map.
 *  - connectionState reflects the live provider state (simulation is always
 *    'connected', so the live state is the meaningful signal).
 */

import React, {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { onTenantChange, registerLogoutCleanup } from '@aquaculture/shared-ui';
import { useScadaPackageStore } from '../store/scada';
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

// ── Tag source type ───────────────────────────────────────────────────────────

export type TagSource = 'simulation' | 'live';

// ── HybridContext — exposes setTagSource to child components ──────────────────

export interface HybridDataProviderContextValue {
  setTagSource: (tagId: string, source: TagSource) => void;
  getTagSource: (tagId: string) => TagSource;
  tagSourceMap: ReadonlyMap<string, TagSource>;
}

export const HybridDataProviderContext =
  createContext<HybridDataProviderContextValue | null>(null);
HybridDataProviderContext.displayName = 'HybridDataProviderContext';

/**
 * useHybridDataProvider — Access routing controls from within a hybrid tree.
 * Throws when used outside a <HybridDataProviderInner>.
 */
export function useHybridDataProvider(): HybridDataProviderContextValue {
  const ctx = useContext(HybridDataProviderContext);
  if (!ctx) {
    throw new Error(
      'useHybridDataProvider() must be used inside a <DataProviderRoot type="hybrid"> tree.',
    );
  }
  return ctx;
}

// ── Timeout constants ─────────────────────────────────────────────────────────

const DAQ_QUERY_TIMEOUT_MS = 30_000;
const WRITE_ACK_TIMEOUT_MS = 5_000;

// ── Pending promise types ─────────────────────────────────────────────────────

interface PendingQuery {
  accumulated: Record<string, HistoricalDataPoint[]>;
  resolve: (result: HistoricalDataResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface WriteResolvers {
  resolve: () => void;
  reject: (err: Error) => void;
  handle: ReturnType<typeof setTimeout>;
}

// ── Inner provider component ──────────────────────────────────────────────────

interface HybridDataProviderInnerProps {
  children: ReactNode;
}

/**
 * HybridDataProviderInner
 *
 * Exported as a named export for React.lazy use in DataProviderRoot.
 */
export function HybridDataProviderInner({
  children,
}: HybridDataProviderInnerProps): React.ReactElement {
  // ── Simulation side ───────────────────────────────────────────────────────

  const simTagValues = useScadaPackageStore((s) => s.simTagValues);
  const setSimTagValue = useScadaPackageStore((s) => s.setSimTagValue);
  const simTagValuesRef = useRef(simTagValues);
  simTagValuesRef.current = simTagValues;

  // ── Live side ─────────────────────────────────────────────────────────────

  const socketRef = useRef<ScadaSocketService>(ScadaSocketService.getInstance());
  const subManagerRef = useRef<TagSubscriptionManager | null>(null);
  if (subManagerRef.current === null) {
    subManagerRef.current = createTagSubscriptionManager(socketRef.current);
  }

  const liveTagCacheRef = useRef<Map<string, TagValueChange>>(new Map());

  const [liveConnectionState, setLiveConnectionState] =
    useState<DataProviderConnectionState>(
      () => socketRef.current.connectionState,
    );

  const pendingQueriesRef = useRef<Map<string, PendingQuery>>(new Map());
  const pendingWritesRef = useRef<Map<string, WriteResolvers>>(new Map());

  // ── Tag routing map ───────────────────────────────────────────────────────
  // Default source is 'live'; only overrides are stored.

  const [tagSourceMap, setTagSourceMap] = useState<Map<string, TagSource>>(
    () => new Map(),
  );
  const tagSourceMapRef = useRef(tagSourceMap);
  tagSourceMapRef.current = tagSourceMap;

  const getTagSource = useCallback((tagId: string): TagSource => {
    return tagSourceMapRef.current.get(tagId) ?? 'live';
  }, []);

  const setTagSource = useCallback(
    (tagId: string, source: TagSource): void => {
      setTagSourceMap((prev) => {
        const next = new Map(prev);
        if (source === 'live') {
          // Remove override → fall back to default 'live'.
          next.delete(tagId);
        } else {
          next.set(tagId, source);
        }
        return next;
      });
    },
    [],
  );

  // ── Effect: wire socket listeners ─────────────────────────────────────────

  useEffect(() => {
    const socket = socketRef.current;
    const subManager = subManagerRef.current!;

    socket.connect();

    const handleTagValues = (payload: TagValuesPayload) => {
      const now = Date.now();
      for (const change of payload.values) {
        liveTagCacheRef.current.set(change.tagId, {
          ...change,
          timestamp: change.timestamp || now,
          deviceId: change.deviceId ?? payload.deviceId,
        });
      }
    };

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

    const handleDaqResult = (payload: DaqResultPayload) => {
      const pending = pendingQueriesRef.current.get(payload.queryId);
      if (!pending) return;
      for (const [tagId, points] of Object.entries(payload.data)) {
        if (!pending.accumulated[tagId]) {
          pending.accumulated[tagId] = [];
        }
        pending.accumulated[tagId].push(...points);
      }
      if (!payload.hasMore) {
        clearTimeout(pending.timeoutHandle);
        pendingQueriesRef.current.delete(payload.queryId);
        pending.resolve({ data: pending.accumulated, queryId: payload.queryId });
      }
    };

    const handleConnect = () => {
      setLiveConnectionState('connected');
      subManager.resubscribeAll();
    };
    const handleDisconnect = () => setLiveConnectionState('disconnected');
    const handleConnectError = () => setLiveConnectionState('error');
    const handleConnecting = () => setLiveConnectionState('connecting');

    socket.on(ScadaSocketEvent.TAG_VALUES, handleTagValues);
    socket.on(ScadaSocketEvent.TAG_WRITE_ACK, handleWriteAck);
    socket.on(ScadaSocketEvent.DAQ_RESULT, handleDaqResult);

    const rawSocket = (socket as unknown as { socket: { on: (e: string, cb: () => void) => void; off: (e: string, cb: () => void) => void } }).socket;
    if (rawSocket) {
      rawSocket.on('connect', handleConnect);
      rawSocket.on('disconnect', handleDisconnect);
      rawSocket.on('connect_error', handleConnectError);
      rawSocket.on('reconnect_attempt', handleConnecting);
      rawSocket.on('reconnect', handleConnect);
    }

    setLiveConnectionState(socket.connectionState);

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

      pendingQueriesRef.current.forEach((q) => {
        clearTimeout(q.timeoutHandle);
        q.reject(new Error('HybridDataProvider unmounted'));
      });
      pendingQueriesRef.current.clear();

      pendingWritesRef.current.forEach((w) => {
        clearTimeout(w.handle);
        w.reject(new Error('HybridDataProvider unmounted'));
      });
      pendingWritesRef.current.clear();

      subManager.reset();
      liveTagCacheRef.current.clear();
    };
   
  }, []);

  // ── Effect: tenant-isolation cache purge ──────────────────────────────────
  // SECURITY: clear the live tag cache on tenant switch / logout. The /scada
  // singleton is disconnected by ScadaSocketService on those events (stopping the
  // previous tenant's TAG_VALUES stream); clearing here ensures getTagValue /
  // getTagSnapshot never surface the previous tenant's live values after a switch.
  useEffect(() => {
    const clearCache = (): void => {
      liveTagCacheRef.current.clear();
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
    // Route live-destined tags to the subscription manager under the consumer's
    // own id (simulation tags need no subscription). Ref-counting across
    // consumers is the manager's job.
    const liveTags = tagIds.filter((id) => getTagSource(id) === 'live');
    if (liveTags.length > 0) {
      subManagerRef.current!.subscribe(componentId, liveTags);
    }
  }, [getTagSource]);

  const unsubscribeFromTags = useCallback((componentId: string): void => {
    subManagerRef.current!.unsubscribe(componentId);
  }, []);

  const writeTagValue = useCallback(
    (tagId: string, value: unknown): Promise<void> => {
      const source = getTagSource(tagId);

      if (source === 'simulation') {
        const coerced =
          typeof value === 'number' ||
          typeof value === 'string' ||
          typeof value === 'boolean'
            ? value
            : String(value);
        setSimTagValue(tagId, coerced);
        return Promise.resolve();
      }

      // Live write.
      return new Promise<void>((resolve, reject) => {
        const socket = socketRef.current;
        if (!socket.isConnected) {
          reject(new Error(`Cannot write ${tagId}: socket not connected`));
          return;
        }

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
    [getTagSource, setSimTagValue],
  );

  const getTagValue = useCallback(
    (tagId: string): TagValueChange | null => {
      const source = getTagSource(tagId);

      if (source === 'simulation') {
        const raw = simTagValuesRef.current[tagId];
        if (raw === undefined || raw === null) return null;
        const value =
          typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean'
            ? raw
            : String(raw);
        return { tagId, value, timestamp: Date.now(), quality: 'good' };
      }

      return liveTagCacheRef.current.get(tagId) ?? null;
    },
    [getTagSource],
  );

  const getTagSnapshot = useCallback((): Record<string, TagValueChange> => {
    // Merge both sources into a single snapshot, honouring the per-tag
    // routing map. Live values win for tags routed to 'live'; simulation
    // values win for tags overridden to 'simulation'. This mirrors the
    // per-tag routing of getTagValue, but materialised for the worker.
    const now = Date.now();
    const snapshot: Record<string, TagValueChange> = {};

    // Live cache first (default source).
    for (const [tagId, change] of liveTagCacheRef.current) {
      if (getTagSource(tagId) === 'live') {
        snapshot[tagId] = change;
      }
    }

    // Simulation values for tags routed to 'simulation'.
    for (const [tagId, raw] of Object.entries(simTagValuesRef.current)) {
      if (getTagSource(tagId) !== 'simulation') continue;
      if (raw === undefined || raw === null) continue;
      const value =
        typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean'
          ? raw
          : String(raw);
      snapshot[tagId] = { tagId, value, timestamp: now, quality: 'good' };
    }

    return snapshot;
  }, [getTagSource]);

  const queryHistory = useCallback(
    (tagIds: string[], from: Date, to: Date): Promise<HistoricalDataResult> => {
      // Simulation tags have no history; live tags go through DAQ.
      const liveTags = tagIds.filter((id) => getTagSource(id) === 'live');
      const simTags = tagIds.filter((id) => getTagSource(id) === 'simulation');

      // Build empty result for sim tags.
      const simData: Record<string, []> = {};
      for (const id of simTags) {
        simData[id] = [];
      }

      if (liveTags.length === 0) {
        return Promise.resolve({ data: simData });
      }

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
          // Pre-populate sim results so they're included in final merged result.
          accumulated: { ...simData },
          resolve,
          reject,
          timeoutHandle,
        };

        pendingQueriesRef.current.set(queryId, pending);

        const payload: DaqQueryPayload = {
          queryId,
          tagIds: liveTags,
          from: from.getTime(),
          to: to.getTime(),
          chunked: true,
        };

        socket.emit(ScadaSocketEvent.DAQ_QUERY, payload);
      });
    },
    [getTagSource],
  );

  // ── Hybrid routing context value ──────────────────────────────────────────

  const hybridCtxValue = useMemo<HybridDataProviderContextValue>(
    () => ({ setTagSource, getTagSource, tagSourceMap }),
    [setTagSource, getTagSource, tagSourceMap],
  );

  // ── IDataProvider context value ───────────────────────────────────────────

  const provider = useMemo(
    () => ({
      subscribeToTags,
      unsubscribeFromTags,
      writeTagValue,
      getTagValue,
      getTagSnapshot,
      queryHistory,
      connectionState: liveConnectionState,
    }),
    [
      subscribeToTags,
      unsubscribeFromTags,
      writeTagValue,
      getTagValue,
      getTagSnapshot,
      queryHistory,
      liveConnectionState,
    ],
  );

  return (
    <HybridDataProviderContext.Provider value={hybridCtxValue}>
      <DataProviderContext.Provider value={provider}>
        {children}
      </DataProviderContext.Provider>
    </HybridDataProviderContext.Provider>
  );
}

export default HybridDataProviderInner;
