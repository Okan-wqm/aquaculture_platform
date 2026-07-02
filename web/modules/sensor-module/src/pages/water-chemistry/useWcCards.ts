/**
 * localStorage-backed card CRUD for the water-chemistry canvas (P2, mock).
 * Real phase: swap this store for a backend-persisted card/measurement-point model.
 */
import { useCallback, useEffect, useState } from 'react';

import { ALL_PARAMS, SPECIES_TEMPLATES, sensorsForScope, LOOPS, TANKS } from './mock/fixtures';
import type { CardScope, ChartType, ParamKey, ParamSourceConfig, WcCard } from './types';

const STORAGE_KEY = 'wc-cards-v1';

/** Sensible manual defaults so a new card is engine-ready out of the box. */
const MANUAL_DEFAULTS: Record<ParamKey, number> = {
  temperature: 15,
  salinity: 10,
  ph: 7.2,
  alkalinity: 100,
  calcium: 60,
  tan: 0.5,
  nitrate: 40,
  dissolvedOxygen: 8,
  co2: 0,
  h2s: 0,
};

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `wc-${Math.round(performance.now())}-${SPECIES_TEMPLATES.length}`;
}

function scopeName(scope: CardScope): string {
  if (scope.kind === 'biofilter') return LOOPS.find((l) => l.id === scope.id)?.name ?? scope.id;
  return TANKS.find((t) => t.id === scope.id)?.name ?? scope.id;
}

/** Build a default, engine-ready card: auto-bind a sensor per param where one exists, else manual. */
export function createCard(scope: CardScope, speciesTemplateId = 'salmon_freshwater', samplingLabel = 'Outlet'): WcCard {
  const species = SPECIES_TEMPLATES.find((s) => s.id === speciesTemplateId) ?? SPECIES_TEMPLATES[0];
  const paramSources = {} as Record<ParamKey, ParamSourceConfig>;
  for (const p of ALL_PARAMS) {
    const sensors = sensorsForScope(scope, p);
    const sensor = sensors[0];
    paramSources[p] = sensor
      ? { mode: 'sensor', sensorId: sensor.id, channelId: sensor.channelId }
      : { mode: 'manual', value: p === 'alkalinity' ? species.limits.targetAlk : p === 'calcium' ? species.limits.caMgL : p === 'tan' ? species.limits.tan : MANUAL_DEFAULTS[p] };
  }
  return {
    id: newId(),
    title: `${scopeName(scope)} · ${samplingLabel}`,
    scope,
    samplingLabel,
    speciesTemplateId: species.id,
    limits: { ...species.limits },
    volumeM3: 10,
    paramSources,
    chartType: 'deffeyes' as ChartType,
    layout: { x: 0, y: 0, w: 4, h: 5 },
  };
}

function seed(): WcCard[] {
  return [
    createCard({ kind: 'tank', id: 't1' }, 'salmon_freshwater', 'Outlet'),
    { ...createCard({ kind: 'tank', id: 't3' }, 'salmon_freshwater', 'After biofilter'), chartType: 'co2', layout: { x: 4, y: 0, w: 4, h: 5 } },
  ];
}

function load(): WcCard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as WcCard[];
    return Array.isArray(parsed) && parsed.length ? parsed : seed();
  } catch {
    return seed();
  }
}

export interface UseWcCards {
  cards: WcCard[];
  addCard: (scope: CardScope) => string;
  updateCard: (id: string, patch: Partial<WcCard>) => void;
  removeCard: (id: string) => void;
  resetDemo: () => void;
}

export function useWcCards(): UseWcCards {
  const [cards, setCards] = useState<WcCard[]>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
    } catch {
      /* storage full / unavailable — non-fatal for the mock */
    }
  }, [cards]);

  const addCard = useCallback((scope: CardScope): string => {
    const card = createCard(scope);
    setCards((cs) => [...cs, card]);
    return card.id;
  }, []);
  const updateCard = useCallback((id: string, patch: Partial<WcCard>) => {
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);
  const removeCard = useCallback((id: string) => {
    setCards((cs) => cs.filter((c) => c.id !== id));
  }, []);
  const resetDemo = useCallback(() => setCards(seed()), []);

  return { cards, addCard, updateCard, removeCard, resetDemo };
}
