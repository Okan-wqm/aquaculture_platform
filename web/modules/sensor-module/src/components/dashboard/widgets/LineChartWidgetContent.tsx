/**
 * Line Chart Widget Content
 *
 * Time series line chart for historical sensor data.
 */

import React, { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Clock } from 'lucide-react';

// Format time since last reading
// Bug #5 fix: Handle both Date objects and ISO strings
function formatTimeSince(dateInput: Date | string): string {
  const now = new Date();
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;

  // Check for invalid date
  if (isNaN(date.getTime())) {
    return 'Unknown';
  }

  const diff = now.getTime() - date.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s ago`;
  return `${seconds}s ago`;
}
import { WidgetConfig } from '../types';
import { useWidgetData } from '../../../hooks/useWidgetData';
import { downsampleChartData, MAX_CHART_POINTS } from '../../../utils/downsample';
import { colors, colors as themeColors, Spinner } from '@aquaculture/shared-ui';

interface LineChartWidgetContentProps {
  config: WidgetConfig;
}

// Color palette for multiple sensors
const COLORS = [colors.primary[400], colors.success[500], colors.warning[500], colors.error[500], colors.primary[700], colors.accent[500]];

// PERF-004: isolated timer — only this leaf re-renders every second
const TimeSinceUpdate: React.FC<{ timestamp: Date | null }> = ({ timestamp }) => {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!timestamp) return null;
  const diffSec = Math.floor((Date.now() - timestamp.getTime()) / 1000);
  const label = diffSec < 60 ? `${diffSec}s ago` : `${Math.floor(diffSec / 60)}m ago`;
  return <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>;
};

export const LineChartWidgetContent: React.FC<LineChartWidgetContentProps> = ({
  config,
}) => {
  const { data, history, loading, error } = useWidgetData(config);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
        {error}
      </div>
    );
  }

  // Transform history data for Recharts
  // Bug #3 fix: Filter out invalid data points
  const chartData = history?.filter((point) =>
    point.sensorName && point.value !== undefined && !Number.isNaN(point.value)
  ).map((point) => ({
    time: new Date(point.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    timestamp: point.timestamp,
    [point.sensorName]: point.value,
  })) || [];

  // Group by timestamp for multi-sensor charts
  // PERF-010: round to nearest minute bucket so readings from different sensors that differ
  // by a few milliseconds are merged into the same chart data point instead of creating
  // a sparse multi-line chart with many gaps.
  const BUCKET_MS = 60 * 1000; // 1-minute bucket
  const groupedData: Record<string, any> = {};
  history?.forEach((point) => {
    // Validate data point before processing
    if (!point.sensorName || point.value === undefined || Number.isNaN(point.value)) {
      return;
    }

    const ts = new Date(point.timestamp);
    const bucketTs = new Date(Math.round(ts.getTime() / BUCKET_MS) * BUCKET_MS);
    const timeKey = bucketTs.toISOString();
    if (!groupedData[timeKey]) {
      groupedData[timeKey] = {
        time: bucketTs.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        timestamp: bucketTs,
      };
    }
    groupedData[timeKey][point.sensorName] = point.value;
  });

  const sortedChartData = Object.values(groupedData).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // PERF-RISK-002: Downsample to prevent SVG DOM explosion with large datasets
  // (e.g. 30-day @ 1-min aggregate = ~43,200 points). Display-only -- original data preserved.
  const finalChartData = downsampleChartData(sortedChartData, MAX_CHART_POINTS);

  // Get unique sensor names (filter out undefined/null)
  const sensorNames = [...new Set(
    history?.filter((h) => h.sensorName).map((h) => h.sensorName) || []
  )];

  if (finalChartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
        No historical data
      </div>
    );
  }

  // Y-axis configuration
  const yAxisConfig = config.settings?.yAxis;
  const yAxisDomain: [number | 'auto' | 'dataMin', number | 'auto' | 'dataMax'] = [
    yAxisConfig?.min !== undefined ? yAxisConfig.min : 'auto',
    yAxisConfig?.max !== undefined ? yAxisConfig.max : 'auto',
  ];

  // Get latest timestamp from history
  const latestTimestamp = history && history.length > 0
    ? new Date(Math.max(...history.map(h => new Date(h.timestamp).getTime())))
    : null;

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={finalChartData}
            margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
          >
            {config.settings?.showGrid !== false && (
              <CartesianGrid strokeDasharray="3 3" stroke={colors.neutral[200]} />
            )}
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: colors.gray[400] }}
              tickLine={{ stroke: colors.neutral[200] }}
              axisLine={{ stroke: colors.neutral[200] }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: colors.gray[400] }}
              tickLine={{ stroke: colors.neutral[200] }}
              axisLine={{ stroke: colors.neutral[200] }}
              width={yAxisConfig?.label ? 60 : 40}
              domain={yAxisDomain}
              label={
                yAxisConfig?.label
                  ? {
                      value: yAxisConfig.label,
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 10, fill: colors.gray[400] },
                    }
                  : undefined
              }
              tickCount={yAxisConfig?.tickCount || 5}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'white',
                border: `1px solid ${themeColors.neutral[200]}`,
                borderRadius: '8px',
                fontSize: '12px',
              }}
              labelStyle={{ color: colors.neutral[700], fontWeight: 'bold' }}
            />
            {config.settings?.showLegend !== false && sensorNames.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: '10px' }}
                iconType="circle"
                iconSize={8}
              />
            )}
            {sensorNames.map((name, index) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                stroke={COLORS[index % COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {/* Last update time — only TimeSinceUpdate re-renders every second (PERF-004) */}
      {latestTimestamp && (
        <div className="flex items-center justify-center gap-1 text-xs text-gray-500 dark:text-gray-400 pt-1 border-t border-gray-100 dark:border-gray-700">
          <Clock size={10} />
          <span>Last update: </span>
          <TimeSinceUpdate timestamp={latestTimestamp} />
        </div>
      )}
    </div>
  );
};

export default LineChartWidgetContent;
