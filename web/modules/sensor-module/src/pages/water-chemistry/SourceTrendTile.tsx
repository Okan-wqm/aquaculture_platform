/**
 * One live source at a point as a tile: the newest value in the parameter's
 * unit at its precision (the backend converts it), and the last 24 h of its
 * channel as a time-scaled trend with gaps, labelled with the channel's own
 * unit. The series is fetched per sensor by the panel (one request however
 * many tiles chart its channels). Selecting the tile opens the full trend.
 */
import {
  ParameterSourceTile,
  sourceKindOf,
  useI18n,
  type ParameterSourceAtPoint,
  type ProblemFix,
  type SourceProblemCode,
  type SourceTrend,
  type TrendPoint,
} from '@aquaculture/shared-ui';
import type { ChannelSeriesResponse } from '@platform/shared-ui/generated/graphql-types';
import type { TimeRangeSpec } from '@aquaculture/shared-contracts';
import { type ReactElement } from 'react';

export const TREND_RANGE: TimeRangeSpec = { kind: 'relative', preset: '24h' };
export const TREND_REFRESH_MS = 60_000;

/** A channel's buckets by time, a null where the series reports a gap; null when the channel is absent. */
export function trendOf(
  series: ChannelSeriesResponse | undefined,
  channelKey: string,
): SourceTrend | null {
  if (series === undefined) return null;
  const channel = series.channels.find((line) => line.channelKey === channelKey);
  if (channel === undefined) return null;
  const points: TrendPoint[] = [
    ...channel.points.map((point) => ({ t: Date.parse(point.bucket), v: point.avg })),
    ...channel.gaps.map((gap) => ({ t: Date.parse(gap.start), v: null })),
  ].sort((a, b) => a.t - b.t);
  const unit = channel.unitSymbol ?? channel.unit;
  return {
    points,
    start: Date.parse(series.startTime),
    end: Date.parse(series.endTime),
    unit: unit === undefined ? null : unit,
  };
}

export function SourceTrendTile({
  entry,
  series,
  windowSeconds,
  now,
  selected,
  onSelect,
  onFix,
}: {
  entry: ParameterSourceAtPoint;
  /** The series of the source's sensor (narrowed to the channels charted here). */
  series: ChannelSeriesResponse | undefined;
  /** The input window of the parameter at this point (null: not a calculation input here). */
  windowSeconds: number | null;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onFix: (code: SourceProblemCode, fix: ProblemFix) => void;
}): ReactElement {
  const { t } = useI18n();
  const { source, channel, problems } = entry;
  const detail =
    source.channelKey === null
      ? t('wqSource.ui.manualPlan')
      : `${source.channelKey} · ${t('wqSource.ui.positionAt', {
          position: t(`wqSource.ui.position.${source.position}`),
        })}`;
  return (
    <ParameterSourceTile
      name={source.parameterConfig.name}
      value={entry.latestValue}
      unit={entry.unit}
      precision={source.parameterConfig.precision}
      observedAt={channel === null ? null : channel.latestAt}
      now={now}
      windowSeconds={windowSeconds}
      quality={channel === null ? null : channel.latestQuality}
      kind={sourceKindOf(source)}
      // A source at a point stands there: inheritance shows in the field chips.
      inheritedFrom={null}
      detail={detail}
      trend={source.channelKey === null ? null : trendOf(series, source.channelKey)}
      color={source.parameterConfig.chartColor}
      problems={problems}
      onFix={onFix}
      onSelect={source.channelKey === null ? undefined : onSelect}
      selected={selected}
    />
  );
}
