/**
 * Water Chemistry Monitoring — P1 (mock, frontend-only).
 *
 * Scope-driven per-tank / per-loop monitoring over the reused engine:
 *  - loop/site scope → lightweight tank STATUS GRID (recharts-free badges); click a
 *    tank to drill down.
 *  - tank scope → per-tank DRILL-DOWN charts (lean Deffeyes + UIA/CO₂ from the tank's
 *    self-consistent set) + the full resolved-value PROVENANCE table.
 *
 * `engineReady` guards the charts, so a loop (no single pH) can never feed the engine a
 * worst-case Frankenstein point. The full zone-shaded Deffeyes lands with the shared-ui
 * promotion in the real phase.
 */
import { type FC, type ReactElement, useMemo, useState } from 'react';

import TankDrilldown from './components/TankDrilldown';
import TankStatusGrid from './components/TankStatusGrid';
import { listScopeOptions, parentScopeOf } from './mock/resolveScope';
import type { Freshness, ParamKey, ParamSource, ResolvedValue, WcScope } from './types';
import { useResolvedParameterSet } from './useResolvedParameterSet';

const PARAM_LABELS: Record<ParamKey, string> = {
  temperature: 'Temperature',
  salinity: 'Salinity',
  ph: 'pH',
  alkalinity: 'Alkalinity',
  calcium: 'Calcium',
  tan: 'TAN',
  nitrate: 'Nitrate',
  co2: 'CO₂',
  h2s: 'H₂S',
  dissolvedOxygen: 'Dissolved O₂',
};
const SOURCE_CLASS: Record<ParamSource, string> = {
  sensor: 'bg-blue-100 text-blue-700',
  manual: 'bg-purple-100 text-purple-700',
  derived: 'bg-teal-100 text-teal-700',
};
const FRESHNESS_CLASS: Record<Freshness, string> = {
  fresh: 'bg-green-100 text-green-700',
  stale: 'bg-yellow-100 text-yellow-800',
  offline: 'bg-gray-200 text-gray-600',
  'bad-quality': 'bg-orange-100 text-orange-700',
  'n/a': 'bg-slate-100 text-slate-400',
};

function relTime(iso?: string): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
}

function Badge({ text, cls }: { text: string; cls: string }): ReactElement {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

function ProvenanceRow({ v, scopeKind }: { v: ResolvedValue; scopeKind: string }): ReactElement {
  const inherited = scopeKind === 'tank' && v.resolvedLevel !== 'tank';
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50">
      <td className="px-3 py-2 font-medium text-gray-800">{PARAM_LABELS[v.parameter]}</td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-900">
        {v.value == null ? <span className="text-gray-300">—</span> : v.value.toFixed(2)}
      </td>
      <td className="px-3 py-2 text-gray-500">{v.unit}</td>
      <td className="px-3 py-2"><Badge text={v.source} cls={SOURCE_CLASS[v.source]} /></td>
      <td className="px-3 py-2">
        <span className="text-xs text-gray-600">{v.resolvedLevel}</span>
        {inherited && <span className="ml-1 text-xs italic text-amber-600">inherited</span>}
      </td>
      <td className="px-3 py-2 text-xs text-gray-500">{v.sensorId ? `${v.sensorId} · ${v.channelId}` : '—'}</td>
      <td className="px-3 py-2 text-xs text-gray-500">{relTime(v.asOf)}</td>
      <td className="px-3 py-2 text-right text-xs text-gray-500">{v.quality != null ? `${v.quality}%` : '—'}</td>
      <td className="px-3 py-2"><Badge text={v.freshness} cls={FRESHNESS_CLASS[v.freshness]} /></td>
    </tr>
  );
}

const WaterChemistryMonitoringPage: FC = () => {
  const options = useMemo(() => listScopeOptions(), []);
  const [scope, setScope] = useState<WcScope>(options[0]?.scope ?? { kind: 'site', id: 'site-1' });
  const isTank = scope.kind === 'tank';
  const parent = parentScopeOf(scope);
  const { data, isLoading, isError } = useResolvedParameterSet(scope);

  const selectValue = `${scope.kind}:${scope.id}`;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Water Chemistry Monitoring</h1>
          <p className="text-sm text-gray-500">
            Per-scope resolved parameters with provenance, status & drill-down.{' '}
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">P1 · mock data</span>
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-gray-600">Scope</span>
          <select
            className="rounded border border-gray-300 px-2 py-1 text-sm"
            value={selectValue}
            onChange={(e) => {
              const opt = options.find((o) => `${o.scope.kind}:${o.scope.id}` === e.target.value);
              if (opt) setScope(opt.scope);
            }}
          >
            {options.map((o) => (
              <option key={`${o.scope.kind}:${o.scope.id}`} value={`${o.scope.kind}:${o.scope.id}`}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isTank && parent && (
        <button
          type="button"
          onClick={() => setScope(parent.scope)}
          className="mb-3 text-sm text-blue-600 hover:underline"
        >
          ← Back to {parent.label}
        </button>
      )}

      {!isTank && (
        <TankStatusGrid scope={scope} onSelectTank={(id) => setScope({ kind: 'tank', id })} />
      )}

      {isTank && (
        <div className="space-y-4">
          {isLoading && <p className="text-sm text-gray-400">Resolving…</p>}
          {isError && <p className="text-sm text-red-500">Failed to resolve parameters.</p>}
          {data && <TankDrilldown set={data} />}
          {data && (
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
                <span className="text-sm font-medium text-gray-700">
                  {data.scopeName} <span className="text-gray-400">({data.scope.kind}) — provenance</span>
                </span>
                <Badge
                  text={data.engineReady ? 'engine-ready' : 'no self-consistent set'}
                  cls={data.engineReady ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}
                />
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400">
                    <th className="px-3 py-2 font-medium">Parameter</th>
                    <th className="px-3 py-2 text-right font-medium">Value</th>
                    <th className="px-3 py-2 font-medium">Unit</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Level</th>
                    <th className="px-3 py-2 font-medium">Sensor · Channel</th>
                    <th className="px-3 py-2 font-medium">As of</th>
                    <th className="px-3 py-2 text-right font-medium">Quality</th>
                    <th className="px-3 py-2 font-medium">Freshness</th>
                  </tr>
                </thead>
                <tbody>
                  {data.values.map((v) => (
                    <ProvenanceRow key={v.parameter} v={v} scopeKind={data.scope.kind} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WaterChemistryMonitoringPage;
