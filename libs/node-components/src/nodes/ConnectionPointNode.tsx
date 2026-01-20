/**
 * ConnectionPointNode (Cp) Component
 * Small connection point with 4 toggleable handles (top, bottom, left, right)
 */

import React, { useState, useEffect } from 'react';
import { Handle, useUpdateNodeInternals, useReactFlow, NodeProps } from 'reactflow';
import { NodeRegistry } from '../registry/NodeRegistry';

type HandleType = 'source' | 'target';

interface ConnectionPointNodeData {
  topType?: HandleType;
  bottomType?: HandleType;
  leftType?: HandleType;
  rightType?: HandleType;
  fillColor?: string;
  strokeColor?: string;
  label?: string;
  isScadaMode?: boolean;
}

const WIDTH = 30;
const HEIGHT = 30;

const ConnectionPointNode: React.FC<NodeProps<ConnectionPointNodeData>> = ({ id, data, selected }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();
  const isScadaMode = data?.isScadaMode || false;

  const [topType, setTopType] = useState<HandleType>(data?.topType || 'target');
  const [bottomType, setBottomType] = useState<HandleType>(data?.bottomType || 'source');
  const [leftType, setLeftType] = useState<HandleType>(data?.leftType || 'target');
  const [rightType, setRightType] = useState<HandleType>(data?.rightType || 'source');

  const toggleType = (current: HandleType): HandleType => (current === 'source' ? 'target' : 'source');

  const updateType = (side: 'top' | 'bottom' | 'left' | 'right') => {
    if (isScadaMode) return;

    const currentType = { top: topType, bottom: bottomType, left: leftType, right: rightType }[side];
    const newType = toggleType(currentType);

    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, [`${side}Type`]: newType } }
          : node
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

  const getColor = (type: HandleType) => type === 'source' ? '#22c55e' : '#3b82f6';

  return (
    <div
      style={{
        position: 'relative',
        width: WIDTH,
        height: HEIGHT,
        border: selected ? '2px solid #3b82f6' : '2px solid transparent',
        borderRadius: '50%',
      }}
    >
      <svg width={WIDTH} height={HEIGHT}>
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
      <div
        style={{
          position: 'absolute',
          left: 15,
          top: 3,
          width: 10,
          height: 10,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          updateType('top');
        }}
      >
        <Handle
          id={`cp-top-${topType}`}
          type={topType}
          position={undefined as any}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(topType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
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
          left: 15,
          top: 27,
          width: 10,
          height: 10,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          updateType('bottom');
        }}
      >
        <Handle
          id={`cp-bottom-${bottomType}`}
          type={bottomType}
          position={undefined as any}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(bottomType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>

      {/* Left Handle */}
      <div
        style={{
          position: 'absolute',
          left: 3,
          top: 15,
          width: 10,
          height: 10,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          updateType('left');
        }}
      >
        <Handle
          id={`cp-left-${leftType}`}
          type={leftType}
          position={undefined as any}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(leftType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
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
          left: 27,
          top: 15,
          width: 10,
          height: 10,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'all',
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          updateType('right');
        }}
      >
        <Handle
          id={`cp-right-${rightType}`}
          type={rightType}
          position={undefined as any}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            background: getColor(rightType),
            borderRadius: '50%',
            border: '2px solid white',
            cursor: isScadaMode ? 'default' : 'pointer',
            transform: 'none',
            left: 0,
            top: 0,
          }}
        />
      </div>
    </div>
  );
};

// Auto-register
NodeRegistry.register({
  id: 'connectionPoint',
  label: 'Connection Point',
  labelTr: 'Baglanti Noktasi',
  category: 'utility',
  description: '4-way junction for connecting pipes',
  component: ConnectionPointNode,
  defaultSize: { width: WIDTH, height: HEIGHT },
  equipmentTypeCodes: ['connection_point', 'cp', 'junction'],
});

export default ConnectionPointNode;
