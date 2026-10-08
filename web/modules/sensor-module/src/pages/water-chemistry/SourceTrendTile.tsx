/**
 * One live source at a point as a tile, with the last 24 h of its channel as
 * a sparkline (channelSeries narrowed to that channel, refreshed every
 * minute). Selecting the tile opens the channel's full trend card.
 */
import type { TimeRangeSpec } from '@aquaculture/shared-contracts';
import {
  ParameterSourceTile,
  sourceKindOf,
  type ParameterSourceAtPoint,
  type ProblemFix,
  type SourceProblemCode,
} from '@aquaculture/shared-ui';
import { type ReactElement, useMemo } from 'react';

import { useChannelSeries } from '../../hooks/useChannelReadings';

export const TREND_RANGE: TimeRangeSpec = { kind: 'relative', preset: '24h' };
export const TREND_REFRESH_MS = 60_000;

export function SourceTrendTile({
  entry,
  now,
  selected,
  onSelect,
  onFix,
}: {
  entry: ParameterSourceAtPoint;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onFix: (code: SourceProblemCode, fix: ProblemFix) => void;
}): ReactElement {
  const { source, channel, problems } = entry;
  const channelKeys = useMemo(
    () => (source.channelKey === null ? null : [source.channelKey]),
    [source.channelKey],
  );
  const series = useChannelSeries(
    source.channelKey === null ? null : source.sensorId,
    TREND_RANGE,
    TREND_REFRESH_MS,
    channelKeys,
  );
  const trend = useMemo((): number[] | null => {
    if (series.series === null) return null;
    const own = series.series.channels.find((line) => line.channelKey === source.channelKey);
    if (own === undefined) return null;
    return own.points.map((point) => point.avg);
  }, [series.series, source.channelKey]);

  return (
    <ParameterSourceTile
      name={source.parameterConfig.name}
      value={channel === null ? null : channel.latestValue}
      unit={channel === null ? source.parameterConfig.unit : channel.unit}
      precision={source.parameterConfig.precision}
      observedAt={channel === null ? null : channel.latestAt}
      now={now}
      windowSeconds={null}
      quality={channel === null ? null : channel.latestQuality}
      kind={sourceKindOf(source)}
      inheritedFrom={null}
      detail={
        source.channelKey === null
          ? 'In the manual entry plan'
          : `${source.channelKey} · ${source.position.toLowerCase()}`
      }
      trend={trend}
      color={source.parameterConfig.chartColor}
      problems={problems}
      onFix={onFix}
      onSelect={source.channelKey === null ? undefined : onSelect}
      selected={selected}
    />
  );
}
