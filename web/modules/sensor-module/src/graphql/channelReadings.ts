/**
 * Channel-generic reading documents (SENSOR-HIGH-138).
 *
 * Keyed by the sensor's own sensor_data_channels rows, so every configured
 * parameter — not only the nine-parameter SensorReadings vocabulary — has a
 * last value and a history. The documents are validated against the composed
 * supergraph by scripts/ci/validate-graphql-operations.mjs and against the
 * sensor-subgraph excerpt by src/__tests__/graphql-contract.spec.ts; the
 * result types are the codegen output of that same schema, so the shapes
 * cannot drift from the backend.
 */
import type {
  ChannelAlertLevel,
  ChannelDataBounds,
  ChannelLatestValue,
  ChannelSeries,
  ChannelSeriesPoint,
  ChannelSeriesResponse,
  SeriesDisplayTimeZone,
} from '@platform/shared-ui/generated/graphql-types';

export type {
  ChannelAlertLevel,
  ChannelDataBounds,
  ChannelLatestValue,
  ChannelSeries,
  ChannelSeriesPoint,
  ChannelSeriesResponse,
  SeriesDisplayTimeZone,
};

export interface ChannelLatestValuesResult {
  channelLatestValues: ChannelLatestValue[];
}

export interface ChannelSeriesResult {
  channelSeries: ChannelSeriesResponse;
}

export const CHANNEL_LATEST_VALUES_QUERY = `
  query ChannelLatestValues($sensorIds: [ID!]!) {
    channelLatestValues(sensorIds: $sensorIds) {
      sensorId
      channelId
      channelKey
      displayLabel
      unit
      unitSymbol
      displayOrder
      precision
      value
      time
      qualityCode
      alertLevel
    }
  }
`;

export const CHANNEL_SERIES_QUERY = `
  query ChannelSeries($sensorId: ID!, $startTime: DateTime!, $endTime: DateTime!) {
    channelSeries(sensorId: $sensorId, startTime: $startTime, endTime: $endTime) {
      sensorId
      resolution
      sourceTier
      bucketTimeZone
      displayTimeZone
      displayTimeZoneSource
      startTime
      endTime
      channels {
        channelId
        channelKey
        displayLabel
        unit
        unitSymbol
        precision
        enabled
        points {
          bucket
          avg
          min
          max
          count
          badCount
        }
        gaps {
          start
          end
        }
      }
    }
  }
`;

export interface SeriesDisplayTimeZoneResult {
  seriesDisplayTimeZone: SeriesDisplayTimeZone;
}

/** The one zone a page of these sensors' charts is shown and picked in (server rule). */
export const SERIES_DISPLAY_TIME_ZONE_QUERY = `
  query SeriesDisplayTimeZone($sensorIds: [ID!]!) {
    seriesDisplayTimeZone(sensorIds: $sensorIds) {
      displayTimeZone
      source
    }
  }
`;

export interface ChannelDataBoundsResult {
  channelDataBounds: ChannelDataBounds[];
}

/** First and last stored sample per channel — where to jump when a range is empty. */
export const CHANNEL_DATA_BOUNDS_QUERY = `
  query ChannelDataBounds($sensorIds: [ID!]!) {
    channelDataBounds(sensorIds: $sensorIds) {
      sensorId
      channelId
      firstSampleAt
      lastSampleAt
    }
  }
`;
