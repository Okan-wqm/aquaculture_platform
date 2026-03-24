import React, { memo } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const PipeFlowRenderer: React.FC<WidgetRendererProps> = ({ config, value, width, height }) => {
  const pipeColor = (config.pipeColor ?? '#6b7280') as string;
  const flowColor = (config.flowColor ?? '#3b82f6') as string;
  const pipeWidth = (config.pipeWidth ?? 12) as number;
  const flowWidth = (config.flowWidth ?? 4) as number;
  const dashLength = (config.dashLength ?? 8) as number;
  const dashGap = (config.dashGap ?? 4) as number;
  const direction = (config.direction ?? 'horizontal') as 'horizontal' | 'vertical';
  const flowDir = (config.flowDirection ?? 'forward') as 'forward' | 'reverse';
  const flowSpeed = (config.flowSpeed ?? 0.6) as number;

  const isActive = Boolean(value);
  const isHorizontal = direction === 'horizontal';

  const x1 = isHorizontal ? 0 : width / 2;
  const y1 = isHorizontal ? height / 2 : 0;
  const x2 = isHorizontal ? width : width / 2;
  const y2 = isHorizontal ? height / 2 : height;

  const flowClass = isActive
    ? (flowDir === 'reverse' ? 'scada-pipe-flowing-rev' : 'scada-pipe-flowing')
    : '';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {/* Pipe border (outer) */}
      <line x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={pipeColor} strokeWidth={pipeWidth} strokeLinecap="round" />
      {/* Pipe fill (inner) */}
      <line x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={isActive ? flowColor : '#d1d5db'}
        strokeWidth={pipeWidth - 4} strokeLinecap="round" />
      {/* Flow indicator (animated dashes) */}
      {isActive && (
        <line x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="#ffffff" strokeWidth={flowWidth}
          strokeDasharray={`${dashLength} ${dashGap}`}
          strokeLinecap="round"
          className={flowClass}
          style={{ '--scada-flow-speed': `${flowSpeed}s` } as React.CSSProperties} />
      )}
      {/* End caps */}
      <circle cx={x1} cy={y1} r={pipeWidth / 2 - 1} fill={pipeColor} />
      <circle cx={x2} cy={y2} r={pipeWidth / 2 - 1} fill={pipeColor} />
    </svg>
  );
};

PipeFlowRenderer.displayName = 'PipeFlowRenderer';
export default memo(PipeFlowRenderer);
