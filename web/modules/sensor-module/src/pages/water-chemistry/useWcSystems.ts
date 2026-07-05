/**
 * localStorage-backed store for SYSTEM tabs (P5c, mock). A system tab = a whole loop rendered
 * as ONE overlaid Deffeyes view (all its measurement points on one chart). Kept separate from
 * the point-card canvas store (useWcCards) — systems are page tabs, not draggable canvas cards.
 * Real phase: swap for a backend-persisted system/measurement-point model.
 */
import { useCallback, useEffect, useState } from 'react';

import { createSystemCard } from './systemModel';
import type { WcFlowStage, WcSystemCard } from './types';

const STORAGE_KEY = 'wc-systems-v1';

function seed(): WcSystemCard[] {
  return [createSystemCard('loop-a')];
}

/**
 * Persisted-schema guard — same crash class as the point-card store: a system
 * saved by an OLDER build can miss stage fields added since (a stage without
 * `paramSources` crashes the engine's source reads). A persisted system whose
 * every stage carries the current shape is kept as-is; anything else is rebuilt
 * from the current template for its systemId (title/chart/layout preserved) so
 * stale data upgrades instead of being trusted.
 */
function stageIsCurrent(raw: unknown): raw is WcFlowStage {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Partial<WcFlowStage>;
  return (
    typeof s.id === 'string' &&
    typeof s.label === 'string' &&
    !!s.scope &&
    typeof s.scope.id === 'string' &&
    !!s.paramSources &&
    typeof s.paramSources === 'object' &&
    typeof s.enabled === 'boolean'
  );
}

export function normalizeSystem(raw: unknown): WcSystemCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<WcSystemCard>;
  if (c.kind !== 'system' || typeof c.systemId !== 'string' || !c.systemId) return null;

  const flowCurrent = Array.isArray(c.flow) && c.flow.length > 0 && c.flow.every(stageIsCurrent);
  const sharedCurrent =
    !!c.shared &&
    typeof c.shared === 'object' &&
    !!c.shared.limits &&
    typeof c.shared.volumeM3 === 'number' &&
    Array.isArray(c.shared.selectedReagents);

  if (flowCurrent && sharedCurrent && typeof c.id === 'string' && typeof c.title === 'string') {
    const flow = c.flow as WcFlowStage[];
    const stageIds = new Set(flow.map((s) => s.id));
    const fallbackStage = flow.find((s) => s.kind === 'dosing-inlet') ?? flow[0];
    return {
      ...(c as WcSystemCard),
      activeStageId:
        typeof c.activeStageId === 'string' && stageIds.has(c.activeStageId)
          ? c.activeStageId
          : fallbackStage.id,
      dosingReferenceStageId:
        typeof c.dosingReferenceStageId === 'string' && stageIds.has(c.dosingReferenceStageId)
          ? c.dosingReferenceStageId
          : fallbackStage.id,
    };
  }

  // Stale schema → rebuild from the current template, keeping the user-visible bits.
  const fresh = createSystemCard(c.systemId);
  return {
    ...fresh,
    title: typeof c.title === 'string' && c.title ? c.title : fresh.title,
    chartType: c.chartType ?? fresh.chartType,
    layout: c.layout && typeof c.layout.x === 'number' ? c.layout : fresh.layout,
  };
}

function load(): WcSystemCard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return seed();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seed();
    return parsed.map(normalizeSystem).filter((s): s is WcSystemCard => s !== null);
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
