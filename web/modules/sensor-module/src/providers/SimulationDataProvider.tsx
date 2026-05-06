/**
 * SimulationDataProvider — IDataProvider backed by the simulationSlice.
 *
 * Reads tag values from the Zustand SCADA store's `simTagValues` map and
 * writes back to it via `setSimTagValue`.  There is no network connection;
 * `connectionState` is always 'connected'.
 *
 * `queryHistory` returns an empty result set — the simulation has no
 * persistent history store.
 */

import React, {
  useMemo,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { useScadaStore } from '../store/scada';
import { DataProviderContext } from './DataProviderContext';
import type {
  IDataProvider,
  TagValueChange,
  HistoricalDataResult,
  DataProviderConnectionState,
} from '../types/scada-runtime.types';

// ── Stable constant — avoids object recreation each render ────────────────────

const CONNECTION_STATE: DataProviderConnectionState = 'connected';

// ── Inner provider component (consumed by DataProviderRoot via lazy import) ───

interface SimulationDataProviderInnerProps {
  children: ReactNode;
}

/**
 * SimulationDataProviderInner
 *
 * Exported separately from the default export so DataProviderRoot can
 * dynamically import it as a named export via React.lazy.
 */
export function SimulationDataProviderInner({
  children,
}: SimulationDataProviderInnerProps): React.ReactElement {
  // Fine-grained selector: re-render only when simTagValues reference changes.
  const simTagValues = useScadaStore((s) => s.simTagValues);
  const setSimTagValue = useScadaStore((s) => s.setSimTagValue);

  // Keep a ref to simTagValues so getTagValue reads the latest snapshot
  // without requiring it to be in the useMemo dependency array (which
  // would recreate the provider object on every tag update).
  const simTagValuesRef = useRef(simTagValues);
  simTagValuesRef.current = simTagValues;

  // ── IDataProvider implementation ────────────────────────────────────────────

  const subscribeToTags = useCallback((_tagIds: string[]): void => {
    // No-op: simulation values are pushed via the store; no subscription needed.
  }, []);

  const unsubscribeFromTags = useCallback((_tagIds: string[]): void => {
    // No-op.
  }, []);

  const writeTagValue = useCallback(
    async (tagId: string, value: unknown): Promise<void> => {
      // Accept number | string | boolean; silently coerce anything else.
      const coerced =
        typeof value === 'number' ||
        typeof value === 'string' ||
        typeof value === 'boolean'
          ? value
          : String(value);
      setSimTagValue(tagId, coerced);
    },
    [setSimTagValue],
  );

  const getTagValue = useCallback((tagId: string): TagValueChange | null => {
    const raw = simTagValuesRef.current[tagId];
    if (raw === undefined || raw === null) return null;

    const value =
      typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean'
        ? raw
        : String(raw);

    return {
      tagId,
      value,
      timestamp: Date.now(),
      quality: 'good',
    };
  }, []);

  const queryHistory = useCallback(
    async (
      tagIds: string[],
      _from: Date,
      _to: Date,
    ): Promise<HistoricalDataResult> => {
      // Simulation has no history — return empty arrays for each requested tag.
      const data: Record<string, []> = {};
      for (const id of tagIds) {
        data[id] = [];
      }
      return { data };
    },
    [],
  );

  // ── Stable provider object ─────────────────────────────────────────────────
  // The IDataProvider shape is an object, not a class; build it with useMemo so
  // the context value reference only changes when a dependency actually changes.

  const provider = useMemo<IDataProvider>(
    () => ({
      subscribeToTags,
      unsubscribeFromTags,
      writeTagValue,
      getTagValue,
      queryHistory,
      connectionState: CONNECTION_STATE,
    }),
    [subscribeToTags, unsubscribeFromTags, writeTagValue, getTagValue, queryHistory],
  );

  return (
    <DataProviderContext.Provider value={provider}>
      {children}
    </DataProviderContext.Provider>
  );
}

// ── Default export (also used as the named component from DataProviderRoot) ───

export default SimulationDataProviderInner;
