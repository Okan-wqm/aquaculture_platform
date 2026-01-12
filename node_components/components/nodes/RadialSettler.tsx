import React, { useEffect, useState } from 'react';
import { Handle, useUpdateNodeInternals } from 'reactflow';

interface RadialSettlerProps {
  id: string;
  data: {
    label?: string;
    leftType?: 'source' | 'target';
    rightType?: 'source' | 'target';
    bottomType?: 'source' | 'target';
  };
  setNodes: React.Dispatch<React.SetStateAction<any[]>>;
}

const RadialSettler: React.FC<RadialSettlerProps> & {
  defaultHandles: {
    leftType: 'source' | 'target';
    rightType: 'source' | 'target';
    bottomType: 'source' | 'target';
  };
} = ({ id, data, setNodes }) => {
  const width = 120;
  const height = 160;

  const updateNodeInternals = useUpdateNodeInternals();

  const [leftType, setLeftType] = useState(data?.leftType || RadialSettler.defaultHandles.leftType);
  const [rightType, setRightType] = useState(data?.rightType || RadialSettler.defaultHandles.rightType);
  const [bottomType, setBottomType] = useState(data?.bottomType || RadialSettler.defaultHandles.bottomType);

  const leftColor = leftType === 'source' ? 'red' : 'blue';
  const rightColor = rightType === 'source' ? 'red' : 'blue';
  const bottomColor = bottomType === 'source' ? 'red' : 'blue';

  const toggleType = (type: 'source' | 'target') => (type === 'source' ? 'target' : 'source');

  const handleRightClick = (
    e: React.MouseEvent,
    side: 'left' | 'right' | 'bottom'
  ) => {
    e.preventDefault();
    const newVal =
      side === 'left'
        ? toggleType(leftType)
        : side === 'right'
        ? toggleType(rightType)
        : toggleType(bottomType);

    setNodes((prev) =>
      prev.map((node) =>
        node.id === id
          ? {
              ...node,
              data: {
                ...node.data,
                [`${side}Type`]: newVal,
              },
            }
          : node
      )
    );

    if (side === 'left') setLeftType(newVal);
    if (side === 'right') setRightType(newVal);
    if (side === 'bottom') setBottomType(newVal);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [leftType, rightType, bottomType, id, updateNodeInternals]);

  return (
    <div style={{ width, height, position: 'relative', pointerEvents: 'none' }}>
      <svg width={width} height={height} style={{ pointerEvents: 'auto' }}>
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

      {/* Handles */}
      <Handle
        id={`radial-left-${leftType}`}
        type={leftType}
        onContextMenu={(e) => handleRightClick(e, 'left')}
        style={{
          position: 'absolute',
          left: 10,
          top: 60,
          width: 10,
          height: 10,
          background: leftColor,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          cursor: 'pointer',
          pointerEvents: 'all',
        }}
      />

      <Handle
        id={`radial-right-${rightType}`}
        type={rightType}
        onContextMenu={(e) => handleRightClick(e, 'right')}
        style={{
          position: 'absolute',
          left: 110,
          top: 60,
          width: 10,
          height: 10,
          background: rightColor,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          cursor: 'pointer',
          pointerEvents: 'all',
        }}
      />

      <Handle
        id={`radial-bottom-${bottomType}`}
        type={bottomType}
        onContextMenu={(e) => handleRightClick(e, 'bottom')}
        style={{
          position: 'absolute',
          left: 60,
          top: 160,
          width: 10,
          height: 10,
          background: bottomColor,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          cursor: 'pointer',
          pointerEvents: 'all',
        }}
      />
    </div>
  );
};

RadialSettler.defaultHandles = {
  leftType: 'source',
  rightType: 'source',
  bottomType: 'target',
};

export default RadialSettler;
