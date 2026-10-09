/**
 * One measurement point of the monitoring view: the calculation it resolves
 * (DOSING at a system, TOXICITY at a tank) with its verdict and age, every
 * field the chart is drawn from — where it was read (the point, its loop, a
 * system it inherits from), its window and why it is not usable — the chart
 * and results when every value is usable, and every live source at the point
 * as a tile with its 24 h trend. A problem opens where it is fixed.
 */
import {
  computeWaterChemistryOutputs,
  FieldProvenanceChip,
  formatAge,
  ProblemChips,
  problemFixPath,
  RESOLVABLE_FIELDS,
  staleSetText,
  useI18n,
  type I18nContextValue,
  type ParameterSourceRow,
  type PointRef,
  type ProblemFix,
  type SourceProblemCode,
  Button,
} from '@aquaculture/shared-ui';
import { ResultsPanel } from '@platform/shared-ui/water-chemistry/components';
import { type ReactElement, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { MultiParameterTrendCard } from '../../components/charts/MultiParameterTrendCard';
import { useChannelSeriesBySensor, type SensorSeriesRequest } from '../../hooks/useChannelReadings';

import { CHART_LABELS, PointChart } from './PointChart';
import type { PointState } from './pointState';
import { SourceTrendTile, TREND_RANGE, TREND_REFRESH_MS } from './SourceTrendTile';
import { CHART_TYPES, isChartType, type ChartType } from './types';
import { usePointSources } from './useWaterChemistryMonitoring';

/** TAN and H₂S are read at tanks: a system point never has them, so it says why, not "missing". */
const TANK_ONLY_FIELDS: readonly string[] = ['tan', 'h2sUgL'];

/** Why a read point is not drawn, in the current language. */
export function notDrawnReason(
  t: I18nContextValue['t'],
  state: Extract<PointState, { status: 'ready' }>,
): string | null {
  if (state.record.inputs !== null) return null;
  const blocking = state.record.blocking;
  if (
    state.sets.own.set === 'DOSING' &&
    blocking.every((entry) => entry.state === 'missing' && TANK_ONLY_FIELDS.includes(entry.field))
  ) {
    return t('wqSource.systemNotDrawn');
  }
  return t('wqSource.blocking', {
    fields: blocking.map((entry) => t(`wqSource.field.${entry.field}`)).join(', '),
  });
}

export interface WcPointPanelProps {
  point: PointRef;
  label: string;
  state: PointState;
  chartType: ChartType;
  onChartTypeChange: (chartType: ChartType) => void;
  now: number;
}

export function WcPointPanel({
  point,
  label,
  state,
  chartType,
  onChartTypeChange,
  now,
}: WcPointPanelProps): ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sources = usePointSources(point);
  const [expanded, setExpanded] = useState<string | null>(null);

  const record = state.status === 'ready' ? state.record : null;
  const outputs = useMemo(
    // Monitoring doses nowhere: no reagent is passed, so the volume is never read.
    () =>
      record === null || record.inputs === null
        ? null
        : computeWaterChemistryOutputs(record.inputs, []),
    [record],
  );

  // One series request per sensor, narrowed to the channels charted here.
  const seriesRequests = useMemo((): SensorSeriesRequest[] => {
    const bySensor = new Map<string, string[]>();
    for (const entry of sources.data ?? []) {
      const { sensorId, channelKey } = entry.source;
      if (sensorId === null || channelKey === null) continue;
      bySensor.set(sensorId, [...(bySensor.get(sensorId) ?? []), channelKey]);
    }
    return [...bySensor].map(([sensorId, channelKeys]) => ({
      sensorId,
      channelKeys: [...new Set(channelKeys)].sort(),
    }));
  }, [sources.data]);
  const series = useChannelSeriesBySensor(seriesRequests, TREND_RANGE, TREND_REFRESH_MS);

  const windowOf = (parameterConfigId: string): number | null => {
    if (state.status !== 'ready') return null;
    const input = state.sets.own.inputs.find(
      (candidate) => candidate.parameterConfigId === parameterConfigId,
    );
    return input === undefined ? null : input.windowSeconds;
  };

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
  const own = state.status === 'ready' ? state.sets.own : null;
  const resolvedAge =
    own === null
      ? null
      : formatAge(t, Math.max(0, Math.floor((now - Date.parse(own.asOf)) / 1000)));

  return (
    <section
      className={`space-y-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900 ${
        state.status === 'ready' && state.stale.length > 0 ? 'opacity-70' : ''
      }`}
      aria-label={label}
      data-testid="wc-point-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</h3>
          {own !== null && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              {t('wqSource.ui.inputsVerdict', {
                set: t(`wqSource.set.${own.set}`),
                verdict: t(`wqSource.verdict.${own.verdict}`),
              })}
            </span>
          )}
          {resolvedAge !== null && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('wqSource.ui.resolvedAt', { age: resolvedAge })}
            </span>
          )}
          {own !== null && (
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

      {state.status === 'loading' && (
        <p role="status" className="text-xs text-gray-500 dark:text-gray-400">
          {t('wqSource.ui.loadingPoint')}
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-xs text-error-700 dark:text-error-300">
          {t('wqSource.ui.outage', { error: state.message })}
        </p>
      )}
      {state.status === 'ready' &&
        state.stale.map((entry) => (
          <p
            key={entry.set}
            role="alert"
            className="text-xs text-warning-700 dark:text-warning-300"
          >
            {staleSetText(t, entry, now)}
          </p>
        ))}

      {state.status === 'ready' && (
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"
          data-testid="wc-point-fields"
        >
          {RESOLVABLE_FIELDS.map((field) => (
            <FieldProvenanceChip key={field} entry={state.composed.fields[field]} now={now} />
          ))}
        </div>
      )}

      {state.status === 'ready' &&
        record !== null &&
        record.inputs !== null &&
        outputs !== null && (
          <>
            <PointChart chartType={chartType} inputs={record.inputs} outputs={outputs} />
            <ResultsPanel outputs={outputs} dosingUnavailable={t('wqSource.dosing.monitoring')} />
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {t('wqSource.defaultLimits')}
            </p>
          </>
        )}
      {state.status === 'ready' && record !== null && record.inputs === null && (
        <p
          className="rounded border border-dashed border-gray-300 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
          data-testid="wc-not-drawn"
        >
          {notDrawnReason(t, state)}
        </p>
      )}

      {sources.error !== null && (
        <p role="alert" className="text-xs text-error-700 dark:text-error-300">
          {t('wqSource.ui.sourcesReadFailed', { error: sources.error.message })}
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
            series={entry.source.sensorId === null ? undefined : series.get(entry.source.sensorId)}
            windowSeconds={windowOf(entry.source.parameterConfigId)}
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
