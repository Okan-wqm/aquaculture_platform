/**
 * AlarmBannerRenderer - Colored alarm banner + severity icon
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const SEVERITY_COLORS: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  critical: { bg: '#fef2f2', border: '#fca5a5', text: '#991b1b', icon: '!!' },
  warning:  { bg: '#fffbeb', border: '#fcd34d', text: '#92400e', icon: '!' },
  info:     { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af', icon: 'i' },
};

const AlarmBannerRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const severity = isEditing ? (config.demoSeverity ?? 'warning') : String(value ?? 'info');
  const message = config.message ?? (isEditing ? 'pH seviyesi yuksek' : '');
  const colors = SEVERITY_COLORS[severity.toLowerCase()] ?? SEVERITY_COLORS.info;

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 12px',
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
