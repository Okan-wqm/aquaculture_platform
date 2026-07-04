/**
 * One water-chemistry card (P3b). Header: title + chart-type dropdown + gear + remove.
 * Body: the SHARED SSoT chart — identical to the farm calculator (DeffeyesChart / the
 * secondary UIA·H₂S·CO₂ charts), engineReady-guarded. No lean fork.
 */
import { buildDeffeyesData, computeWaterChemistryOutputs } from '@aquaculture/shared-ui';
import type { CalculatedOutputs, WaterChemistryInputs } from '@aquaculture/shared-ui';
import {
  CarbonateVsPhChart,
  DeffeyesChart,
  H2sVsPhChart,
  ResultsPanel,
  UiaVsPhChart,
} from '@platform/shared-ui/water-chemistry/components';
import { type ReactElement } from 'react';

import { cardToWaterChemistryInputs } from '../engine-adapter';
import type { ChartType, WcCard } from '../types';

const CHART_LABELS: Record<ChartType, string> = {
  deffeyes: 'Deffeyes',
  nh3: 'NH₃ vs pH',
  co2: 'CO₂ vs pH',
  h2s: 'H₂S vs pH',
};

function renderChart(chartType: ChartType, inputs: WaterChemistryInputs, outputs: CalculatedOutputs): ReactElement {
  switch (chartType) {
    case 'nh3':
      return <UiaVsPhChart inputs={inputs} outputs={outputs} />;
    case 'h2s':
      return <H2sVsPhChart inputs={inputs} outputs={outputs} />;
    case 'co2':
      return <CarbonateVsPhChart inputs={inputs} outputs={outputs} />;
    case 'deffeyes':
    default:
      // chartHeight keeps the (otherwise 700px) Deffeyes chart INSIDE the widget so it
      // no longer overflows and covers the ResultsPanel below it.
      return <DeffeyesChart data={buildDeffeyesData(inputs, [])} chartHeight={300} />;
  }
}

const WcChartCard = ({
  card,
  onChange,
  onConfigure,
  onRemove,
}: {
  card: WcCard;
  onChange: (patch: Partial<WcCard>) => void;
  onConfigure: () => void;
  onRemove: () => void;
}): ReactElement => {
  const inputs = cardToWaterChemistryInputs(card);
  const outputs = inputs ? computeWaterChemistryOutputs(inputs, []) : null;
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
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-2">
        {inputs && outputs ? (
          <>
            {renderChart(card.chartType, inputs, outputs)}
            {/* Toxic-border readouts + Dosing Recipes (shared ResultsPanel, SSoT). */}
            <ResultsPanel outputs={outputs} />
          </>
        ) : (
          <div className="flex h-full items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50 p-3 text-center text-xs text-gray-500">
            Incomplete configuration — set temperature, salinity, pH and alkalinity (⚙) to render.
          </div>
        )}
      </div>
    </div>
  );
};

export default WcChartCard;
