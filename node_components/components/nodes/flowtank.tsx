import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

// Custom ReactFlow node: 3:1 ratio tank with two vertical pipes centered at the bottom and open top
const RecirculatingFishTank: React.FC<NodeProps> = ({ data }) => {
  const label = data.label || 'Fish Tank (RAS)';
  const width = data.width || 300; // Width is set to 3 units
  const height = data.height || width / 3;  // Height is set to 1 unit
  const pipeHeight = data.pipeHeight || 20;
  const pipeWidth = 11;
  const pipeGap = 13;
  const containerHeight = height + pipeHeight; // Adjusted container height to match the pipes

  return (
    <div style={{ position: 'relative', width, height: containerHeight }}>
      <svg
        width={width}
        height={containerHeight}
        viewBox={`0 0 ${width} ${containerHeight}`}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Tank border with open top (no top border) */}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          rx={15}
          ry={15}
          fill="none"  // No fill for open top
          stroke={data.tankStroke || '#005678'}
          strokeWidth={3}
        />

        {/* Water level at 60% of tank height */}
        <rect
          x={0}
          y={height * 0.4}
          width={width}
          height={height * 0.6}
          fill={data.waterColor || '#4FB3F6'}
          opacity={0.6}
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
          fill={data.pipeColor || '#555'}
          rx={pipeHeight / 2}
        />
        <rect
          x={width * 0.5 + pipeGap / 2}
          y={height}
          width={pipeWidth}
          height={pipeHeight}
          fill={data.pipeColor || '#555'}
          rx={pipeHeight / 2}
        />

        {/* Label at top-left */}
        <text x={10} y={20} fontSize={16} fill="#003366">
          {label}
        </text>
      </svg>

      {/* Handles flush on tank edges */}
      {/*<Handle*/}
      {/*  type="target"*/}
      {/*  position={Position.Left}*/}
      {/*  id="inlet"*/}
      {/*  style={{ top: height * 0.5, left: 0 }}*/}
      {/*/>*/}
      {/*<Handle*/}
      {/*  type="source"*/}
      {/*  position={Position.Right}*/}
      {/*  id="outlet"*/}
      {/*  style={{ top: height * 0.5, left: width }}*/}
      {/*/>*/}

      {/* Source handles at bottom pipes, slightly shifted to the right */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-pipe-left"
        style={{
          left: width * 0.5 - pipeWidth - pipeGap / 2 + 5, // Shifted to the right
          top: height + pipeHeight,
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-pipe-right"

        style={{
          left: width * 0.5 + pipeGap / 2 + 5, // Shifted to the right
          top: height + pipeHeight,
        }}

      />
    </div>
  );
};

export default RecirculatingFishTank;
