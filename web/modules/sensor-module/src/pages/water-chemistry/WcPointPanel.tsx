/**
 * One measurement point of the monitoring view: the calculation it resolves
 * (DOSING at a system, TOXICITY at a tank) with its verdict, the chart and
 * results drawn from the resolved inputs — only when every input has a
 * measured value — and every live source at the point as a tile with its
 * 24 h trend. A tile opens its channel's full trend; a problem opens where
 * it is fixed (the channel manager here, the farm Sources/Parameters tabs).
 */
import {
  applyResolved,
  Button,
  computeWaterChemistryOutputs,
  DEFAULT_WATER_CHEMISTRY_INPUTS,
  ProblemChips,
  problemFixPath,
  useI18n,
  type InputSetResult,
  type ParameterSourceRow,
  type PointRef,
  type ProblemFix,
  type SourceProblemCode,
} from '@aquaculture/shared-ui';
import { ResultsPanel } from '@platform/shared-ui/water-chemistry/components';
import { type ReactElement, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { MultiParameterTrendCard } from '../../components/charts/MultiParameterTrendCard';

import { CHART_LABELS, PointChart } from './PointChart';
import { SourceTrendTile, TREND_RANGE } from './SourceTrendTile';
import { CHART_TYPES, isChartType, type ChartType } from './types';
import { usePointSources } from './useWaterChemistryMonitoring';

export interface WcPointPanelProps {
  point: PointRef;
  label: string;
  /** The point's own resolved set first, then the loop's (a tank reads alkalinity and calcium from it). */
  sets: readonly InputSetResult[];
  chartType: ChartType;
  onChartTypeChange: (chartType: ChartType) => void;
  now: number;
}

export function WcPointPanel({
  point,
  label,
  sets,
  chartType,
  onChartTypeChange,
  now,
}: WcPointPanelProps): ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sources = usePointSources(point);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Monitoring has no operator entries: a field no set covers is missing, never a default.
  const applied = useMemo(
    () =>
      applyResolved(DEFAULT_WATER_CHEMISTRY_INPUTS, sets, { overrides: {}, uncovered: 'missing' }),
    [sets],
  );
  const outputs = useMemo(
    () => (applied.inputs === null ? null : computeWaterChemistryOutputs(applied.inputs, [])),
    [applied.inputs],
  );
  const own = sets[0];

  const openFix = (fix: ProblemFix, source: ParameterSourceRow | null): void => {
    const path = problemFixPath(fix, {
      point,
      sensorId: source === null ? null : source.sensorId,
      channelKey: source === null ? null : source.channelKey,
    });
    if (path !== null) navigate(path);
  };

  const expandedEntry =
    expanded === null
      ? undefined
      : (sources.data ?? []).find((entry) => entry.source.id === expanded);

  return (
    <section
      className="space-y-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
      aria-label={label}
      data-testid="wc-point-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</h3>
          {own !== undefined && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              {own.set === 'DOSING' ? 'Dosing' : 'Toxicity'}: {t(`wqSource.verdict.${own.verdict}`)}
            </span>
          )}
          {own !== undefined && (
            <ProblemChips
              problems={own.problems}
              onFix={(_code: SourceProblemCode, fix: ProblemFix) => openFix(fix, null)}
            />
          )}
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
          {t('wqSource.ui.chart')}
          <select
            value={chartType}
            className="rounded border border-gray-300 px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
            onChange={(event) => {
              if (isChartType(event.target.value)) onChartTypeChange(event.target.value);
            }}
          >
            {CHART_TYPES.map((type) => (
              <option key={type} value={type}>
                {CHART_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
      </header>

      {applied.inputs !== null && outputs !== null ? (
        <>
          <PointChart chartType={chartType} inputs={applied.inputs} outputs={outputs} />
          <ResultsPanel outputs={outputs} />
        </>
      ) : (
        <p
          className="rounded border border-dashed border-gray-300 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
          data-testid="wc-not-drawn"
        >
          {t('wqSource.notDrawn', {
            fields: applied.missing.map((field) => t(`wqSource.field.${field}`)).join(', '),
          })}
        </p>
      )}

      {sources.error !== null && (
        <p role="alert" className="text-xs text-error-700 dark:text-error-300">
          The sources at this point could not be read: {sources.error.message}
        </p>
      )}
      {sources.data !== undefined && sources.data.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('wqSource.ui.noSourcesYet')}{' '}
          <Button variant="ghost" size="xs" type="button" onClick={() => openFix('source', null)}>
            {t('wqSource.ui.openSources')}
          </Button>
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
        {(sources.data ?? []).map((entry) => (
          <SourceTrendTile
            key={entry.source.id}
            entry={entry}
            now={now}
            selected={expanded === entry.source.id}
            onSelect={() =>
              setExpanded((prev) => (prev === entry.source.id ? null : entry.source.id))
            }
            onFix={(_code, fix) => openFix(fix, entry.source)}
          />
        ))}
      </div>

      {expandedEntry !== undefined &&
        expandedEntry.source.sensorId !== null &&
        expandedEntry.source.channelKey !== null && (
          <MultiParameterTrendCard
            sensorId={expandedEntry.source.sensorId}
            title={`${expandedEntry.source.parameterConfig.name} — ${expandedEntry.source.channelKey}`}
            channels={[
              {
                channelKey: expandedEntry.source.channelKey,
                displayLabel: expandedEntry.source.parameterConfig.name,
                unit:
                  expandedEntry.channel === null || expandedEntry.channel.unit === null
                    ? undefined
                    : expandedEntry.channel.unit,
                color: expandedEntry.source.parameterConfig.chartColor,
              },
            ]}
            range={TREND_RANGE}
          />
        )}
    </section>
  );
}
