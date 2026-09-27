/**
 * Aggregated-readings document + bucket mapper (extracted from
 * useWidgetData so data hooks can import it without pulling the component
 * graph — react-router-dom et al.).
 */
export const GET_AGGREGATED_READINGS_QUERY = `
  query GetAggregatedReadings($sensorId: ID!, $startTime: DateTime!, $endTime: DateTime!, $interval: AggregationInterval) {
    aggregatedReadings(sensorId: $sensorId, startTime: $startTime, endTime: $endTime, interval: $interval) {
      sensorId
      sensorName
      interval
      startTime
      endTime
      totalDataPoints
      data {
        bucket
        count
        avgTemperature
        minTemperature
        maxTemperature
        avgPh
        minPh
        maxPh
        avgDissolvedOxygen
        minDissolvedOxygen
        maxDissolvedOxygen
        avgSalinity
        minSalinity
        maxSalinity
        avgAmmonia
        avgNitrite
        avgNitrate
        avgTurbidity
        avgWaterLevel
      }
    }
  }
`;

interface AggregatedDataPoint {
  bucket: string;
  count: number;
  avgTemperature?: number;
  minTemperature?: number;
  maxTemperature?: number;
  avgPh?: number;
  minPh?: number;
  maxPh?: number;
  avgDissolvedOxygen?: number;
  minDissolvedOxygen?: number;
  maxDissolvedOxygen?: number;
  avgSalinity?: number;
  avgAmmonia?: number;
  avgNitrite?: number;
  avgNitrate?: number;
  avgTurbidity?: number;
  avgWaterLevel?: number;
}

function extractAggregatedValueByChannelKey(
  dataPoint: AggregatedDataPoint,
  channelKey: string,
): number | null {
  const fieldName = CHANNEL_KEY_TO_AGGREGATED_FIELD[channelKey];
  if (fieldName) {
    const value = dataPoint[fieldName];
    if (value !== undefined && value !== null) {
      return value as number;
    }
  }

  // Try direct match with readings field name pattern
  const avgKey =
    `avg${channelKey.charAt(0).toUpperCase()}${channelKey.slice(1)}` as keyof AggregatedDataPoint;
  const value = dataPoint[avgKey];
  if (value !== undefined && value !== null) {
    return value as number;
  }

  return null;
}

export { extractAggregatedValueByChannelKey };

const CHANNEL_KEY_TO_AGGREGATED_FIELD: Record<string, keyof AggregatedDataPoint> = {
  temperature: 'avgTemperature',
  ph: 'avgPh',
  dissolvedOxygen: 'avgDissolvedOxygen',
  dissolved_oxygen: 'avgDissolvedOxygen',
  salinity: 'avgSalinity',
  ammonia: 'avgAmmonia',
  nitrite: 'avgNitrite',
  nitrate: 'avgNitrate',
  turbidity: 'avgTurbidity',
  waterLevel: 'avgWaterLevel',
  water_level: 'avgWaterLevel',
};
export type { AggregatedDataPoint };
