/**
 * providers/index.ts
 *
 * Bridges the SCADA runtime IDataProvider contract with the existing
 * ScadaDataContext / socket layer.  Hooks in this module import from here
 * so the data source is swappable (live, simulation, hybrid) without
 * changing any consumer code.
 */

import { useContext, useCallback } from 'react';
import { ScadaDataContext } from '../context/ScadaDataProvider';
import type { IDataProvider, TagValueChange, HistoricalDataResult } from '../types/scada-runtime.types';

// ---------------------------------------------------------------------------
// Internal: adapt ScadaDataContext to the IDataProvider shape
// ---------------------------------------------------------------------------

/**
 * useDataProvider
 *
 * Returns an IDataProvider-shaped object backed by the nearest
 * ScadaDataContext.  Throws if used outside a provider tree.
 *
 * The returned object is stable across renders — all methods are wrapped
 * in useCallback so referential equality is preserved unless the underlying
 * context reference changes.
 */
export function useDataProvider(): IDataProvider {
  const ctx = useContext(ScadaDataContext);
  if (!ctx) {
    throw new Error('useDataProvider must be used within a <ScadaDataProvider> or <SimulationDataProvider>');
  }

  // subscribeToTags: register each tagId under its device code.
  // Tag IDs in this codebase follow "deviceCode:tagName" convention, or a
  // plain tagName when device is implicit.  We emit subscribeTag for each.
  const subscribeToTags = useCallback(
    (tagIds: string[]) => {
      for (const tagId of tagIds) {
        const [deviceCode, tagName] = splitTagId(tagId);
        ctx.subscribeTag(deviceCode, tagName);
      }
    },
    [ctx],
  );

  const unsubscribeFromTags = useCallback(
    (tagIds: string[]) => {
      for (const tagId of tagIds) {
        const [deviceCode, tagName] = splitTagId(tagId);
        ctx.unsubscribeTag(deviceCode, tagName);
      }
    },
    [ctx],
  );

  const writeTagValue = useCallback(
    async (tagId: string, value: unknown): Promise<void> => {
      // Live write is handled by the socket layer; here we delegate to the
      // context.  If the context does not expose a write method (read-only
      // providers such as SimulationDataProvider stub it), we resolve silently.
      const writeCtx = ctx as typeof ctx & { writeTagValue?: (tagId: string, value: unknown) => Promise<void> };
      if (typeof writeCtx.writeTagValue === 'function') {
        return writeCtx.writeTagValue(tagId, value);
      }
      // Fallback: no-op (simulation provider sets sim store directly)
    },
    [ctx],
  );

  const getTagValue = useCallback(
    (tagId: string): TagValueChange | null => {
      const [deviceCode, tagName] = splitTagId(tagId);
      const raw = ctx.getTagValue(deviceCode, tagName);
      if (raw === undefined || raw === null) return null;

      // Raw values from the socket layer are either plain scalars or
      // { value, timestamp, quality } objects.
      if (typeof raw === 'object' && 'value' in raw) {
        return {
          tagId,
          value: (raw as { value: number | string | boolean }).value,
          timestamp: (raw as { timestamp?: number }).timestamp ?? Date.now(),
          quality: (raw as { quality?: TagValueChange['quality'] }).quality ?? 'good',
        };
      }
      return {
        tagId,
        value: raw as number | string | boolean,
        timestamp: Date.now(),
        quality: 'good',
      };
    },
    [ctx],
  );

  const queryHistory = useCallback(
    async (tagIds: string[], from: Date, to: Date): Promise<HistoricalDataResult> => {
      // Delegate to context if it exposes queryHistory; otherwise return empty.
      const histCtx = ctx as typeof ctx & {
        queryHistory?: (tagIds: string[], from: Date, to: Date) => Promise<HistoricalDataResult>;
      };
      if (typeof histCtx.queryHistory === 'function') {
        return histCtx.queryHistory(tagIds, from, to);
      }
      const empty: Record<string, never[]> = {};
      for (const id of tagIds) empty[id] = [];
      return { data: empty };
    },
    [ctx],
  );

  return {
    subscribeToTags,
    unsubscribeFromTags,
    writeTagValue,
    getTagValue,
    queryHistory,
    connectionState: ctx.isConnected ? 'connected' : 'connecting',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a composite tagId into [deviceCode, tagName].
 * Convention: "deviceCode:tagName"  →  ["deviceCode", "tagName"]
 *             "tagName"             →  ["__sim__",    "tagName"]
 */
function splitTagId(tagId: string): [string, string] {
  const colon = tagId.indexOf(':');
  if (colon === -1) return ['__sim__', tagId];
  return [tagId.slice(0, colon), tagId.slice(colon + 1)];
}
