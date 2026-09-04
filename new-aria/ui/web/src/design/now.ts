// Shared clock for relative timestamps.
//
// WHY: a table may render hundreds of <Timestamp> cells; one interval feeding a
// subscription is far cheaper than one interval per cell, and it keeps every
// relative label on the page consistent with each other.
import { useSyncExternalStore } from 'react';

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      for (const entry of listeners) {
        entry();
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return now;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
