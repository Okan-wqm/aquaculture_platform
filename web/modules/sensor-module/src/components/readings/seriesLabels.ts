/**
 * The words a series chart uses for what the server says it returned: the
 * bucket width, the store, the zone. Exhaustive records over the generated
 * enums, so a new width or store does not compile without its words.
 */
import { type MessageKey, useI18n } from '@aquaculture/shared-ui';
import type {
  AggregationInterval,
  ChannelSeriesResponse,
  MetricSourceTier,
} from '@platform/shared-ui/generated/graphql-types';

import type { SeriesCsvHeaders } from './readingsModel';

const WIDTH_KEYS: Readonly<Record<AggregationInterval, MessageKey>> = {
  ONE_MINUTE: 'series.width.ONE_MINUTE',
  FIVE_MINUTES: 'series.width.FIVE_MINUTES',
  FIFTEEN_MINUTES: 'series.width.FIFTEEN_MINUTES',
  ONE_HOUR: 'series.width.ONE_HOUR',
  FOUR_HOURS: 'series.width.FOUR_HOURS',
  ONE_DAY: 'series.width.ONE_DAY',
  ONE_WEEK: 'series.width.ONE_WEEK',
};

const STORE_KEYS: Readonly<Record<MetricSourceTier, MessageKey>> = {
  RAW: 'series.store.RAW',
  MINUTE: 'series.store.MINUTE',
  HOUR: 'series.store.HOUR',
  DAY: 'series.store.DAY',
};

export interface SeriesLabels {
  /** "15 minute buckets · minute rollup · Europe/Oslo" */
  resolution: (series: ChannelSeriesResponse) => string;
  csvHeaders: (series: ChannelSeriesResponse) => SeriesCsvHeaders;
}

export function useSeriesLabels(): SeriesLabels {
  const { t } = useI18n();
  return {
    resolution: (series) =>
      t('series.resolution', {
        width: t(WIDTH_KEYS[series.resolution]),
        store: t(STORE_KEYS[series.sourceTier]),
        zone: series.bucketTimeZone,
      }),
    csvHeaders: (series) => ({
      bucketUtc: t('series.csv.bucketUtc'),
      bucketLocal: t('series.csv.bucketLocal', { zone: series.displayTimeZone }),
      channel: t('series.csv.channel'),
      unit: t('series.csv.unit'),
      avg: t('series.csv.avg'),
      min: t('series.csv.min'),
      max: t('series.csv.max'),
      count: t('series.csv.count'),
      badCount: t('series.csv.badCount'),
    }),
  };
}
