/**
 * Area Chart Widget Content
 *
 * Filled area chart for trend visualization with emphasis.
 */

import React, { useState, useEffect } from 'react';
import {
  AreaChart,
  Area,
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

interface AreaChartWidgetContentProps {
  config: WidgetConfig;
}

// Color palette for multiple sensors
const COLORS = ['#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];

// Gradient IDs for each color
const getGradientId = (index: number, configId: string) => `gradient-area-${configId}-${index}`;

export const AreaChartWidgetContent: React.FC<AreaChartWidgetContentProps> = ({
  config,
}) => {
  const { data, history, loading, error } = useWidgetData(config);
  const [, forceUpdate] = useState(0);

  // Update time display every second
  useEffect(() => {
    const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        {error}
      </div>
    );
  }

  // Group by timestamp for multi-sensor charts
  // Bug #3 fix: Add null/undefined validation for data points
  const groupedData: Record<string, any> = {};
  history?.forEach((point) => {
    // Validate data point before processing
    if (!point.sensorName || point.value === undefined || Number.isNaN(point.value)) {
      return; // Skip invalid data points
    }

    const timeKey = new Date(point.timestamp).toISOString();
    if (!groupedData[timeKey]) {
      groupedData[timeKey] = {
        time: new Date(point.timestamp).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        timestamp: point.timestamp,
      };
    }
    groupedData[timeKey][point.sensorName] = point.value;
  });

  const finalChartData = Object.values(groupedData).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Get unique sensor names (filter out undefined/null)
  const sensorNames = [...new Set(
    history?.filter((h) => h.sensorName).map((h) => h.sensorName) || []
  )];

  if (finalChartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
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
          <AreaChart
            data={finalChartData}
            margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
          >
            {/* Define gradients for each area */}
            <defs>
              {sensorNames.map((_, index) => (
                <linearGradient
                  key={getGradientId(index, config.id)}
                  id={getGradientId(index, config.id)}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor={COLORS[index % COLORS.length]}
                    stopOpacity={0.4}
                  />
                  <stop
                    offset="95%"
                    stopColor={COLORS[index % COLORS.length]}
                    stopOpacity={0.05}
                  />
                </linearGradient>
              ))}
            </defs>

            {config.settings?.showGrid !== false && (
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            )}
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: '#6B7280' }}
              tickLine={{ stroke: '#E5E7EB' }}
              axisLine={{ stroke: '#E5E7EB' }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#6B7280' }}
              tickLine={{ stroke: '#E5E7EB' }}
              axisLine={{ stroke: '#E5E7EB' }}
              width={yAxisConfig?.label ? 60 : 40}
              domain={yAxisDomain}
              label={
                yAxisConfig?.label
                  ? {
                      value: yAxisConfig.label,
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 10, fill: '#6B7280' },
                    }
                  : undefined
              }
              tickCount={yAxisConfig?.tickCount || 5}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'white',
                border: '1px solid #E5E7EB',
                borderRadius: '8px',
                fontSize: '12px',
              }}
              labelStyle={{ color: '#374151', fontWeight: 'bold' }}
            />
            {config.settings?.showLegend !== false && sensorNames.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: '10px' }}
                iconType="circle"
                iconSize={8}
              />
            )}
            {sensorNames.map((name, index) => (
              <Area
                key={name}
                type="monotone"
                dataKey={name}
                stroke={COLORS[index % COLORS.length]}
                strokeWidth={2}
                fill={`url(#${getGradientId(index, config.id)})`}
                activeDot={{ r: 4 }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* Last update time */}
      {latestTimestamp && (
        <div className="flex items-center justify-center gap-1 text-xs text-gray-400 pt-1 border-t border-gray-100">
          <Clock size={10} />
          <span>Last update: {formatTimeSince(latestTimestamp)}</span>
        </div>
      )}
    </div>
  );
};

export default AreaChartWidgetContent;
