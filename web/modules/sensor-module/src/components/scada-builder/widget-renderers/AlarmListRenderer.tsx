/**
 * AlarmListRenderer - Alarm rows list placeholder.
 * Uses shared ALARM_SEVERITY_COLORS for consistency.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { ALARM_SEVERITY_COLORS } from '../WidgetRenderer';

const DEMO_ALARMS = [
  { time: '14:32', severity: 'critical', msg: 'pH > 8.5' },
  { time: '14:28', severity: 'warning', msg: 'DO low' },
  { time: '14:15', severity: 'info', msg: 'Pump started' },
  { time: '13:55', severity: 'warning', msg: 'Temperature high' },
  { time: '13:40', severity: 'critical', msg: 'Tank level alarm' },
];

const SEV_COLOR_MAP: Record<string, string> = {
  critical: ALARM_SEVERITY_COLORS.critical.bg,
  high:     ALARM_SEVERITY_COLORS.high.bg,
  medium:   ALARM_SEVERITY_COLORS.medium.bg,
  warning:  ALARM_SEVERITY_COLORS.medium.bg,
  low:      ALARM_SEVERITY_COLORS.low.bg,
  info:     ALARM_SEVERITY_COLORS.info.bg,
};

const AlarmListRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const label = (config.label ?? 'Alarm List') as string;
  const alarms = (isEditing ? DEMO_ALARMS : (config.alarms ?? DEMO_ALARMS)) as typeof DEMO_ALARMS;
  const h = height - 16; // inner height after padding
  const rowH = Math.max(18, h * 0.08);
  const headerH = Math.max(22, h * 0.1);
  const visibleCount = Math.max(1, Math.floor((h - headerH) / rowH));

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' as const, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          height: headerH,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          background: '#f8fafc',
          borderBottom: '1px solid #e2e8f0',
          fontSize: 11,
          fontWeight: 600,
          color: '#374151',
        }}
      >
        {label}
        <span style={{ marginLeft: 'auto', fontSize: 9, color: '#9ca3af' }}>
          {alarms.length} alarm
        </span>
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {alarms.slice(0, visibleCount).map((alarm: any, i: number) => (
          <div
            key={i}
            style={{
              height: rowH,
              display: 'flex',
              alignItems: 'center',
              padding: '0 8px',
              gap: 6,
              borderBottom: '1px solid #f3f4f6',
              fontSize: 10,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: SEV_COLOR_MAP[alarm.severity] ?? '#9ca3af',
                flexShrink: 0,
              }}
            />
            <span style={{ color: '#9ca3af', fontSize: 9, flexShrink: 0 }}>{alarm.time}</span>
            <span style={{ color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {alarm.msg}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

AlarmListRenderer.displayName = 'AlarmListRenderer';
export default memo(AlarmListRenderer);
