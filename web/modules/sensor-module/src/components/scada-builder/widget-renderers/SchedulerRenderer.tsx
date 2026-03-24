import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

interface ScheduleEntry {
  id: string;
  day: number;       // 0=Mon, 6=Sun
  startHour: number; // 0-23
  endHour: number;   // 0-23
  label: string;
  color: string;
  tagName?: string;
  tagValue?: string | number | boolean;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const SchedulerRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  const entries = (config.entries ?? []) as ScheduleEntry[];
  const title = (config.title ?? 'Schedule') as string;
  const showHourLabels = (config.showHourLabels ?? true) as boolean;

  const headerH = 28;
  const dayLabelW = 36;
  const hourLabelH = showHourLabels ? 16 : 0;
  const cellW = (width - dayLabelW) / 24;
  const cellH = (height - headerH - hourLabelH) / 7;

  // Group entries by day for efficient lookup
  const entryMap = useMemo(() => {
    const map = new Map<number, ScheduleEntry[]>();
    for (const e of entries) {
      if (!map.has(e.day)) map.set(e.day, []);
      map.get(e.day)!.push(e);
    }
    return map;
  }, [entries]);

  return (
    <div style={{ width, height, display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif', overflow: 'hidden' }}>
      {/* Title bar */}
      <div style={{
        height: headerH, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0e7490', color: '#fff', fontSize: 11, fontWeight: 600,
        borderRadius: '4px 4px 0 0',
      }}>
        {title}
      </div>

      {/* Grid */}
      <div style={{ flex: 1, position: 'relative', background: '#f8fafc', overflow: 'hidden' }}>
        {/* Hour labels */}
        {showHourLabels && (
          <div style={{ display: 'flex', paddingLeft: dayLabelW, height: hourLabelH }}>
            {HOURS.filter((h) => h % 3 === 0).map((h) => (
              <div key={h} style={{
                position: 'absolute', left: dayLabelW + h * cellW, top: 0,
                fontSize: 8, color: '#9ca3af', width: cellW * 3, textAlign: 'center',
              }}>
                {String(h).padStart(2, '0')}
              </div>
            ))}
          </div>
        )}

        {/* Day rows */}
        {DAYS.map((day, dayIdx) => (
          <div key={day} style={{
            position: 'absolute',
            top: hourLabelH + dayIdx * cellH,
            left: 0, right: 0, height: cellH,
            display: 'flex', borderBottom: '1px solid #e5e7eb',
          }}>
            {/* Day label */}
            <div style={{
              width: dayLabelW, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 600, color: '#374151', background: '#f1f5f9',
              borderRight: '1px solid #e5e7eb',
            }}>
              {day}
            </div>
            {/* Time grid background */}
            <div style={{ flex: 1, position: 'relative' }}>
              {/* Vertical hour lines */}
              {HOURS.filter((h) => h % 6 === 0).map((h) => (
                <div key={h} style={{
                  position: 'absolute', left: h * cellW, top: 0, bottom: 0,
                  width: 1, background: '#e5e7eb',
                }} />
              ))}
              {/* Schedule blocks */}
              {(entryMap.get(dayIdx) ?? []).map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    position: 'absolute',
                    left: entry.startHour * cellW,
                    width: (entry.endHour - entry.startHour) * cellW,
                    top: 2, bottom: 2,
                    background: entry.color || '#3b82f6',
                    borderRadius: 3,
                    opacity: 0.85,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 8, color: '#fff', fontWeight: 500,
                    overflow: 'hidden', whiteSpace: 'nowrap',
                    cursor: isEditing ? 'default' : 'pointer',
                  }}
                  title={`${entry.label} (${entry.startHour}:00-${entry.endHour}:00)`}
                >
                  {cellW * (entry.endHour - entry.startHour) > 30 ? entry.label : ''}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

SchedulerRenderer.displayName = 'SchedulerRenderer';
export default memo(SchedulerRenderer);
