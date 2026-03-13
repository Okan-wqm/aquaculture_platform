/**
 * CalibrationHistoryRenderer - Table placeholder
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const DEMO_ROWS = [
  { date: '2026-03-01', sensor: 'pH-01', offset: '+0.12', result: 'Success' },
  { date: '2026-02-15', sensor: 'DO-02', offset: '-0.05', result: 'Success' },
  { date: '2026-02-01', sensor: 'pH-01', offset: '+0.08', result: 'Success' },
  { date: '2026-01-15', sensor: 'Temp-03', offset: '+0.3', result: 'Failed' },
];

const CalibrationHistoryRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const label = (config.label ?? 'Calibration History') as string;
  const rows = (isEditing ? DEMO_ROWS : (config.rows ?? DEMO_ROWS)) as typeof DEMO_ROWS;
  const h = height - 16; // inner height after padding
  const headerH = Math.max(22, h * 0.1);
  const rowH = Math.max(18, h * 0.08);
  const colHeaderH = Math.max(18, h * 0.08);
  const visibleCount = Math.max(1, Math.floor((h - headerH - colHeaderH) / rowH));

  const cols = ['Date', 'Sensor', 'Offset', 'Result'];
  const colW = (width - 16) / cols.length;

  return (
    <div style={{ width, height, padding: 8, boxSizing: 'border-box' as const, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ height: headerH, padding: '0 8px', display: 'flex', alignItems: 'center', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: 11, fontWeight: 600, color: '#374151' }}>
        {label}
      </div>

      {/* Column headers */}
      <div style={{ display: 'flex', padding: '0 8px', height: colHeaderH, alignItems: 'center', borderBottom: '1px solid #e5e7eb' }}>
        {cols.map((col) => (
          <div key={col} style={{ width: colW, fontSize: 8, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' }}>
            {col}
          </div>
        ))}
      </div>

      {/* Rows */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {rows.slice(0, visibleCount).map((row: any, i: number) => (
          <div key={i} style={{ display: 'flex', padding: '0 8px', height: rowH, alignItems: 'center', borderBottom: '1px solid #f3f4f6', fontSize: 9 }}>
            <div style={{ width: colW, color: '#6b7280' }}>{row.date}</div>
            <div style={{ width: colW, color: '#374151' }}>{row.sensor}</div>
            <div style={{ width: colW, color: '#374151', fontFamily: 'monospace' }}>{row.offset}</div>
            <div style={{ width: colW, color: row.result === 'Success' ? '#16a34a' : '#dc2626', fontWeight: 500 }}>
              {row.result}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

CalibrationHistoryRenderer.displayName = 'CalibrationHistoryRenderer';
export default memo(CalibrationHistoryRenderer);
