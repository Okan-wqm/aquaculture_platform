/**
 * System-card config drawer (P4c). Right-side drawer to configure a WcSystemCard:
 * which MEMBERS to monitor (opt-out checkboxes over the flow stages), the shared Target +
 * Toxic Limits (drive every tab's chart + the system dosing), and the Reagents used for the
 * ONE system dosing recipe. Uses the shared NumberField (no duplication).
 */
import { REAGENTS } from '@platform/aquaculture-engines';
import { type ReactElement } from 'react';

import type { CardLimits, WcSystemCard } from '../types';
import { NumberField } from './fields';

const WcSystemConfigDrawer = ({
  card,
  onChange,
  onClose,
}: {
  card: WcSystemCard;
  onChange: (patch: Partial<WcSystemCard>) => void;
  onClose: () => void;
}): ReactElement => {
  const s = card.shared;
  const setLimit = (k: keyof CardLimits, v: number): void =>
    onChange({ shared: { ...s, limits: { ...s.limits, [k]: v } } });
  const setShared = (patch: Partial<WcSystemCard['shared']>): void => onChange({ shared: { ...s, ...patch } });
  const toggleStage = (id: string): void =>
    onChange({ flow: card.flow.map((st) => (st.id === id ? { ...st, enabled: !st.enabled } : st)) });
  const toggleReagent = (name: string): void => {
    const has = s.selectedReagents.includes(name);
    setShared({ selectedReagents: has ? s.selectedReagents.filter((r) => r !== name) : [...s.selectedReagents, name] });
  };

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-gray-200 bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-900">Configure system — {card.title}</h3>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Members to monitor (opt-out) */}
        <section className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Members to monitor</h4>
          {card.flow.map((st) => (
            <label key={st.id} className="flex items-center gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={st.enabled} onChange={() => toggleStage(st.id)} />
              <span className="truncate">{st.label}</span>
            </label>
          ))}
        </section>

        {/* Shared target + volume */}
        <section className="space-y-1 rounded bg-gray-50 p-2">
          <h4 className="pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">Target</h4>
          <NumberField label="Target pH" value={s.limits.targetPh} step={0.05} onChange={(v) => setLimit('targetPh', v)} />
          <NumberField label="Target alk" value={s.limits.targetAlk} unit="mg/L" step={5} onChange={(v) => setLimit('targetAlk', v)} />
          <NumberField label="System volume" value={s.volumeM3} unit="m³" step={5} onChange={(v) => setShared({ volumeM3: v })} />
        </section>

        {/* Toxic limits */}
        <section className="space-y-1 rounded bg-gray-50 p-2">
          <h4 className="pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">Toxic limits</h4>
          <NumberField label="NH₃-N limit" value={s.limits.nh3Limit} unit="mg/L" step={0.001} onChange={(v) => setLimit('nh3Limit', v)} />
          <NumberField label="CO₂ toxic" value={s.limits.co2Toxic} unit="mg/L" step={1} onChange={(v) => setLimit('co2Toxic', v)} />
          <NumberField label="H₂S limit" value={s.limits.h2sLimitUgL} unit="µg/L" step={1} onChange={(v) => setLimit('h2sLimitUgL', v)} />
          <NumberField label="TAN" value={s.limits.tan} unit="mg/L" step={0.1} onChange={(v) => setLimit('tan', v)} />
          <NumberField label="Calcium" value={s.limits.caMgL} unit="mg/L" step={5} onChange={(v) => setLimit('caMgL', v)} />
        </section>

        {/* Dosing reagents */}
        <section className="space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Dosing reagents</h4>
          <p className="text-[11px] text-gray-500">Reagents available to the system dosing recipe (biofilter-inlet reference).</p>
          {REAGENTS.map((r) => (
            <label key={r.name} className="flex items-center gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={s.selectedReagents.includes(r.name)} onChange={() => toggleReagent(r.name)} />
              <span className="flex-1 truncate">{r.name}</span>
              <span className="text-gray-400">{r.formula}</span>
            </label>
          ))}
        </section>
      </div>
    </div>
  );
};

export default WcSystemConfigDrawer;
