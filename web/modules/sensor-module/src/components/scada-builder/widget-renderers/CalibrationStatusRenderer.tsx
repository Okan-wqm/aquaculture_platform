/**
 * CalibrationStatusRenderer - Status badges
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const STATUS_MAP: Record<string, { bg: string; text: string; label: string }> = {
  calibrated:   { bg: '#dcfce7', text: '#166534', label: 'Calibrated' },
  due:          { bg: '#fef9c3', text: '#854d0e', label: 'Calibration Required' },
  overdue:      { bg: '#fee2e2', text: '#991b1b', label: 'Overdue' },
  inProgress:   { bg: '#dbeafe', text: '#1e40af', label: 'In Progress' },
  unknown:      { bg: '#f3f4f6', text: '#6b7280', label: 'Unknown' },
};

const CalibrationStatusRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = (config.label ?? 'Calibration Status') as string;
  const statusKey = (isEditing ? (config.demoStatus ?? 'calibrated') : String(value ?? 'unknown')) as string;
  const status = STATUS_MAP[statusKey] ?? STATUS_MAP.unknown;
  const lastDate = (config.lastCalibration ?? '2026-03-01') as string;
  const nextDate = (config.nextCalibration ?? '2026-06-01') as string;

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 8,
        boxSizing: 'border-box' as const,
      }}
    >
      <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 500 }}>{label}</span>
      {/* Status badge */}
      <span
        style={{
          display: 'inline-block',
          padding: '3px 10px',
          borderRadius: 12,
          background: status.bg,
          color: status.text,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {status.label}
      </span>
      {/* Dates */}
      <div style={{ display: 'flex', gap: 12, fontSize: 9, color: '#9ca3af' }}>
        <span>Last: {lastDate}</span>
        <span>Next: {nextDate}</span>
      </div>
    </div>
  );
};

CalibrationStatusRenderer.displayName = 'CalibrationStatusRenderer';
export default memo(CalibrationStatusRenderer);
