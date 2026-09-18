/**
 * AlarmBannerRenderer - Colored alarm banner + severity icon.
 * Uses shared ALARM_SEVERITY_COLORS for consistency.
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { ALARM_SEVERITY_COLORS } from '../WidgetRenderer';
import { colors as themeColors } from '@aquaculture/shared-ui';

const BANNER_STYLES: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  critical: { bg: themeColors.error[50], border: ALARM_SEVERITY_COLORS.critical.bg, text: themeColors.error[700], icon: '!!' },
  high:     { bg: themeColors.warning[50], border: ALARM_SEVERITY_COLORS.high.bg,     text: themeColors.error[700], icon: '!' },
  medium:   { bg: themeColors.warning[50], border: ALARM_SEVERITY_COLORS.medium.bg,   text: themeColors.warning[700], icon: '!' },
  warning:  { bg: themeColors.warning[50], border: ALARM_SEVERITY_COLORS.medium.bg,   text: themeColors.warning[700], icon: '!' },
  low:      { bg: themeColors.info[50], border: ALARM_SEVERITY_COLORS.low.bg,      text: themeColors.primary[600], icon: 'i' },
  info:     { bg: themeColors.info[50], border: ALARM_SEVERITY_COLORS.info.bg,     text: themeColors.primary[600], icon: 'i' },
};

const AlarmBannerRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height, isEditing }) => {
  const severity = isEditing ? String(config.demoSeverity ?? 'warning') : String(value ?? 'info');
  const message = (config.message as string) ?? (isEditing ? 'pH level high' : '');
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
        <div style={{ fontSize: 11, color: themeColors.neutral[700], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {message || 'Alarm message'}
        </div>
      </div>
    </div>
  );
};

AlarmBannerRenderer.displayName = 'AlarmBannerRenderer';
export default memo(AlarmBannerRenderer);
