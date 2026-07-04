/**
 * System water-chemistry TAB view (P5c). One system (loop) = ONE Deffeyes chart with EVERY
 * measurement point (dosing-inlet · biofilter · each member) OVERLAID — each point its own
 * colored operating marker + its own toxic zones (its own limits). Checkboxes toggle which
 * points overlay; pH isolines auto-hide beyond a single point (DeffeyesChart). Below the chart,
 * ONE system dosing + toxic-border panel computed at the biofilter-inlet reference (chemical is
 * dosed once and affects the shared-water system). The gear opens the shared config drawer
 * (member limits + reagents); the checkboxes here are the member opt-out.
 */
import { buildDeffeyesData, computeWaterChemistryOutputs } from '@aquaculture/shared-ui';
import {
  DeffeyesChart,
  ResultsPanel,
  type DeffeyesOverlay,
} from '@platform/shared-ui/water-chemistry/components';
import { type ReactElement, useState } from 'react';

import WcSystemConfigDrawer from './canvas/WcSystemConfigDrawer';
import { sourcesToWaterChemistryInputs } from './engine-adapter';
import type { WcSystemCard } from './types';

// Stable palette indexed by flow-stage position so a point keeps its color as others toggle.
const OVERLAY_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

const WcSystemView = ({
  system,
  onChange,
  onRemove,
}: {
  system: WcSystemCard;
  onChange: (patch: Partial<WcSystemCard>) => void;
  onRemove: () => void;
}): ReactElement => {
  const [configOpen, setConfigOpen] = useState(false);
  const { limits, volumeM3, selectedReagents } = system.shared;

  // One overlay per ENABLED stage (its own inputs → its own operating point + zones).
  const overlays: DeffeyesOverlay[] = system.flow.flatMap((stage, i) => {
    if (!stage.enabled) return [];
    const inputs = sourcesToWaterChemistryInputs(stage.paramSources, limits, volumeM3);
    if (!inputs) return [];
    return [{ data: buildDeffeyesData(inputs, []), label: stage.label, color: OVERLAY_COLORS[i % OVERLAY_COLORS.length] }];
  });

  // ONE system dosing + toxic-border panel from the biofilter-inlet reference.
  const ref = system.flow.find((s) => s.id === system.dosingReferenceStageId) ?? system.flow[0];
  const refInputs = ref ? sourcesToWaterChemistryInputs(ref.paramSources, limits, volumeM3) : null;
  const systemOutputs = refInputs ? computeWaterChemistryOutputs(refInputs, selectedReagents) : null;

  const toggleStage = (id: string): void =>
    onChange({ flow: system.flow.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">{system.title}</h2>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setConfigOpen(true)}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">⚙ Configure</button>
          <button type="button" onClick={onRemove}
            className="rounded border border-gray-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50">Remove system</button>
        </div>
      </div>

      {/* Measurement points to overlay (each a colored legend + opt-out checkbox) */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg border border-gray-200 bg-white p-3">
        {system.flow.map((stage, i) => (
          <label key={stage.id} className="flex items-center gap-1.5 text-xs text-gray-700">
            <input type="checkbox" checked={stage.enabled} onChange={() => toggleStage(stage.id)} />
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: OVERLAY_COLORS[i % OVERLAY_COLORS.length] }} />
            <span className="truncate">{stage.label}</span>
          </label>
        ))}
      </div>

      {overlays.length > 0 ? (
        <DeffeyesChart data={overlays[0].data} overlays={overlays} chartHeight={460} />
      ) : (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-center text-sm text-gray-500">
          No points selected — enable a measurement point above, or complete its configuration (⚙).
        </div>
      )}

      {systemOutputs && (
        <div>
          <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            System dosing &amp; limits — from {ref?.label}
          </p>
          <ResultsPanel outputs={systemOutputs} />
        </div>
      )}

      {configOpen && (
        <WcSystemConfigDrawer card={system} onChange={onChange} onClose={() => setConfigOpen(false)} />
      )}
    </div>
  );
};

export default WcSystemView;
