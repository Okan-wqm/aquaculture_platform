/**
 * localStorage-backed store for SYSTEM tabs (P5c, mock). A system tab = a whole loop rendered
 * as ONE overlaid Deffeyes view (all its measurement points on one chart). Kept separate from
 * the point-card canvas store (useWcCards) — systems are page tabs, not draggable canvas cards.
 * Real phase: swap for a backend-persisted system/measurement-point model.
 */
import { useCallback, useEffect, useState } from 'react';

import { createSystemCard } from './systemModel';
import type { WcSystemCard } from './types';

const STORAGE_KEY = 'wc-systems-v1';

function seed(): WcSystemCard[] {
  return [createSystemCard('loop-a')];
}

function load(): WcSystemCard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return seed();
    const parsed = JSON.parse(raw) as WcSystemCard[];
    return Array.isArray(parsed) ? parsed : seed();
  } catch {
    return seed();
  }
}

export interface UseWcSystems {
  systems: WcSystemCard[];
  addSystem: (systemId: string) => string;
  updateSystem: (id: string, patch: Partial<WcSystemCard>) => void;
  removeSystem: (id: string) => void;
}

export function useWcSystems(): UseWcSystems {
  const [systems, setSystems] = useState<WcSystemCard[]>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(systems));
    } catch {
      /* storage full / unavailable — non-fatal for the mock */
    }
  }, [systems]);

  const addSystem = useCallback((systemId: string): string => {
    const system = createSystemCard(systemId);
    setSystems((cur) => [...cur, system]);
    return system.id;
  }, []);
  const updateSystem = useCallback((id: string, patch: Partial<WcSystemCard>) => {
    setSystems((cur) => cur.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);
  const removeSystem = useCallback((id: string) => {
    setSystems((cur) => cur.filter((s) => s.id !== id));
  }, []);

  return { systems, addSystem, updateSystem, removeSystem };
}
