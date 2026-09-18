/**
 * AlarmBannerRenderer - Colored alarm banner + severity icon.
 * Uses shared ALARM_SEVERITY_COLORS for consistency.
 *
 * T9: at RUNTIME the banner reflects the ALARM RUNTIME STORE's active
 * alarms — it previously read the raw tag VALUE as the severity, so a tank
 * level of "7.2" rendered as severity "7.2" (fallback styling) with no
 * message. The banner now shows the worst unacknowledged active alarm's
 * severity and message. Builder edit mode keeps its demo severity.
 */

import React, { memo, useMemo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { ALARM_SEVERITY_COLORS, resolveSeverity } from '../WidgetRenderer';
import { useScadaPackageStore } from '../../../store/scada';
import type { AlarmSeverity } from '../../../types/scada-runtime.types';

// Canonical severity scale only (A5/Plan 2): warning uses the WARNING
// yellow — it previously borrowed the deprecated `medium` orange, rendering
// identical to `high`.
const BANNER_STYLES: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  critical: { bg: '#fef2f2', border: ALARM_SEVERITY_COLORS.critical.bg, text: '#991b1b', icon: '!!' },
  high:     { bg: '#fff7ed', border: ALARM_SEVERITY_COLORS.high.bg,     text: '#9a3412', icon: '!' },
  warning:  { bg: '#fffbeb', border: ALARM_SEVERITY_COLORS.warning.bg,  text: '#92400e', icon: '!' },
  info:     { bg: '#eff6ff', border: ALARM_SEVERITY_COLORS.info.bg,     text: '#1e40af', icon: 'i' },
};

/** Runtime severity precedence (worst first). */
const SEVERITY_PRECEDENCE: AlarmSeverity[] = ['critical', 'high', 'warning', 'info'];

const AlarmBannerRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing }) => {
  // T9: live alarms come from the alarm runtime slice of the unified
  // package store — the single source OperatorShell/AlarmPanel also read.
  const activeAlarms = useScadaPackageStore((s) => s.activeAlarms);

  const worstAlarm = useMemo(() => {
    for (const severity of SEVERITY_PRECEDENCE) {
      const hit = activeAlarms.find((a) => a.severity === severity && a.status !== 'inactive');
      if (hit) return hit;
    }
    return null;
  }, [activeAlarms]);

  const severity = isEditing
    ? resolveSeverity(config.demoSeverity ?? 'warning')
    : (worstAlarm?.severity ?? 'info');
  const message = isEditing
    ? ((config.message as string) ?? 'pH level high')
    : (worstAlarm?.message ?? (config.message as string) ?? '');
  const colors = BANNER_STYLES[severity] ?? BANNER_STYLES.info;

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: 8,
        boxSizing: 'border-box' as const,
        background: colors.bg,
        borderLeft: `4px solid ${colors.border}`,
        borderRadius: 4,
      }}
      role={isEditing ? undefined : 'status'}
      aria-live={isEditing ? undefined : 'polite'}
    >
      {/* Severity icon */}
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: colors.border,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 800,
          color: colors.text,
          flexShrink: 0,
        }}
      >
        {colors.icon}
      </div>
      {/* Message */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 600, color: colors.text, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {severity}
        </div>
        <div style={{ fontSize: 11, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {message || (isEditing ? 'Alarm message' : 'No active alarms')}
        </div>
      </div>
    </div>
  );
};

AlarmBannerRenderer.displayName = 'AlarmBannerRenderer';
export default memo(AlarmBannerRenderer);
