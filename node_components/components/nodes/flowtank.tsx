/**
 * FishTankNode (RecirculatingFishTank) Component
 * RAS tank with water level visualization, fish illustration, and toggleable handles
 */

import React, { useState, useEffect } from 'react';
import { Handle, Position, NodeProps, useUpdateNodeInternals, useReactFlow } from 'reactflow';

type HandleType = 'source' | 'target';

interface FishTankNodeData {
  label?: string;
  width?: number;
  height?: number;
  pipeHeight?: number;
  tankStroke?: string;
  waterColor?: string;
  pipeColor?: string;
  inletType?: HandleType;
  outletType?: HandleType;
  pipeLeftType?: HandleType;
  pipeRightType?: HandleType;
}

const FishTankNode: React.FC<NodeProps<FishTankNodeData>> = ({ id, data, selected }) => {
  const label = data?.label || 'Fish Tank (RAS)';
  const width = data?.width || 300;
  const height = data?.height || width / 3;
  const pipeHeight = data?.pipeHeight || 20;
  const pipeWidth = 11;
  const pipeGap = 13;
  const containerHeight = height + pipeHeight;

  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();

  const [inletType, setInletType] = useState<HandleType>(data?.inletType || 'target');
  const [outletType, setOutletType] = useState<HandleType>(data?.outletType || 'source');
  const [pipeLeftType, setPipeLeftType] = useState<HandleType>(data?.pipeLeftType || 'source');
  const [pipeRightType, setPipeRightType] = useState<HandleType>(data?.pipeRightType || 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const toggleHandle = (
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: keyof FishTankNodeData
  ) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const newType: HandleType = current === 'source' ? 'target' : 'source';
    setFunc(newType);
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, [key]: newType } } : node
      )
    );
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inletType, outletType, pipeLeftType, pipeRightType, updateNodeInternals]);

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
        {/* Tank border */}
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
          points={`${width / 2 + width * 0.05},${height / 2} ${width / 2 + width * 0.1},${height / 2 - height * 0.05} ${width / 2 + width * 0.1},${height / 2 + height * 0.05}`}
          fill="#CD5C5C"
        />

        {/* Two vertical pipes under tank */}
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

        {/* Label */}
        <text x={10} y={20} fontSize={16} fill="#003366">
          {label}
        </text>
      </svg>

      {/* Inlet Handle (Left) */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: height * 0.5,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={toggleHandle(inletType, setInletType, 'inletType')}
      >
        <Handle
          id={`tank-inlet-${inletType}`}
          type={inletType}
          position={Position.Left}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(inletType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Outlet Handle (Right) */}
      <div
        style={{
          position: 'absolute',
          left: width,
          top: height * 0.5,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={toggleHandle(outletType, setOutletType, 'outletType')}
      >
        <Handle
          id={`tank-outlet-${outletType}`}
          type={outletType}
          position={Position.Right}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(outletType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Left Pipe Handle */}
      <div
        style={{
          position: 'absolute',
          left: width * 0.5 - pipeWidth - pipeGap / 2 + 5,
          top: height + pipeHeight,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={toggleHandle(pipeLeftType, setPipeLeftType, 'pipeLeftType')}
      >
        <Handle
          id={`source-pipe-left-${pipeLeftType}`}
          type={pipeLeftType}
          position={Position.Bottom}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(pipeLeftType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Right Pipe Handle */}
      <div
        style={{
          position: 'absolute',
          left: width * 0.5 + pipeGap / 2 + 5,
          top: height + pipeHeight,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={toggleHandle(pipeRightType, setPipeRightType, 'pipeRightType')}
      >
        <Handle
          id={`source-pipe-right-${pipeRightType}`}
          type={pipeRightType}
          position={Position.Bottom}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(pipeRightType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>
    </div>
  );
};

export default FishTankNode;
