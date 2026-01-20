/**
 * RadialSettlerNode Component
 * Conical settling tank with 3 toggleable handles
 */

import React, { useEffect, useState } from 'react';
import { Handle, useUpdateNodeInternals, NodeProps } from 'reactflow';
import { useProcessStore } from '../../../store/processStore';

type HandleType = 'source' | 'target';

interface RadialSettlerNodeData {
  label?: string;
  leftType?: HandleType;
  rightType?: HandleType;
  bottomType?: HandleType;
}

const WIDTH = 120;
const HEIGHT = 160;

const RadialSettlerNode: React.FC<NodeProps<RadialSettlerNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const updateNodeData = useProcessStore((state) => state.updateNodeData);

  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'target');
  const [bottomType, setBottomType] = useState<HandleType>(data?.bottomType || 'source');

  const leftColor = leftType === 'source' ? '#22c55e' : '#3b82f6';
  const rightColor = rightType === 'source' ? '#22c55e' : '#3b82f6';
  const bottomColor = bottomType === 'source' ? '#22c55e' : '#3b82f6';

  const toggleType = (type: HandleType): HandleType => (type === 'source' ? 'target' : 'source');

  const handleRightClick = (
    e: React.MouseEvent,
    side: 'left' | 'right' | 'bottom'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const currentType = { left: leftType, right: rightType, bottom: bottomType }[side];
    const newVal = toggleType(currentType);

    updateNodeData(id, { [`${side}Type`]: newVal } as any);

    if (side === 'left') setLeftType(newVal);
    if (side === 'right') setRightType(newVal);
    if (side === 'bottom') setBottomType(newVal);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [leftType, rightType, bottomType, id, updateNodeInternals]);

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        position: 'relative',
        pointerEvents: 'none',
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: 8,
      }}
    >
      <svg width={WIDTH} height={HEIGHT} style={{ pointerEvents: 'auto' }}>
        {/* Tank Body */}
        <rect x="20" y="40" width="80" height="80" fill="#8e7c66" opacity="0.8" />
        {/* Settling Cone */}
        <polygon points="20,120 60,160 100,120" fill="#8e7c66" opacity="0.8" />
        {/* Top Ring */}
        <ellipse cx="60" cy="20" rx="40" ry="10" fill="#bbb" stroke="#333" strokeWidth="2" />
        <line x1="20" y1="20" x2="20" y2="120" stroke="#333" strokeWidth="2" />
        <line x1="100" y1="20" x2="100" y2="120" stroke="#333" strokeWidth="2" />
        {/* Cone Highlight */}
        <polygon points="20,120 60,160 100,120" fill="#bbb" stroke="#333" strokeWidth="2" />
        {/* Left/Right Pipe Decorations */}
        <rect x="0" y="50" width="20" height="20" fill="#888" stroke="#333" strokeWidth="2" />
        <rect x="100" y="50" width="20" height="20" fill="#888" stroke="#333" strokeWidth="2" />
        {/* X icons */}
        <line x1="0" y1="50" x2="20" y2="70" stroke="#fff" strokeWidth="2" />
        <line x1="0" y1="70" x2="20" y2="50" stroke="#fff" strokeWidth="2" />
        <line x1="100" y1="50" x2="120" y2="70" stroke="#fff" strokeWidth="2" />
        <line x1="100" y1="70" x2="120" y2="50" stroke="#fff" strokeWidth="2" />
        {/* Label */}
        <text x="60" y="90" fill="#000" textAnchor="middle" fontSize="12">
          {data?.label || 'Radial Settler'}
        </text>
      </svg>

      {/* Left Handle */}
      <div
        style={{
          position: 'absolute',
          left: 10,
          top: 60,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleRightClick(e, 'left')}
      >
        <Handle
          id="radial-left"
          type={leftType}
          position={undefined as any}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: leftColor,
            borderRadius: '50%',
            border: '2px solid white',
            cursor: 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Right Handle */}
      <div
        style={{
          position: 'absolute',
          left: 110,
          top: 60,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleRightClick(e, 'right')}
      >
        <Handle
          id="radial-right"
          type={rightType}
          position={undefined as any}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: rightColor,
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
          left: 60,
          top: 160,
          width: 12,
          height: 12,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => handleRightClick(e, 'bottom')}
      >
        <Handle
          id="radial-bottom"
          type={bottomType}
          position={undefined as any}
          isConnectable={true}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: bottomColor,
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

export default RadialSettlerNode;
