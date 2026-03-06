/**
 * CalibrationStatusRenderer - Status badges
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const STATUS_MAP: Record<string, { bg: string; text: string; label: string }> = {
  calibrated:   { bg: '#dcfce7', text: '#166534', label: 'Kalibre' },
  due:          { bg: '#fef9c3', text: '#854d0e', label: 'Kalibrasyon Gerekli' },
  overdue:      { bg: '#fee2e2', text: '#991b1b', label: 'Suresi Gecmis' },
  inProgress:   { bg: '#dbeafe', text: '#1e40af', label: 'Devam Ediyor' },
  unknown:      { bg: '#f3f4f6', text: '#6b7280', label: 'Bilinmiyor' },
};

const CalibrationStatusRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const label = config.label ?? 'Kalibrasyon Durumu';
  const statusKey = isEditing ? (config.demoStatus ?? 'calibrated') : String(value ?? 'unknown');
  const status = STATUS_MAP[statusKey] ?? STATUS_MAP.unknown;
  const lastDate = config.lastCalibration ?? '2026-03-01';
  const nextDate = config.nextCalibration ?? '2026-06-01';

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
        <span>Son: {lastDate}</span>
        <span>Sonraki: {nextDate}</span>
      </div>
    </div>
  );
};

CalibrationStatusRenderer.displayName = 'CalibrationStatusRenderer';
export default memo(CalibrationStatusRenderer);
