/**
 * CalibrationStatusRenderer - Status badges
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { colors } from '@aquaculture/shared-ui';

const STATUS_MAP: Record<string, { bg: string; text: string; label: string }> = {
  calibrated:   { bg: colors.success[100], text: colors.secondary[800], label: 'Calibrated' },
  due:          { bg: colors.warning[100], text: colors.accent[800], label: 'Calibration Required' },
  overdue:      { bg: colors.error[100], text: colors.error[700], label: 'Overdue' },
  inProgress:   { bg: colors.info[100], text: colors.primary[600], label: 'In Progress' },
  unknown:      { bg: colors.neutral[100], text: colors.gray[400], label: 'Unknown' },
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
      <span style={{ fontSize: 10, color: colors.gray[400], fontWeight: 500 }}>{label}</span>
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
      <div style={{ display: 'flex', gap: 12, fontSize: 9, color: colors.neutral[400] }}>
        <span>Last: {lastDate}</span>
        <span>Next: {nextDate}</span>
      </div>
    </div>
  );
};

CalibrationStatusRenderer.displayName = 'CalibrationStatusRenderer';
export default memo(CalibrationStatusRenderer);
