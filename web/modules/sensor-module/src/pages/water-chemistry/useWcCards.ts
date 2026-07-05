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
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `wc-${Math.round(performance.now())}-${SPECIES_TEMPLATES.length}`;
}

function scopeName(scope: CardScope): string {
  if (scope.kind === 'biofilter') return LOOPS.find((l) => l.id === scope.id)?.name ?? scope.id;
  return TANKS.find((t) => t.id === scope.id)?.name ?? scope.id;
}

/** Build a default, engine-ready card: auto-bind a sensor per param where one exists, else manual. */
export function createCard(
  scope: CardScope,
  speciesTemplateId = 'salmon_freshwater',
  samplingLabel = 'Outlet',
): WcCard {
  const species = SPECIES_TEMPLATES.find((s) => s.id === speciesTemplateId) ?? SPECIES_TEMPLATES[0];
  const paramSources = {} as Record<ParamKey, ParamSourceConfig>;
  for (const p of ALL_PARAMS) {
    const sensors = sensorsForScope(scope, p);
    const sensor = sensors[0];
    paramSources[p] = sensor
      ? { mode: 'sensor', sensorId: sensor.id, channelId: sensor.channelId }
      : {
          mode: 'manual',
          value:
            p === 'alkalinity'
              ? species.limits.targetAlk
              : p === 'calcium'
                ? species.limits.caMgL
                : p === 'tan'
                  ? species.limits.tan
                  : MANUAL_DEFAULTS[p],
        };
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
    // Default big enough that the Deffeyes chart (chartHeight 300) + ResultsPanel fit
    // inside the widget without an immediate resize.
    layout: { x: 0, y: 0, w: 5, h: 9 },
  };
}

function seed(): WcCard[] {
  return [
    createCard({ kind: 'tank', id: 't1' }, 'salmon_freshwater', 'Outlet'),
    {
      ...createCard({ kind: 'tank', id: 't3' }, 'salmon_freshwater', 'After biofilter'),
      chartType: 'co2',
      layout: { x: 5, y: 0, w: 5, h: 9 },
    },
  ];
}

const CHART_TYPES: readonly ChartType[] = ['deffeyes', 'nh3', 'h2s', 'co2'];

/**
 * Persisted-schema guard (root cause of a prod crash on this page): cards live in
 * localStorage, so a card saved by an OLDER build can miss fields added since —
 * a pre-`paramSources` card crashed `sourceValue` with "Cannot read properties of
 * undefined (reading 'temperature')". Every persisted card is FORWARD-MIGRATED
 * here: a card with a recognizable scope keeps the user's title/limits/layout/
 * chart/sources where valid and has every missing section rebuilt from the
 * current template; anything unrecognizable is dropped. The schema can therefore
 * never crash the page again — old data upgrades instead of being trusted.
 */
export function normalizeCard(raw: unknown): WcCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<WcCard>;
  const scope = c.scope;
  if (
    !scope ||
    (scope.kind !== 'tank' && scope.kind !== 'biofilter') ||
    typeof scope.id !== 'string'
  ) {
    return null;
  }
  const fresh = createCard(
    { kind: scope.kind, id: scope.id },
    typeof c.speciesTemplateId === 'string' ? c.speciesTemplateId : undefined,
    typeof c.samplingLabel === 'string' ? c.samplingLabel : undefined,
  );
  const paramSources = { ...fresh.paramSources };
  if (c.paramSources && typeof c.paramSources === 'object') {
    for (const p of ALL_PARAMS) {
      const src = c.paramSources[p];
      if (src && (src.mode === 'sensor' || src.mode === 'manual')) {
        paramSources[p] = src;
      }
    }
  }
  const layout = c.layout;
  const layoutValid =
    !!layout &&
    typeof layout.x === 'number' &&
    typeof layout.y === 'number' &&
    typeof layout.w === 'number' &&
    typeof layout.h === 'number';
  return {
    ...fresh,
    id: typeof c.id === 'string' && c.id ? c.id : fresh.id,
    title: typeof c.title === 'string' && c.title ? c.title : fresh.title,
    limits:
      c.limits && typeof c.limits === 'object' ? { ...fresh.limits, ...c.limits } : fresh.limits,
    volumeM3: typeof c.volumeM3 === 'number' && c.volumeM3 > 0 ? c.volumeM3 : fresh.volumeM3,
    paramSources,
    chartType: c.chartType && CHART_TYPES.includes(c.chartType) ? c.chartType : fresh.chartType,
    layout: layoutValid ? layout : fresh.layout,
  };
}

function load(): WcCard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seed();
    const cards = parsed.map(normalizeCard).filter((card): card is WcCard => card !== null);
    return cards.length ? cards : seed();
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
    // Append at the BOTTOM (below every existing card) so a new widget never lands on
    // top of and disrupts the current layout.
    setCards((cs) => {
      const y = cs.reduce((m, c) => Math.max(m, c.layout.y + c.layout.h), 0);
      return [...cs, { ...card, layout: { ...card.layout, y } }];
    });
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
