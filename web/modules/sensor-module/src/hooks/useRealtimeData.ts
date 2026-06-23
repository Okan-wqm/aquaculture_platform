/**
 * useRealtimeData — Subscribe to real-time tag values via IDataProvider.
 *
 * - Subscribes on mount, unsubscribes on unmount.
 * - Re-subscribes when tagIds change (compared by value, not reference).
 * - Batches rapid updates with requestAnimationFrame to avoid thrashing React.
 * - Returns a stable, memoized values object.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useDataProvider } from '../providers';
import type { TagValueChange } from '../types/scada-runtime.types';

export interface RealtimeDataResult {
  values: Record<string, TagValueChange>;
  isConnected: boolean;
  lastUpdate: number | null;
}

export function useRealtimeData(tagIds: string[]): RealtimeDataResult {
  const provider = useDataProvider();

  // Stable serialised key used as the useEffect dependency so the effect
  // only re-runs when the tag list actually changes by value.
  const tagIdsKey = useMemo(() => [...tagIds].sort().join('\0'), [tagIds]);

  // We keep accumulated values in a ref so the rAF callback can always read
  // the latest snapshot without capturing stale closure state.
  const pendingRef = useRef<Record<string, TagValueChange>>({});
  const rafHandleRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  const [snapshot, setSnapshot] = useState<{
    values: Record<string, TagValueChange>;
    lastUpdate: number | null;
  }>({ values: {}, lastUpdate: null });

  // Flush accumulated pending updates to React state via rAF.
  const scheduleFlush = useCallback(() => {
    if (rafHandleRef.current !== null) return; // already scheduled
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      if (!isMountedRef.current) return;
      const next = { ...pendingRef.current };
      setSnapshot({ values: next, lastUpdate: Date.now() });
    });
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // tagIds is reconstructed from tagIdsKey so it is always a fresh array
    // whose contents match the serialised key.
    const currentTagIds = tagIdsKey ? tagIdsKey.split('\0') : [];
    if (currentTagIds.length === 0) return;

    // Seed initial values from the provider cache so the consumer gets
    // something immediately even before the first live update arrives.
    const initial: Record<string, TagValueChange> = {};
    for (const id of currentTagIds) {
      const cached = provider.getTagValue(id);
      if (cached) initial[id] = cached;
    }
    pendingRef.current = { ...pendingRef.current, ...initial };
    scheduleFlush();

    provider.subscribeToTags(currentTagIds);

    // Poll for updates: in the current provider layer the subscription pushes
    // values into the context store and we read via getTagValue.  A polling
    // approach at 60 fps keeps us in sync without requiring an event emitter
    // to be added to IDataProvider.
    let pollingHandle: ReturnType<typeof setInterval> | null = null;
    pollingHandle = setInterval(() => {
      let changed = false;
      for (const id of currentTagIds) {
        const val = provider.getTagValue(id);
        if (val && val !== pendingRef.current[id]) {
          pendingRef.current = { ...pendingRef.current, [id]: val };
          changed = true;
        }
      }
      if (changed) scheduleFlush();
    }, 100);

    return () => {
      if (pollingHandle !== null) clearInterval(pollingHandle);
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
      provider.unsubscribeFromTags(currentTagIds);
    };
   
  }, [tagIdsKey, provider, scheduleFlush]);

  const isConnected = provider.connectionState === 'connected';

  return useMemo(
    () => ({
      values: snapshot.values,
      isConnected,
      lastUpdate: snapshot.lastUpdate,
    }),
    [snapshot.values, snapshot.lastUpdate, isConnected],
  );
}
