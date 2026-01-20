/**
 * FishTankNode Component
 * RAS (Recirculating Aquaculture System) fish tank with water level visualization
 */

import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

interface FishTankNodeData {
  label?: string;
  width?: number;
  height?: number;
  pipeHeight?: number;
  tankStroke?: string;
  waterColor?: string;
  pipeColor?: string;
}

const FishTankNode: React.FC<NodeProps<FishTankNodeData>> = ({ data, selected }) => {
  const label = data?.label || 'Fish Tank (RAS)';
  const width = data?.width || 300;
  const height = data?.height || width / 3;
  const pipeHeight = data?.pipeHeight || 20;
  const pipeWidth = 11;
  const pipeGap = 13;
  const containerHeight = height + pipeHeight;

  return (
    <div
      style={{
        position: 'relative',
        width,
        height: containerHeight,
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      <svg
        width={width}
        height={containerHeight}
        viewBox={`0 0 ${width} ${containerHeight}`}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Tank border with rounded corners */}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          rx={15}
          ry={15}
          fill="none"
          stroke={data?.tankStroke || '#005678'}
          strokeWidth={3}
        />

        {/* Water level at 60% of tank height */}
        <rect
          x={0}
          y={height * 0.4}
          width={width}
          height={height * 0.6}
          fill={data?.waterColor || '#4FB3F6'}
          opacity={0.6}
          rx={15}
          ry={15}
        />

        {/* Fish illustration */}
        <ellipse
          cx={width / 2}
          cy={height / 2}
          rx={width * 0.05}
          ry={height * 0.07}
          fill="#FFA07A"
          stroke="#CD5C5C"
          strokeWidth={2}
        />
        <polygon
          points={`${width / 2 + width * 0.05},${height / 2} ${
            width / 2 + width * 0.1
          },${height / 2 - height * 0.05} ${
            width / 2 + width * 0.1
          },${height / 2 + height * 0.05}`}
          fill="#CD5C5C"
        />

        {/* Two vertical pipes under tank, centered */}
        <rect
          x={width * 0.5 - pipeWidth - pipeGap / 2}
          y={height}
          width={pipeWidth}
          height={pipeHeight}
          fill={data?.pipeColor || '#555'}
          rx={pipeHeight / 2}
        />
        <rect
          x={width * 0.5 + pipeGap / 2}
          y={height}
          width={pipeWidth}
          height={pipeHeight}
          fill={data?.pipeColor || '#555'}
          rx={pipeHeight / 2}
        />

        {/* Label at top-left */}
        <text x={10} y={20} fontSize={16} fill="#003366">
          {label}
        </text>
      </svg>

      {/* Inlet handle - left side */}
      <Handle
        type="target"
        position={Position.Left}
        id="inlet"
        style={{
          top: height * 0.5,
          left: 0,
          width: 12,
          height: 12,
          background: '#3b82f6',
          border: '2px solid white',
          borderRadius: '50%',
        }}
      />

      {/* Outlet handle - right side */}
      <Handle
        type="source"
        position={Position.Right}
        id="outlet"
        style={{
          top: height * 0.5,
          right: 0,
          left: 'auto',
          width: 12,
          height: 12,
          background: '#22c55e',
          border: '2px solid white',
          borderRadius: '50%',
        }}
      />

      {/* Source handles at bottom pipes */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-pipe-left"
        style={{
          left: width * 0.5 - pipeWidth - pipeGap / 2 + 5,
          top: height + pipeHeight,
          width: 10,
          height: 10,
          background: '#22c55e',
          border: '2px solid white',
          borderRadius: '50%',
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-pipe-right"
        style={{
          left: width * 0.5 + pipeGap / 2 + 5,
          top: height + pipeHeight,
          width: 10,
          height: 10,
          background: '#22c55e',
          border: '2px solid white',
          borderRadius: '50%',
        }}
      />
    </div>
  );
};

export default FishTankNode;
