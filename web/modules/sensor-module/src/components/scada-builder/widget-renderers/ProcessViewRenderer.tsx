/**
 * ProcessViewRenderer - "Process View" placeholder frame
 */

import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';
import { colors, colors as themeColors } from '@aquaculture/shared-ui';

const ProcessViewRenderer: React.FC<WidgetRendererProps> = ({ config, width, height }) => {
  const label = (config.label ?? 'Process View') as string;
  const processName = (config.processName ?? 'RAS-01') as string;

  return (
    <div
      style={{
        width,
        height,
        padding: 8,
        boxSizing: 'border-box' as const,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          height: Math.max(24, (height - 16) * 0.08),
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          background: colors.info[50],
          borderBottom: `1px solid ${themeColors.primary[100]}`,
          fontSize: 11,
          fontWeight: 600,
          color: colors.primary[700],
          gap: 6,
        }}
      >
        <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
          <rect x={1} y={1} width={5} height={5} rx={1} fill={colors.primary[400]} />
          <rect x={8} y={1} width={5} height={5} rx={1} fill={colors.primary[400]} opacity={0.6} />
          <rect x={1} y={8} width={5} height={5} rx={1} fill={colors.primary[400]} opacity={0.6} />
          <rect x={8} y={8} width={5} height={5} rx={1} fill={colors.primary[400]} opacity={0.3} />
        </svg>
        {label}
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: colors.neutral[50],
          gap: 8,
        }}
      >
        {/* Process diagram placeholder */}
        <svg
          width="100%"
          height={Math.min((height - 16) * 0.4, 80)}
          viewBox="0 0 200 80"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Tanks */}
          <rect
            x={10}
            y={20}
            width={40}
            height={50}
            rx={4}
            fill={colors.primary[100]}
            stroke={colors.info[500]}
            strokeWidth={1.5}
          />
          <rect
            x={80}
            y={10}
            width={40}
            height={60}
            rx={4}
            fill={colors.secondary[100]}
            stroke={colors.success[500]}
            strokeWidth={1.5}
          />
          <rect
            x={150}
            y={25}
            width={40}
            height={45}
            rx={4}
            fill={colors.primary[100]}
            stroke={colors.info[500]}
            strokeWidth={1.5}
          />
          {/* Pipes */}
          <line x1={50} y1={45} x2={80} y2={40} stroke={colors.neutral[400]} strokeWidth={2} />
          <line x1={120} y1={40} x2={150} y2={47} stroke={colors.neutral[400]} strokeWidth={2} />
          {/* Flow arrows */}
          <polygon points="75,38 80,40 75,42" fill={colors.neutral[400]} />
          <polygon points="145,45 150,47 145,49" fill={colors.neutral[400]} />
        </svg>

        <span style={{ fontSize: 12, fontWeight: 600, color: colors.primary[700] }}>
          {processName}
        </span>
        <span style={{ fontSize: 9, color: colors.neutral[400] }}>Process diagram view</span>
      </div>
    </div>
  );
};

ProcessViewRenderer.displayName = 'ProcessViewRenderer';
export default memo(ProcessViewRenderer);
