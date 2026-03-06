/**
 * AlarmBannerRenderer - Colored alarm banner + severity icon.
 * Uses shared ALARM_SEVERITY_COLORS for consistency.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { ALARM_SEVERITY_COLORS } from '../WidgetRenderer';

const BANNER_STYLES: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  critical: { bg: '#fef2f2', border: ALARM_SEVERITY_COLORS.critical.bg, text: '#991b1b', icon: '!!' },
  high:     { bg: '#fff7ed', border: ALARM_SEVERITY_COLORS.high.bg,     text: '#9a3412', icon: '!' },
  medium:   { bg: '#fffbeb', border: ALARM_SEVERITY_COLORS.medium.bg,   text: '#92400e', icon: '!' },
  warning:  { bg: '#fffbeb', border: ALARM_SEVERITY_COLORS.medium.bg,   text: '#92400e', icon: '!' },
  low:      { bg: '#eff6ff', border: ALARM_SEVERITY_COLORS.low.bg,      text: '#1e40af', icon: 'i' },
  info:     { bg: '#eff6ff', border: ALARM_SEVERITY_COLORS.info.bg,     text: '#1e40af', icon: 'i' },
};

const AlarmBannerRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const severity = isEditing ? (config.demoSeverity ?? 'warning') : String(value ?? 'info');
  const message = config.message ?? (isEditing ? 'pH seviyesi yuksek' : '');
  const colors = BANNER_STYLES[severity.toLowerCase()] ?? BANNER_STYLES.info;

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
          {message || 'Alarm mesaji'}
        </div>
      </div>
    </div>
  );
};

AlarmBannerRenderer.displayName = 'AlarmBannerRenderer';
export default memo(AlarmBannerRenderer);
