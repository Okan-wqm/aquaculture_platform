/**
 * System water-chemistry card (P4b). One card = a whole loop. Tab strip over the ENABLED
 * flow stages (dosing-inlet · biofilter · every member tank/pond/cage); the active tab
 * renders that location's shared SSoT chart (its own realtime sources). ONE dosing +
 * toxic-border panel for the whole system, computed at the biofilter-inlet reference —
 * chemical is dosed once and affects the shared-water system.
 */
import { buildDeffeyesData, computeWaterChemistryOutputs } from '@aquaculture/shared-ui';
import type { WaterChemistryInputs } from '@aquaculture/shared-ui';
import {
  CarbonateVsPhChart,
  DeffeyesChart,
  H2sVsPhChart,
  ResultsPanel,
  UiaVsPhChart,
} from '@platform/shared-ui/water-chemistry/components';
import { type ReactElement } from 'react';

import { sourcesToWaterChemistryInputs } from '../engine-adapter';
import type { ChartType, WcSystemCard as WcSystemCardModel } from '../types';

const CHART_LABELS: Record<ChartType, string> = {
  deffeyes: 'Deffeyes',
  nh3: 'NH₃ vs pH',
  co2: 'CO₂ vs pH',
  h2s: 'H₂S vs pH',
};

function renderChart(chartType: ChartType, inputs: WaterChemistryInputs): ReactElement {
  const outputs = computeWaterChemistryOutputs(inputs, []);
  switch (chartType) {
    case 'nh3':
      return <UiaVsPhChart inputs={inputs} outputs={outputs} />;
    case 'h2s':
      return <H2sVsPhChart inputs={inputs} outputs={outputs} />;
    case 'co2':
      return <CarbonateVsPhChart inputs={inputs} outputs={outputs} />;
    case 'deffeyes':
    default:
      return (
        <div className="h-72">
          <DeffeyesChart data={buildDeffeyesData(inputs, [])} />
        </div>
      );
  }
}

const WcSystemCard = ({
  card,
  onChange,
  onConfigure,
  onRemove,
}: {
  card: WcSystemCardModel;
  onChange: (patch: Partial<WcSystemCardModel>) => void;
  onConfigure: () => void;
  onRemove: () => void;
}): ReactElement => {
  const stages = card.flow.filter((s) => s.enabled);
  const active = stages.find((s) => s.id === card.activeStageId) ?? stages[0];
  const activeInputs = active
    ? sourcesToWaterChemistryInputs(active.paramSources, card.shared.limits, card.shared.volumeM3)
    : null;

  // ONE dosing + toxic-border panel for the whole system, from the biofilter-inlet reference.
  const ref = card.flow.find((s) => s.id === card.dosingReferenceStageId) ?? card.flow[0];
  const refInputs = ref ? sourcesToWaterChemistryInputs(ref.paramSources, card.shared.limits, card.shared.volumeM3) : null;
  const systemOutputs = refInputs ? computeWaterChemistryOutputs(refInputs, card.shared.selectedReagents) : null;

  return (
    <div className="flex h-full flex-col rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-1.5">
        <span className="drag-handle flex-1 cursor-move truncate text-sm font-medium text-gray-800" title={card.title}>
          {card.title}
        </span>
        <select
          value={card.chartType}
          onChange={(e) => onChange({ chartType: e.target.value as ChartType })}
          className="rounded border border-gray-300 px-1 py-0.5 text-xs"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {(Object.keys(CHART_LABELS) as ChartType[]).map((t) => (
            <option key={t} value={t}>{CHART_LABELS[t]}</option>
          ))}
        </select>
        <button type="button" onClick={onConfigure} title="Configure" className="text-gray-400 hover:text-gray-700">⚙</button>
        <button type="button" onClick={onRemove} title="Remove" className="text-gray-400 hover:text-red-600">✕</button>
      </div>

      {/* Tab strip over the enabled flow stages */}
      <div className="flex flex-wrap gap-1 border-b border-gray-100 px-2 py-1" onPointerDown={(e) => e.stopPropagation()}>
        {stages.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange({ activeStageId: s.id })}
            className={`rounded px-2 py-0.5 text-xs ${
              s.id === active?.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-2">
        {activeInputs ? (
          renderChart(card.chartType, activeInputs)
        ) : (
          <div className="flex h-40 items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50 p-3 text-center text-xs text-gray-500">
            {active?.label ?? 'Stage'}: incomplete configuration — set temperature, salinity, pH and alkalinity (⚙).
          </div>
        )}
        {/* System-level toxic borders + ONE Dosing Recipes (biofilter-inlet reference). */}
        {systemOutputs && (
          <div>
            <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              System dosing &amp; limits — from {ref?.label}
            </p>
            <ResultsPanel outputs={systemOutputs} />
          </div>
        )}
      </div>
    </div>
  );
};

export default WcSystemCard;
