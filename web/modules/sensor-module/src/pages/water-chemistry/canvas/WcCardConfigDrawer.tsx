/**
 * Card config drawer (P2, mock). Right-side drawer to configure one card:
 * scope (tank/biofilter), sampling point, species → editable limits, volume, and a
 * per-parameter source table (sensor dropdown filtered to the scope | manual value).
 */
import { type ReactElement } from 'react';

import {
  LOOPS,
  SAMPLING_PRESETS,
  SPECIES_TEMPLATES,
  TANKS,
  UNITS,
  sensorsForScope,
} from '../mock/fixtures';
import type { CardScope, ParamKey, WcCard } from '../types';
import { createCard } from '../useWcCards';
import { NumberField } from './fields';

const SOURCE_PARAMS: ParamKey[] = [
  'temperature', 'salinity', 'ph', 'alkalinity', 'calcium', 'tan', 'nitrate', 'dissolvedOxygen', 'h2s',
];
const PARAM_LABEL: Record<ParamKey, string> = {
  temperature: 'Temperature', salinity: 'Salinity', ph: 'pH', alkalinity: 'Alkalinity',
  calcium: 'Calcium', tan: 'TAN', nitrate: 'Nitrate', dissolvedOxygen: 'Dissolved O₂', co2: 'CO₂', h2s: 'H₂S',
};

const WcCardConfigDrawer = ({
  card,
  onChange,
  onClose,
}: {
  card: WcCard;
  onChange: (patch: Partial<WcCard>) => void;
  onClose: () => void;
}): ReactElement => {
  const setScope = (scope: CardScope): void => {
    // Re-derive param sources for the new scope (auto-bind available sensors).
    const fresh = createCard(scope, card.speciesTemplateId, card.samplingLabel);
    onChange({ scope, title: fresh.title, paramSources: fresh.paramSources });
  };
  const setSpecies = (id: string): void => {
    const sp = SPECIES_TEMPLATES.find((s) => s.id === id);
    if (sp) onChange({ speciesTemplateId: id, limits: { ...sp.limits } });
  };
  const setLimit = (k: keyof WcCard['limits'], v: number): void => onChange({ limits: { ...card.limits, [k]: v } });
  const setSource = (p: ParamKey, patch: Partial<WcCard['paramSources'][ParamKey]>): void =>
    onChange({ paramSources: { ...card.paramSources, [p]: { ...card.paramSources[p], ...patch } } });

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-gray-200 bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-900">Configure card</h3>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Scope */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Scope</h4>
          <div className="flex gap-2 text-xs">
            <select value={card.scope.kind} onChange={(e) => setScope({ kind: e.target.value as CardScope['kind'], id: e.target.value === 'tank' ? TANKS[0].id : LOOPS[0].id })}
              className="rounded border border-gray-300 px-2 py-1">
              <option value="tank">Tank</option>
              <option value="biofilter">Biofilter (loop)</option>
            </select>
            <select value={card.scope.id} onChange={(e) => setScope({ kind: card.scope.kind, id: e.target.value })}
              className="flex-1 rounded border border-gray-300 px-2 py-1">
              {(card.scope.kind === 'tank' ? TANKS : LOOPS).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-gray-600">Sampling</span>
            <input list="wc-sampling-presets" value={card.samplingLabel}
              onChange={(e) => onChange({ samplingLabel: e.target.value })}
              className="flex-1 rounded border border-gray-300 px-2 py-1" />
            <datalist id="wc-sampling-presets">
              {SAMPLING_PRESETS.map((s) => <option key={s} value={s} />)}
            </datalist>
          </label>
        </section>

        {/* Species + limits */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Species &amp; limits</h4>
          <select value={card.speciesTemplateId} onChange={(e) => setSpecies(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs">
            {SPECIES_TEMPLATES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="space-y-1 rounded bg-gray-50 p-2">
            <NumberField label="NH₃-N limit" value={card.limits.nh3Limit} unit="mg/L" step={0.001} onChange={(v) => setLimit('nh3Limit', v)} />
            <NumberField label="CO₂ toxic" value={card.limits.co2Toxic} unit="mg/L" step={1} onChange={(v) => setLimit('co2Toxic', v)} />
            <NumberField label="H₂S limit" value={card.limits.h2sLimitUgL} unit="µg/L" step={1} onChange={(v) => setLimit('h2sLimitUgL', v)} />
            <NumberField label="Target pH" value={card.limits.targetPh} step={0.05} onChange={(v) => setLimit('targetPh', v)} />
            <NumberField label="Target alk" value={card.limits.targetAlk} unit="mg/L" step={5} onChange={(v) => setLimit('targetAlk', v)} />
            <NumberField label="Volume" value={card.volumeM3} unit="m³" step={1} onChange={(v) => onChange({ volumeM3: v })} />
          </div>
        </section>

        {/* Per-parameter source */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Data sources</h4>
          <div className="space-y-1.5">
            {SOURCE_PARAMS.map((p) => {
              const src = card.paramSources[p];
              const sensors = sensorsForScope(card.scope, p);
              return (
                <div key={p} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-gray-700">{PARAM_LABEL[p]}</span>
                  <select value={src.mode} onChange={(e) => setSource(p, e.target.value === 'sensor'
                    ? { mode: 'sensor', sensorId: sensors[0]?.id, channelId: sensors[0]?.channelId }
                    : { mode: 'manual', value: src.value ?? 0 })}
                    className="rounded border border-gray-300 px-1 py-0.5">
                    <option value="sensor" disabled={sensors.length === 0}>Sensor</option>
                    <option value="manual">Manual</option>
                  </select>
                  {src.mode === 'sensor' ? (
                    <select value={src.sensorId ?? ''} onChange={(e) => {
                      const s = sensors.find((x) => x.id === e.target.value);
                      setSource(p, { sensorId: s?.id, channelId: s?.channelId });
                    }} className="flex-1 rounded border border-gray-300 px-1 py-0.5">
                      {sensors.length === 0 && <option value="">— none —</option>}
                      {sensors.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  ) : (
                    <span className="flex flex-1 items-center gap-1">
                      <input type="number" step={0.1} value={src.value ?? 0} onChange={(e) => setSource(p, { value: Number(e.target.value) })}
                        className="w-full rounded border border-gray-300 px-1 py-0.5 text-right" />
                      <span className="w-8 text-gray-400">{UNITS[p]}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};

export default WcCardConfigDrawer;
