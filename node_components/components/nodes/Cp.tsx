import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals } from 'reactflow';

interface CPProps {
  id: string;
  data: {
    topType?: 'source' | 'target';
    bottomType?: 'source' | 'target';
    leftType?: 'source' | 'target';
    rightType?: 'source' | 'target';
    fillColor?: string;
    strokeColor?: string;
  };
  setNodes: React.Dispatch<React.SetStateAction<any[]>>;
}

const CP: React.FC<CPProps> & {
  defaultHandles: {
    topType: 'source' | 'target';
    bottomType: 'source' | 'target';
    leftType: 'source' | 'target';
    rightType: 'source' | 'target';
  };
} = ({ id, data, setNodes }) => {
  const updateNodeInternals = useUpdateNodeInternals();

  const [topType, setTopType] = useState(data?.topType || CP.defaultHandles.topType);
  const [bottomType, setBottomType] = useState(data?.bottomType || CP.defaultHandles.bottomType);
  const [leftType, setLeftType] = useState(data?.leftType || CP.defaultHandles.leftType);
  const [rightType, setRightType] = useState(data?.rightType || CP.defaultHandles.rightType);

  const toggleType = (current: 'source' | 'target') => (current === 'source' ? 'target' : 'source');

  const updateType = (side: 'top' | 'bottom' | 'left' | 'right') => {
    const currentType = { top: topType, bottom: bottomType, left: leftType, right: rightType }[side];
    const newType = toggleType(currentType);

    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, [`${side}Type`]: newType } } : node
      )
    );

    if (side === 'top') setTopType(newType);
    else if (side === 'bottom') setBottomType(newType);
    else if (side === 'left') setLeftType(newType);
    else if (side === 'right') setRightType(newType);
  };

  useEffect(() => {
    updateNodeInternals(id);
  }, [topType, bottomType, leftType, rightType, id, updateNodeInternals]);

  return (
    <div style={{ position: 'relative', width: 30, height: 30 }}>
      <svg width="30" height="30">
        <circle
          cx="15"
          cy="15"
          r="12"
          fill={data?.fillColor || '#ffcc00'}
          stroke={data?.strokeColor || '#333'}
          strokeWidth="2"
        />
      </svg>

      {/* Top Handle */}
      <Handle
        id={`cp-top-${topType}`}
        type={topType}
        onContextMenu={(e) => {
          e.preventDefault();
          updateType('top');
        }}
        style={{
          position: 'absolute',
          left: 15,
          top: 3,
          width: 8,
          height: 8,
          background: topType === 'source' ? 'red' : 'blue',
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          cursor: 'pointer',
          pointerEvents: 'all',
        }}
      />

      {/* Bottom Handle */}
      <Handle
        id={`cp-bottom-${bottomType}`}
        type={bottomType}
        onContextMenu={(e) => {
          e.preventDefault();
          updateType('bottom');
        }}
        style={{
          position: 'absolute',
          left: 15,
          top: 27,
          width: 8,
          height: 8,
          background: bottomType === 'source' ? 'red' : 'blue',
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          cursor: 'pointer',
          pointerEvents: 'all',
        }}
      />

      {/* Left Handle */}
      <Handle
        id={`cp-left-${leftType}`}
        type={leftType}
        onContextMenu={(e) => {
          e.preventDefault();
          updateType('left');
        }}
        style={{
          position: 'absolute',
          left: 3,
          top: 15,
          width: 8,
          height: 8,
          background: leftType === 'source' ? 'red' : 'blue',
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          cursor: 'pointer',
          pointerEvents: 'all',
        }}
      />

      {/* Right Handle */}
      <Handle
        id={`cp-right-${rightType}`}
        type={rightType}
        onContextMenu={(e) => {
          e.preventDefault();
          updateType('right');
        }}
        style={{
          position: 'absolute',
          left: 27,
          top: 15,
          width: 8,
          height: 8,
          background: rightType === 'source' ? 'red' : 'blue',
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          cursor: 'pointer',
          pointerEvents: 'all',
        }}
      />
    </div>
  );
};

CP.defaultHandles = {
  topType: 'source',
  bottomType: 'target',
  leftType: 'source',
  rightType: 'target',
};

export default CP;
