/**
 * TankInletNode Component
 * Water inlet pipe with distribution holes, rotation support and toggleable handles
 */

import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals, useReactFlow, NodeProps } from 'reactflow';
import { rotatePoint } from '../../utils/rotatePoint';

type HandleType = 'source' | 'target';

interface TankInletNodeData {
  top?: HandleType;
  bottom?: HandleType;
  rotation?: number;
  label?: string;
}

const TankInletNode: React.FC<NodeProps<TankInletNodeData>> = ({ id, data, selected }) => {
  const width = 100;
  const height = 160;
  const rotation = data?.rotation ?? 0;

  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();

  const [top, setTop] = useState<HandleType>(data?.top ?? 'target');
  const [bottom, setBottom] = useState<HandleType>(data?.bottom ?? 'source');

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  const centerX = width / 2;
  const centerY = height / 2;

  // Calculate rotated handle positions
  const topPos = rotatePoint(centerX, centerY, 30, 20, rotation);
  const bottomPos = rotatePoint(centerX, centerY, 30, 140, rotation);

  const updateNodeData = (updates: Partial<TankInletNodeData>) => {
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, ...updates } }
          : node
      )
    );
  };

  const handleTypeChange = (
    e: React.MouseEvent,
    current: HandleType,
    setFunc: React.Dispatch<React.SetStateAction<HandleType>>,
    key: 'top' | 'bottom'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const newVal: HandleType = current === 'source' ? 'target' : 'source';
    setFunc(newVal);
    updateNodeData({ [key]: newVal });
  };

  const rotateNode = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newRotation = ((rotation || 0) + 90) % 360;
    updateNodeData({ rotation: newRotation });
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, top, bottom, rotation, updateNodeInternals]);

  const holeY = [40, 55, 70, 85, 100, 115];

  return (
    <div
      style={{
        width,
        height,
        position: 'relative',
        pointerEvents: 'none',
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      {/* Rotation button */}
      <button
        onClick={rotateNode}
        style={{
          position: 'absolute',
          top: 2,
          right: 2,
          zIndex: 10,
          fontSize: 12,
          cursor: 'pointer',
          background: '#f3f4f6',
          border: '1px solid #d1d5db',
          borderRadius: 4,
          padding: '2px 6px',
          pointerEvents: 'all',
        }}
      >
        ↻
      </button>

      <div
        style={{
          transform: `rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          width,
          height,
          pointerEvents: 'auto',
        }}
      >
        <svg width={width} height={height}>
          {/* Gray vertical pipe */}
          <rect
            x={25}
            y={20}
            width={10}
            height={120}
            fill="#888"
            stroke="#333"
            strokeWidth={1.5}
            rx={3}
          />
          {/* Holes and arrows */}
          {holeY.map((y, i) => (
            <g key={i}>
              <circle cx={30} cy={y} r={1.8} fill="#b3d9ff" />
              <polygon
                points={`${32},${y} ${42},${y - 4} ${42},${y + 4}`}
                fill="#1ca3ec"
                opacity={0.8}
              />
            </g>
          ))}
          <text x={50} y={150} textAnchor="middle" fontSize={10} fill="#000">
            {data?.label || 'Tank Inlet'}
          </text>
        </svg>
      </div>

      {/* Top Handle */}
      <div
        style={{
          position: 'absolute',
          left: topPos.x,
          top: topPos.y,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleTypeChange(e, top, setTop, 'top')}
      >
        <Handle
          id={`tankinlet-top-${top}`}
          type={top}
          position={undefined as any}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(top),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Bottom Handle */}
      <div
        style={{
          position: 'absolute',
          left: bottomPos.x,
          top: bottomPos.y,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleTypeChange(e, bottom, setBottom, 'bottom')}
      >
        <Handle
          id={`tankinlet-bottom-${bottom}`}
          type={bottom}
          position={undefined as any}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(bottom),
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

export default TankInletNode;
