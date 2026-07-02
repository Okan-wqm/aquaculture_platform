/**
 * One water-chemistry card (P2). Header: title + chart-type dropdown + gear + remove.
 * Body: the selected chart from the card's explicit config (engineReady-guarded).
 */
import { type ReactElement } from 'react';

import { WcChart } from '../charts/WcCharts';
import { cardToEngineInputs } from '../engine-adapter';
import type { ChartType, WcCard } from '../types';

const CHART_LABELS: Record<ChartType, string> = {
  deffeyes: 'Deffeyes',
  nh3: 'NH₃ vs pH',
  co2: 'CO₂ vs pH',
  h2s: 'H₂S vs pH',
};

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
  const inputs = cardToEngineInputs(card);
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
      <div className="min-h-0 flex-1 p-2">
        {inputs ? (
          <WcChart inputs={inputs} chartType={card.chartType} />
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
