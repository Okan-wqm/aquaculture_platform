/**
 * Gauge Widget Component
 * Displays sensor value as a circular gauge with min/max/warning/critical zones
 */

import React, { useMemo } from 'react';
import { SensorReading, SensorStatus } from '../../../store/scadaStore';

interface GaugeWidgetProps {
  reading: SensorReading;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

const sizeConfig = {
  sm: { width: 80, height: 80, strokeWidth: 6, fontSize: 12, labelSize: 8 },
  md: { width: 120, height: 120, strokeWidth: 8, fontSize: 16, labelSize: 10 },
  lg: { width: 160, height: 160, strokeWidth: 10, fontSize: 20, labelSize: 12 },
};

const statusColors: Record<SensorStatus, { stroke: string; fill: string }> = {
  normal: { stroke: '#22c55e', fill: '#dcfce7' },
  warning: { stroke: '#eab308', fill: '#fef9c3' },
  critical: { stroke: '#ef4444', fill: '#fee2e2' },
  offline: { stroke: '#6b7280', fill: '#f3f4f6' },
};

export const GaugeWidget: React.FC<GaugeWidgetProps> = ({
  reading,
  size = 'md',
  showLabel = true,
  className = '',
}) => {
  const config = sizeConfig[size];
  const centerX = config.width / 2;
  const centerY = config.height / 2;
  const radius = (config.width - config.strokeWidth) / 2 - 5;

  // Calculate arc parameters (270 degree arc, starting from bottom-left)
  const startAngle = 135;
  const endAngle = 405;
  const totalAngle = endAngle - startAngle;

  // Calculate value percentage and angle
  const { value, minValue, maxValue, status, unit } = reading;
  const percentage = Math.max(0, Math.min(1, (value - minValue) / (maxValue - minValue)));
  const valueAngle = startAngle + percentage * totalAngle;

  // Convert angle to radians and calculate arc points
  const toRadians = (angle: number) => (angle * Math.PI) / 180;

  const getPointOnArc = (angle: number) => ({
    x: centerX + radius * Math.cos(toRadians(angle)),
    y: centerY + radius * Math.sin(toRadians(angle)),
  });

  // Create arc path
  const createArcPath = (startA: number, endA: number) => {
    const start = getPointOnArc(startA);
    const end = getPointOnArc(endA);
    const largeArcFlag = endA - startA > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
  };

  // Calculate zone angles
  const zones = useMemo(() => {
    const zoneList: { start: number; end: number; color: string }[] = [];
    const range = maxValue - minValue;

    // Critical low zone
    if (reading.criticalLow !== undefined) {
      const criticalLowPct = (reading.criticalLow - minValue) / range;
      zoneList.push({
        start: startAngle,
        end: startAngle + criticalLowPct * totalAngle,
        color: '#fecaca',
      });
    }

    // Warning low zone
    if (reading.warningLow !== undefined) {
      const warningLowPct = (reading.warningLow - minValue) / range;
      const startPct = reading.criticalLow !== undefined ? (reading.criticalLow - minValue) / range : 0;
      zoneList.push({
        start: startAngle + startPct * totalAngle,
        end: startAngle + warningLowPct * totalAngle,
        color: '#fef08a',
      });
    }

    // Normal zone
    const normalStart = reading.warningLow !== undefined ? (reading.warningLow - minValue) / range : 0;
    const normalEnd = reading.warningHigh !== undefined ? (reading.warningHigh - minValue) / range : 1;
    zoneList.push({
      start: startAngle + normalStart * totalAngle,
      end: startAngle + normalEnd * totalAngle,
      color: '#bbf7d0',
    });

    // Warning high zone
    if (reading.warningHigh !== undefined) {
      const warningHighPct = (reading.warningHigh - minValue) / range;
      const endPct = reading.criticalHigh !== undefined ? (reading.criticalHigh - minValue) / range : 1;
      zoneList.push({
        start: startAngle + warningHighPct * totalAngle,
        end: startAngle + endPct * totalAngle,
        color: '#fef08a',
      });
    }

    // Critical high zone
    if (reading.criticalHigh !== undefined) {
      const criticalHighPct = (reading.criticalHigh - minValue) / range;
      zoneList.push({
        start: startAngle + criticalHighPct * totalAngle,
        end: endAngle,
        color: '#fecaca',
      });
    }

    return zoneList;
  }, [reading, minValue, maxValue, startAngle, totalAngle, endAngle]);

  const colors = statusColors[status];

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <svg width={config.width} height={config.height} viewBox={`0 0 ${config.width} ${config.height}`}>
        {/* Zone arcs (background) */}
        {zones.map((zone, index) => (
          <path
            key={index}
            d={createArcPath(zone.start, zone.end)}
            fill="none"
            stroke={zone.color}
            strokeWidth={config.strokeWidth + 4}
            strokeLinecap="round"
          />
        ))}

        {/* Background arc */}
        <path
          d={createArcPath(startAngle, endAngle)}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
        />

        {/* Value arc */}
        <path
          d={createArcPath(startAngle, valueAngle)}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
          className="transition-all duration-500"
        />

        {/* Needle indicator */}
        <circle
          cx={getPointOnArc(valueAngle).x}
          cy={getPointOnArc(valueAngle).y}
          r={config.strokeWidth / 2 + 2}
          fill={colors.stroke}
          stroke="white"
          strokeWidth={2}
        />

        {/* Center value display */}
        <text
          x={centerX}
          y={centerY}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={config.fontSize}
          fontWeight="bold"
          fill="#1f2937"
        >
          {value.toFixed(1)}
        </text>

        {/* Unit display */}
        <text
          x={centerX}
          y={centerY + config.fontSize}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={config.labelSize}
          fill="#6b7280"
        >
          {unit}
        </text>

        {/* Min/Max labels */}
        <text
          x={getPointOnArc(startAngle).x - 5}
          y={getPointOnArc(startAngle).y + 12}
          textAnchor="end"
          fontSize={config.labelSize - 2}
          fill="#9ca3af"
        >
          {minValue}
        </text>
        <text
          x={getPointOnArc(endAngle).x + 5}
          y={getPointOnArc(endAngle).y + 12}
          textAnchor="start"
          fontSize={config.labelSize - 2}
          fill="#9ca3af"
        >
          {maxValue}
        </text>
      </svg>

      {showLabel && (
        <div className="text-center mt-1">
          <span
            className={`text-xs font-medium capitalize px-2 py-0.5 rounded-full ${
              status === 'normal'
                ? 'bg-green-100 text-green-700'
                : status === 'warning'
                ? 'bg-yellow-100 text-yellow-700'
                : status === 'critical'
                ? 'bg-red-100 text-red-700'
                : 'bg-gray-100 text-gray-700'
            }`}
          >
            {reading.type.replace('_', ' ')}
          </span>
        </div>
      )}
    </div>
  );
};

export default GaugeWidget;
